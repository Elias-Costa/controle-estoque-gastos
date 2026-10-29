import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar, lerMigracoes } from '../../nuvem/migrar.ts'
import { BancoLocal } from '../../src/dados/banco.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { criarRepositorioIdentidadeLoja } from '../../src/dados/repositorio-identidade-loja.ts'
import { iniciarSincronizacao } from '../../src/sincronizacao/sincronizacao.ts'
import { criarNuvemSupabase, type Nuvem } from '../../src/sincronizacao/nuvem.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
const T = '2026-10-26T12:00:00.000Z', T2 = '2026-10-26T12:01:00.000Z', T3 = '2026-10-26T12:02:00.000Z'
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII='
const conteudo = { nome: 'Cícera Mult', descricao: 'Moda íntima e acessórios', logo: LOGO }
let sql: SQL, cliente: SupabaseClient, nuvem: Nuvem
const bancos: BancoLocal[] = []
class Revertida extends Error {}
beforeAll(async () => {
  if (!LIGADA) return
  sql = conectar()
  cliente = createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.VITE_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await cliente.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '', password: process.env.SUPABASE_TESTE_SENHA ?? '' })
  if (error) throw error
  const { fotos: _fotos, ...transporte } = criarNuvemSupabase(cliente)
  nuvem = transporte
})
afterAll(async () => { bancos.forEach((b) => b.close()); if (LIGADA) { await cliente.auth.signOut(); await sql.close() } })
function base() { const b = new BancoLocal(uuidv7(), { indexedDB: new IDBFactory(), IDBKeyRange }); bancos.push(b); return b }
function motor(b: BancoLocal, n = nuvem) {
  // O ensaio dirige cada ciclo; INITIAL_SESSION não pode disparar um segundo motor sozinho.
  return iniciarSincronizacao({ banco: b, nuvem: { ...n, aoMudarSessao: () => () => undefined }, agendar: () => () => undefined, janela: null, documento: null })
}

describe.skipIf(!LIGADA)('D-076 identificação privada: SQL e transporte reais', () => {
  test('par 0011 aplica/reverte vazio e recusa reversão com identidade guardada', async () => {
    const migracao = (await lerMigracoes()).find((m) => m.nome === '0011_identidade-loja')
    if (!migracao) throw new Error('sem 0011')
    try { await sql.begin(async (tx) => {
      const esquema = `identidade_${uuidv7().replaceAll('-', '')}`
      await tx.unsafe(`create schema ${esquema}`)
      const aplicar = migracao.aplicar.replaceAll('public.', `${esquema}.`)
      const reverter = migracao.reverter.replaceAll('public.', `${esquema}.`)
      await tx.unsafe(aplicar); await tx.unsafe(reverter)
      expect((await tx<{ existe: boolean }[]>`select to_regclass(${`${esquema}.identidades_loja`}) is not null as existe`)[0]?.existe).toBe(false)
      await tx.unsafe(aplicar)
      await tx.unsafe(`insert into ${esquema}.identidades_loja(dono,chave,id,identidade,atualizado_em) values ($1,'loja',$2,$3::jsonb,$4)`,
        [uuidv7(), uuidv7(), conteudo, T])
      let recusou = false
      try { await tx.savepoint(async (sp) => { await sp.unsafe(reverter) }) }
      catch (e) { if (!(e instanceof SQL.PostgresError)) throw e; expect(e.errno ?? e.code).toBe('23514'); recusou = true }
      expect(recusou).toBe(true)
      expect((await tx.unsafe<{ identidade: unknown }[]>(`select identidade from ${esquema}.identidades_loja`))[0]?.identidade).toEqual(conteudo)
      throw new Revertida()
    }) } catch (e) { if (!(e instanceof Revertida)) throw e }
  })
  test('SQL direto recusa nome vazio, logo remota/inválida e campos extras', async () => {
    try { await sql.begin(async (tx) => {
      for (const identidade of [{ ...conteudo, nome: '' }, { ...conteudo, logo: 'https://externo/logo.png' },
        { ...conteudo, logo: LOGO.replace('iVBOR', 'AAAAA') }, { ...conteudo, privado: 'extra' }]) {
        let recusou = false
        try { await tx.savepoint(async (sp) => { await sp`insert into public.identidades_loja(dono,chave,id,identidade,atualizado_em)
          values (${uuidv7()},'loja',${uuidv7()},${identidade}::jsonb,${T})` }) }
        catch (e) { if (!(e instanceof SQL.PostgresError)) throw e; expect(e.errno ?? e.code).toBe('23514'); recusou = true }
        expect(recusou).toBe(true)
      }
      throw new Revertida()
    }) } catch (e) { if (!(e instanceof Revertida)) throw e }
  })
  test('RLS/ACL isolam conta e impedem exclusão; envio antigo não remove logo', async () => {
    try { await sql.begin(async (tx) => {
      const dono = uuidv7(), outro = uuidv7(), id = uuidv7()
      if (process.env.MUTACAO_IDENTIDADE) await tx.unsafe(process.env.MUTACAO_IDENTIDADE)
      await tx`insert into public.identidades_loja(dono,chave,id,identidade,atualizado_em) values (${dono},'loja',${id},${conteudo}::jsonb,${T2})`
      await tx`update public.identidades_loja set identidade=${{ nome: 'Antiga', descricao: '' }}::jsonb, atualizado_em=${T} where dono=${dono}`
      expect((await tx<{ identidade: unknown }[]>`select identidade from public.identidades_loja where dono=${dono}`)[0]?.identidade).toEqual(conteudo)
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: outro, role: 'authenticated' })},true)`
      await tx.unsafe('set local role authenticated')
      expect(await tx`select * from public.identidades_loja where dono=${dono}`).toHaveLength(0)
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: dono, role: 'authenticated' })},true)`
      expect(await tx`select * from public.identidades_loja where dono=${dono}`).toHaveLength(1)
      let recusou = false
      try { await tx.savepoint(async (sp) => { await sp`delete from public.identidades_loja where dono=${dono}` }) }
      catch (e) { if (!(e instanceof SQL.PostgresError)) throw e; expect(e.errno ?? e.code).toBe('42501'); recusou = true }
      expect(recusou).toBe(true); throw new Revertida()
    }) } catch (e) { if (!(e instanceof Revertida)) throw e }
  })
  test('resposta perdida, reenvio, restauração vazia, edição em trânsito e remoção conservam a preferência inteira', async () => {
    const b = base(), r = criarRepositorioIdentidadeLoja(b, () => T), a = motor(b)
    try {
      await r.salvar(conteudo, undefined)
      const transporte = nuvem.identidadeLoja; if (!transporte) throw new Error('sem transporte')
      let perder = true
      const falha = motor(b, { ...nuvem, identidadeLoja: { ...transporte, enviar: async (linha) => {
        const resposta = await transporte.enviar(linha)
        if (resposta.ok && perder) { perder = false; return { ok: false, falha: { tipo: 'rede', mensagem: 'resposta perdida após commit' } } }
        return resposta
      } } })
      try { await falha.sincronizar(); expect(await b.fila.count()).toBe(1) } finally { falha.parar() }
      await a.sincronizar(); expect(a.estado().ultimaFalha).toBeNull(); expect(await b.fila.count()).toBe(0)
      const outro = base(), restauracao = motor(outro)
      try {
        await restauracao.sincronizar(); expect((await criarRepositorioIdentidadeLoja(outro).ler())?.identidade).toEqual(conteudo)
        const atual = await r.ler(); if (!atual) throw new Error('sem preferência')
        await criarRepositorioIdentidadeLoja(b, () => T2).salvar({ ...conteudo, nome: 'Versão em trânsito' }, atual)
        let editou = false
        const disputa = motor(b, { ...nuvem, identidadeLoja: { ...transporte, enviar: async (linha) => {
          const resposta = await transporte.enviar(linha)
          if (resposta.ok && !editou) {
            editou = true
            await criarRepositorioIdentidadeLoja(b, () => T3).salvar({ nome: 'Loja final', descricao: '' }, await r.ler())
          }
          return resposta
        } } })
        try { await disputa.sincronizar() } finally { disputa.parar() }
        expect((await r.ler())?.identidade).toEqual({ nome: 'Loja final', descricao: '' })
        expect(await b.fila.count()).toBe(1)
        await a.sincronizar(); await restauracao.sincronizar()
        expect((await criarRepositorioIdentidadeLoja(outro).ler())?.identidade).toEqual({ nome: 'Loja final', descricao: '' })
        expect(await b.fila.count()).toBe(0)
      } finally { restauracao.parar() }
    } finally { a.parar() }
  })
})
