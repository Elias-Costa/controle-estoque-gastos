import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar, lerMigracoes } from '../../nuvem/migrar.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { criarConsultaContatoSuporte } from '../../src/sincronizacao/contato-suporte.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let sql: SQL, cliente: SupabaseClient
class Revertida extends Error {}
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) { await cliente?.auth.signOut(); await sql.close() } })

describe.skipIf(!LIGADA)('D-077 contato privado somente para relato autenticado', () => {
  test('0012 aplica/reverte vazia e recusa perder contato configurado', async () => {
    const migracao = (await lerMigracoes()).find((m) => m.nome === '0012_contato-suporte')
    if (!migracao) throw new Error('sem 0012')
    try { await sql.begin(async (tx) => {
      const esquema = `suporte_${uuidv7().replaceAll('-', '')}`
      await tx.unsafe(`create schema ${esquema}`)
      const aplicar = migracao.aplicar.replaceAll('public.', `${esquema}.`), reverter = migracao.reverter.replaceAll('public.', `${esquema}.`)
      await tx.unsafe(aplicar); await tx.unsafe(reverter)
      expect((await tx<{ existe: boolean }[]>`select to_regclass(${`${esquema}.contato_suporte`}) is not null as existe`)[0]?.existe).toBe(false)
      await tx.unsafe(aplicar)
      await tx.unsafe(`insert into ${esquema}.contato_suporte(chave,telefone) values ('mantenedor','5511999999999')`)
      let recusou = false
      try { await tx.savepoint(async (sp) => { await sp.unsafe(reverter) }) }
      catch (e) { if (!(e instanceof SQL.PostgresError)) throw e; expect(e.errno ?? e.code).toBe('23514'); recusou = true }
      expect(recusou).toBe(true)
      expect((await tx.unsafe<{ telefone: string }[]>(`select telefone from ${esquema}.contato_suporte`))[0]?.telefone).toBe('5511999999999')
      throw new Revertida()
    }) } catch (e) { if (!(e instanceof Revertida)) throw e }
  })

  test('SQL direto nega tabela aos dois papéis e função a anon ou authenticated sem identidade', async () => {
    try { await sql.begin(async (tx) => {
      for (const papel of ['anon', 'authenticated']) {
        await tx.unsafe(`set local role ${papel}`)
        await tx`select set_config('request.jwt.claims','{}',true)`
        for (const comando of ['select telefone from public.contato_suporte',
          "insert into public.contato_suporte(chave,telefone) values ('mantenedor','5511999999999')",
          'select public.obter_contato_suporte()']) {
          let recusou = false
          try { await tx.savepoint(async (sp) => { await sp.unsafe(comando) }) }
          catch (e) { if (!(e instanceof SQL.PostgresError)) throw e; expect(e.errno ?? e.code).toBe('42501'); recusou = true }
          expect(recusou).toBe(true)
        }
      }
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: uuidv7(), role: 'authenticated' })},true)`
      expect((await tx<{ telefone: string }[]>`select public.obter_contato_suporte() as telefone`)[0]?.telefone).toBe('5511999999999')
      throw new Revertida()
    }) } catch (e) { if (!(e instanceof Revertida)) throw e }
  })

  test('contato não configurado e formatos inválidos não fabricam número', async () => {
    try { await sql.begin(async (tx) => {
      await tx`delete from public.contato_suporte where chave='mantenedor'`
      for (const telefone of ['', '11999999999', 'https://externo/']) {
        let recusou = false
        try { await tx.savepoint(async (sp) => { await sp`insert into public.contato_suporte(chave,telefone) values ('mantenedor',${telefone})` }) }
        catch (e) { if (!(e instanceof SQL.PostgresError)) throw e; expect(e.errno ?? e.code).toBe('23514'); recusou = true }
        expect(recusou).toBe(true)
      }
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: uuidv7(), role: 'authenticated' })},true)`
      await tx.unsafe('set local role authenticated')
      expect((await tx<{ telefone: string | null }[]>`select public.obter_contato_suporte() as telefone`)[0]?.telefone).toBeNull()
      throw new Revertida()
    }) } catch (e) { if (!(e instanceof Revertida)) throw e }
  })

  test('PostgREST real: anônimo e token inválido não recebem contato; login permite só RPC, saída retira acesso', async () => {
    const url = process.env.VITE_SUPABASE_URL ?? '', chave = process.env.VITE_SUPABASE_ANON_KEY ?? ''
    cliente = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } })
    const consultar = criarConsultaContatoSuporte(async () => {
      const { data, error } = await cliente.rpc('obter_contato_suporte'); return { data, error }
    })
    expect(await consultar()).toEqual({ ok: false, motivo: 'entrar' })
    const invalido = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: 'Bearer invalido' } } })
    const negada = await invalido.rpc('obter_contato_suporte')
    expect(negada.data).toBeNull(); expect(negada.error).not.toBeNull()
    const { error } = await cliente.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '', password: process.env.SUPABASE_TESTE_SENHA ?? '' })
    expect(error).toBeNull()
    expect(await consultar()).toEqual({ ok: true, telefone: '5511999999999' })
    const tabela = await cliente.from('contato_suporte').select('telefone')
    expect(tabela.data).toBeNull(); expect(tabela.error?.code).toBe('42501')
    await cliente.auth.signOut()
    expect(await consultar()).toEqual({ ok: false, motivo: 'entrar' })
  })
})
