import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { createClient } from '@supabase/supabase-js'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { criarContaFicticia } from '../../ferramentas/conta-ficticia.ts'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar } from '../../nuvem/migrar.ts'
import { BancoLocal } from '../../src/dados/banco.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { criarRepositorioPrazoEncalhe } from '../../src/dados/repositorio-prazo-encalhe.ts'
import { criarServicoCopia } from '../../src/sincronizacao/copia.ts'
import { criarNuvemSupabase, type Nuvem } from '../../src/sincronizacao/nuvem.ts'
import { iniciarSincronizacao } from '../../src/sincronizacao/sincronizacao.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
const AGORA = '2026-11-20T12:00:00.000Z', DEPOIS = '2026-11-20T12:01:00.000Z'
let sql: SQL
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })

class Revertida extends Error {}
async function transacao(fn: (tx: TransactionSQL) => Promise<void>): Promise<void> {
  try { await sql.begin(async (tx) => { await fn(tx); throw new Revertida() }) }
  catch (e) { if (!(e instanceof Revertida)) throw e }
}

async function assumir(tx: SQL, dono: string): Promise<void> {
  await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: dono, role: 'authenticated' })},true)`
  await tx.unsafe('set local role authenticated')
}

async function recusar(tx: TransactionSQL, fn: (sp: SQL) => Promise<unknown>, codigo: string) {
  await expect(tx.savepoint(fn)).rejects.toHaveProperty('errno', codigo)
}

async function ciclo(banco: BancoLocal, nuvem: Nuvem) {
  const m = iniciarSincronizacao({ banco, nuvem: { ...nuvem, aoMudarSessao: () => () => undefined }, janela: null, documento: null, agendar: () => () => undefined })
  try { await m.sincronizar(); return m.estado() } finally { m.parar() }
}

describe.skipIf(!LIGADA)('E-42: prazo por conta no destino de teste', () => {
  test('Postgres mantém uma escolha inteira por conta e recusa acesso cruzado e dias inválidos', () => transacao(async (tx) => {
    const dono = uuidv7(), id = uuidv7(), segundo = uuidv7()
    await assumir(tx, dono)
    for (const dias of ['-1', '1.5', '9007199254740992']) {
      await recusar(tx, (sp) => sp`select public.salvar_prazo_encalhe(${id}::uuid,${dias}::numeric,${AGORA}::timestamptz)`, '23514')
    }
    await recusar(tx, (sp) => sp`insert into public.prazos_encalhe (dias,atualizado_em) values (10,${AGORA})`, '23502')
    await tx`select public.salvar_prazo_encalhe(${id}::uuid,0,${DEPOIS}::timestamptz)`
    await tx`select public.salvar_prazo_encalhe(${id}::uuid,0,${DEPOIS}::timestamptz)`
    await tx`select public.salvar_prazo_encalhe(${segundo}::uuid,60,${AGORA}::timestamptz)`
    expect(await tx<{ id: string; dias: string }[]>`select id, dias::text from public.prazos_encalhe`).toEqual([{ id, dias: '0' }])
    await tx`select public.salvar_prazo_encalhe(${segundo}::uuid,9007199254740991,${DEPOIS}::timestamptz)`
    expect(await tx<{ id: string; dias: string }[]>`select id, dias::text from public.prazos_encalhe`).toEqual([{ id: segundo, dias: '9007199254740991' }])
    await recusar(tx, (sp) => sp`delete from public.prazos_encalhe`, '42501')
    await recusar(tx, (sp) => sp`update public.prazos_encalhe set dono=${uuidv7()}`, '42501')
    await assumir(tx, uuidv7())
    expect(await tx`select id from public.prazos_encalhe`).toHaveLength(0)
    expect(await tx`update public.prazos_encalhe set dias=80 returning id`).toHaveLength(0)
    await tx.unsafe('set local role anon')
    await recusar(tx, (sp) => sp`select public.salvar_prazo_encalhe(${id}::uuid,30,${DEPOIS}::timestamptz)`, '42501')
    await recusar(tx, (sp) => sp`select id from public.prazos_encalhe`, '42501')
  }))

  test('reenvio após resposta perdida, edição em trânsito, segundo aparelho e restauração', async () => {
    const url = process.env.VITE_SUPABASE_URL ?? '', email = await criarContaFicticia()
    const cliente = createClient(url, process.env.VITE_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
    const { error } = await cliente.auth.signInWithPassword({ email, password: process.env.SUPABASE_TESTE_SENHA ?? '' })
    if (error) throw error
    const nuvem = criarNuvemSupabase(cliente, url), porta = nuvem.prazoEncalhe
    if (!porta) throw new Error('Transporte ausente')
    const [a, b, restaurado, antigo] = Array.from({ length: 4 }, () => new BancoLocal(uuidv7(), { indexedDB: new IDBFactory(), IDBKeyRange }))
    if (!a || !b || !restaurado || !antigo) throw new Error('Bases de teste ausentes')
    try {
      const r = criarRepositorioPrazoEncalhe(a, () => AGORA), servico = criarServicoCopia(a, nuvem)
      expect((await ciclo(a, nuvem)).ultimaFalha).toBeNull()
      const anterior = await servico.exportar()
      const primeira = await r.salvar(45, undefined)
      if (!primeira.ok) throw new Error('Prazo não salvo')
      expect((await ciclo(a, { ...nuvem, prazoEncalhe: { ...porta, enviar: async (linha) => {
        expect(await porta.enviar(linha)).toMatchObject({ ok: true })
        return { ok: false, falha: { tipo: 'rede', mensagem: 'Resposta perdida após commit' } }
      } } })).ultimaFalha).toBe('rede')
      expect(await a.fila.count()).toBe(1)
      expect((await ciclo(a, { ...nuvem, prazoEncalhe: { ...porta, enviar: async (linha) => {
        expect(await porta.enviar(linha)).toMatchObject({ ok: true })
        expect(await criarRepositorioPrazoEncalhe(a, () => DEPOIS).salvar(60, primeira.preferencia)).toMatchObject({ ok: true })
        return { ok: true, valor: undefined }
      } } })).ultimaFalha).toBeNull()
      expect(await a.fila.count()).toBe(1)
      const pendente = await servico.exportar()
      const nova = criarServicoCopia(restaurado, nuvem)
      await nova.importar(pendente.arquivo, await nova.reservarImportacao())
      expect((await criarRepositorioPrazoEncalhe(restaurado).ler())?.dias).toBe(60)
      expect(await restaurado.fila.count()).toBe(1)
      expect((await ciclo(restaurado, nuvem)).ultimaFalha).toBeNull()
      expect(await restaurado.fila.count()).toBe(0)
      expect((await ciclo(a, nuvem)).ultimaFalha).toBeNull()
      expect(await a.fila.count()).toBe(0)
      expect((await ciclo(b, nuvem)).ultimaFalha).toBeNull()
      expect(await criarRepositorioPrazoEncalhe(b).ler()).toEqual(await r.ler())
      expect(await r.ler()).toMatchObject({ dias: 60 })
      expect(await criarRepositorioPrazoEncalhe(restaurado).ler()).toEqual(await r.ler())
      const copiaAntiga = criarServicoCopia(antigo, nuvem)
      await copiaAntiga.importar(anterior.arquivo, await copiaAntiga.reservarImportacao())
      expect(await criarRepositorioPrazoEncalhe(antigo).ler()).toBeUndefined()
      expect(await antigo.fila.count()).toBe(0)
      expect((await ciclo(antigo, nuvem)).ultimaFalha).toBeNull()
      expect(await antigo.fila.count()).toBe(0)
      expect(await criarRepositorioPrazoEncalhe(antigo).ler()).toEqual(await r.ler())
    } finally {
      for (const banco of [a, b, restaurado, antigo]) banco.close()
      await cliente.auth.signOut()
    }
  }, 120_000)
})
