import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { conectar, lerMigracoes } from '../../nuvem/migrar.ts'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { criarContaFicticia } from '../../ferramentas/conta-ficticia.ts'
import { BancoLocal } from '../../src/dados/banco.ts'
import { MODELOS_ORIGINAIS } from '../../src/dados/modelos-whatsapp.ts'
import { criarRepositorioModelos } from '../../src/dados/repositorio-modelos.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { criarNuvemSupabase, type Nuvem } from '../../src/sincronizacao/nuvem.ts'
import { iniciarSincronizacao } from '../../src/sincronizacao/sincronizacao.ts'
import { modelosParaNuvem } from '../../src/sincronizacao/borda-modelos.ts'
import { criarServicoCopia } from '../../src/sincronizacao/copia.ts'
import { pacoteSemModelos } from '../apoio-modelos.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
const AGORA = '2026-10-25T12:00:00.000Z', DEPOIS = '2026-10-25T12:01:00.000Z'
let sql: SQL
const bancos: BancoLocal[] = [], clientes: SupabaseClient[] = []
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { for (const b of bancos) b.close(); for (const c of clientes) await c.auth.signOut(); if (LIGADA) await sql.close() })
function aparelho() { const b = new BancoLocal(uuidv7(), { indexedDB: new IDBFactory(), IDBKeyRange }); bancos.push(b); return b }
async function ambiente() {
  const email = await criarContaFicticia(), url = process.env.VITE_SUPABASE_URL ?? ''
  const cliente = createClient(url, process.env.VITE_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } }); clientes.push(cliente)
  const { error } = await cliente.auth.signInWithPassword({ email, password: process.env.SUPABASE_TESTE_SENHA ?? '' })
  if (error) throw error
  return { cliente, nuvem: criarNuvemSupabase(cliente, url) }
}
async function ciclo(banco: BancoLocal, nuvem: Nuvem) {
  const m = iniciarSincronizacao({ banco, nuvem: { ...nuvem, aoMudarSessao: () => () => undefined }, janela: null, documento: null, agendar: () => () => undefined })
  await m.sincronizar(); const estado = m.estado(); m.parar(); return estado
}
class Revertida extends Error {}
async function transacao(fn: (tx: TransactionSQL) => Promise<void>): Promise<void> {
  try { await sql.begin(async (tx) => {
    if (process.env.MUTACAO_MODELOS) await tx.unsafe(process.env.MUTACAO_MODELOS)
    await fn(tx); throw new Revertida()
  }) } catch (e) { if (!(e instanceof Revertida)) throw e }
}
async function assumir(tx: SQL, dono: string): Promise<void> {
  await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: dono, role: 'authenticated' })},true)`
  await tx.unsafe('set local role authenticated')
}
async function recusa(tx: TransactionSQL, fn: (sp: SQL) => Promise<unknown>, codigo: string) {
  let erro: unknown
  try { await tx.savepoint(fn) } catch (e) { erro = e }
  expect(erro).toBeInstanceOf(SQL.PostgresError)
  if (erro instanceof SQL.PostgresError) expect(erro.errno ?? erro.code).toBe(codigo)
}

describe.skipIf(!LIGADA)('E-36: Postgres, transporte e restauração reais no destino de teste', () => {
  test('SQL direto recusa texto vazio/inválido, forma incompleta, id do servidor e coluna privilegiada', async () => {
    await transacao(async (tx) => {
      await assumir(tx, uuidv7())
      const id = uuidv7()
      for (const modelos of [{}, { ...MODELOS_ORIGINAIS, 'cobranca-vencida': ' \n\t' },
        { ...MODELOS_ORIGINAIS, 'cobranca-a-vencer': '{saldo}' }, { ...MODELOS_ORIGINAIS, 'recibo-com-saldo': '{vencimento}' },
        { ...MODELOS_ORIGINAIS, 'recibo-quitado': '{nome' }, { ...MODELOS_ORIGINAIS, extra: 'Mensagem' }]) {
        await recusa(tx, (sp) => sp`insert into public.modelos_whatsapp (chave,id,modelos,atualizado_em) values ('whatsapp',${id},${modelos}::jsonb,${AGORA})`, '23514')
      }
      await recusa(tx, (sp) => sp`insert into public.modelos_whatsapp (chave,modelos,atualizado_em) values ('whatsapp',${MODELOS_ORIGINAIS}::jsonb,${AGORA})`, '23502')
      await recusa(tx, (sp) => sp`insert into public.modelos_whatsapp (chave,id,modelos,atualizado_em,recebido_em) values ('whatsapp',${id},${MODELOS_ORIGINAIS}::jsonb,${AGORA},${AGORA})`, '42501')
      expect((await tx`select * from public.modelos_whatsapp`).length).toBe(0)
    })
  })
  test('isolamento/RLS/ACL e LWW inteiro, inclusive empate, não permitem apagar ou mudar dono', async () => {
    await transacao(async (tx) => {
      const dono = uuidv7(), id = uuidv7(); await assumir(tx, dono)
      await tx`insert into public.modelos_whatsapp (chave,id,modelos,atualizado_em) values ('whatsapp',${id},${MODELOS_ORIGINAIS}::jsonb,${DEPOIS})`
      const outro = { ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Texto anterior' }
      await tx`update public.modelos_whatsapp set modelos=${outro}::jsonb, atualizado_em=${AGORA}`
      expect((await tx<{ modelos: unknown }[]>`select modelos from public.modelos_whatsapp`)[0]?.modelos).toEqual(MODELOS_ORIGINAIS)
      await tx`update public.modelos_whatsapp set modelos=${outro}::jsonb, atualizado_em=${DEPOIS}`
      expect((await tx<{ modelos: unknown }[]>`select modelos from public.modelos_whatsapp`)[0]?.modelos).toEqual(outro)
      await recusa(tx, (sp) => sp`delete from public.modelos_whatsapp`, '42501')
      await recusa(tx, (sp) => sp`update public.modelos_whatsapp set dono=${uuidv7()}`, '42501')
      await assumir(tx, uuidv7()); expect((await tx`select * from public.modelos_whatsapp`).length).toBe(0)
      await tx.unsafe('set local role anon')
      await recusa(tx, (sp) => sp`select * from public.modelos_whatsapp`, '42501')
    })
  })
  test('reversão protegida e par vazio em schema transacional preservam os dados existentes', async () => {
    const migracoes = await lerMigracoes(), m = migracoes.find((m) => m.nome === '0009_modelos-whatsapp')
    if (!m) throw new Error('Sem migration 0009')
    await transacao(async (tx) => {
      const nome = `modelos_e36_${uuidv7().replaceAll('-', '')}`
      await tx.unsafe(`create schema ${nome}`)
      const aplicar = m.aplicar.replaceAll('public.', `${nome}.`), reverter = m.reverter.replaceAll('public.', `${nome}.`)
      await tx.unsafe(aplicar); await tx.unsafe(reverter); await tx.unsafe(aplicar)
      await tx.unsafe(`insert into ${nome}.modelos_whatsapp (dono,chave,id,modelos,atualizado_em) values ('${uuidv7()}','whatsapp','${uuidv7()}', '${JSON.stringify(MODELOS_ORIGINAIS)}'::jsonb,'${AGORA}')`)
      await recusa(tx, (sp) => sp.unsafe(reverter), '23514')
      expect((await tx.unsafe(`select * from ${nome}.modelos_whatsapp`)).length).toBe(1)
    })
  })
  test('resposta perdida e edição em trânsito conservam a fila; base vazia restaura os quatro textos', async () => {
    const { nuvem } = await ambiente(), a = aparelho(), r = criarRepositorioModelos(a, () => AGORA)
    const salvo = await r.salvar(MODELOS_ORIGINAIS, undefined); if (!salvo.ok) throw new Error('sem preferência')
    let primeira = true
    expect((await ciclo(a, { ...nuvem, enviarModelos: async (linha) => {
      const resposta = await nuvem.enviarModelos(linha)
      if (primeira) { primeira = false; await r.salvar({ ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Recebimento conferido' }, salvo.preferencia)
        return { ok: false, falha: { tipo: 'rede', mensagem: 'resposta perdida após commit' } } }
      return resposta
    } })).ultimaFalha).toBe('rede')
    expect(await a.fila.count()).toBe(1)
    expect((await ciclo(a, nuvem)).ultimaFalha).toBeNull(); expect(await a.fila.count()).toBe(0)
    const b = aparelho(); expect((await ciclo(b, nuvem)).ultimaFalha).toBeNull()
    expect(await b.modelos.toArray()).toEqual(await a.modelos.toArray())
    expect((await b.modelos.get('whatsapp'))?.modelos['recibo-quitado']).toBe('Recebimento conferido')
  }, 120_000)
  test('duas primeiras edições independentes convergem pelo relógio e empate do servidor', async () => {
    const { nuvem } = await ambiente(), a = aparelho(), b = aparelho()
    await criarRepositorioModelos(a, () => DEPOIS).salvar({ ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Mais novo' }, undefined)
    await criarRepositorioModelos(b, () => AGORA).salvar({ ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Mais velho' }, undefined)
    expect((await ciclo(a, nuvem)).ultimaFalha).toBeNull(); expect((await ciclo(b, nuvem)).ultimaFalha).toBeNull()
    expect(await b.modelos.toArray()).toEqual(await a.modelos.toArray()); expect(await b.fila.count()).toBe(0)
    const local = await criarRepositorioModelos(b).ler()
    await criarRepositorioModelos(b, () => DEPOIS).salvar({ ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Empate aceito' }, local)
    expect((await ciclo(b, nuvem)).ultimaFalha).toBeNull(); expect((await ciclo(a, nuvem)).ultimaFalha).toBeNull()
    expect(await a.modelos.toArray()).toEqual(await b.modelos.toArray())
  }, 120_000)
  test('pacote anterior e pacote com pendência antiga reconciliam preferência remota sem reenviar', async () => {
    const { nuvem } = await ambiente(), a = aparelho(); await ciclo(a, nuvem)
    const antigo = await pacoteSemModelos((await criarServicoCopia(a, nuvem).exportar()).arquivo, true)
    const r = criarRepositorioModelos(a, () => AGORA)
    const p = await r.salvar(MODELOS_ORIGINAIS, undefined); if (!p.ok) throw new Error('sem preferência')
    const pendente = await criarServicoCopia(a, nuvem).exportar()
    await nuvem.enviarModelos(modelosParaNuvem({ ...p.preferencia, atualizadoEm: DEPOIS, modelos: { ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Atual na nuvem' } }))
    for (const arquivo of [antigo, pendente.arquivo]) {
      const b = aparelho(), servico = criarServicoCopia(b, nuvem)
      await servico.importar(arquivo, await servico.reservarImportacao())
      let envios = 0
      expect((await ciclo(b, { ...nuvem, enviarModelos: async (doc) => { envios++; return nuvem.enviarModelos(doc) } })).ultimaFalha).toBeNull()
      expect(envios).toBe(0); expect(await b.fila.count()).toBe(0)
      expect((await b.modelos.get('whatsapp'))?.modelos['recibo-quitado']).toBe('Atual na nuvem')
    }
  }, 120_000)
})
