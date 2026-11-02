import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { createClient } from '@supabase/supabase-js'
import { conectar, lerMigracoes } from '../../nuvem/migrar.ts'
import { lerFotografiaLembretes } from '../../nuvem/lembretes/emissor.ts'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let sql: SQL
class Revertida extends Error {}
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })
const inscricao = { endpoint: 'https://fcm.googleapis.com/fcm/send/ficticio-e38', p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) }
const obs = { baixos: [], pendentes: [], lembrados: [] }
async function assumir(tx: SQL, conta: string) {
  await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: conta, role: 'authenticated' })},true)`
  await tx.unsafe('set local role authenticated')
}
async function transacao(fn: (tx: TransactionSQL) => Promise<void>) {
  try { await sql.begin(async (tx) => {
    if (process.env.MUTACAO_LEMBRETES) await tx.unsafe(process.env.MUTACAO_LEMBRETES)
    await fn(tx)
    throw new Revertida()
  }) } catch (e) { if (!(e instanceof Revertida)) throw e }
}
async function registrar(tx: SQL, conta: string, aparelhoId: string, revisao = 1, anterior = 0, ativa = true) {
  await assumir(tx, conta)
  const [r] = await tx<{ resposta: { revisao: number; estado: string } }[]>`select public.registrar_inscricao_lembretes(
    ${{ aparelhoId, revisao, anterior, ativa, ...(ativa ? { inscricao } : {}) }}::jsonb) resposta`
  await tx.unsafe('reset role')
  if (!r) throw new Error('Sem resposta')
  return r.resposta
}
async function preparar(tx: SQL, conta: string, agora = '2026-10-31T12:00:00Z', carimbo?: string, motivo = true) {
  const [f] = await tx<{ resposta: { carimbo: string } }[]>`select public.fotografia_lembretes(${conta}::uuid) resposta`
  if (!f) throw new Error('Sem fotografia')
  const [r] = await tx<{ resposta: { estado: string; dia?: string; destinos: { aparelhoId: string; revisao: number; tentativa: number; inscricao: typeof inscricao }[] } }[]>`
    select public.preparar_rodada_lembretes(${conta}::uuid,${carimbo ?? f.resposta.carimbo},${obs}::jsonb,${motivo},${agora}::timestamptz) resposta`
  if (!r) throw new Error('Sem rodada')
  return r.resposta
}
describe.skipIf(!LIGADA)('D-079 Postgres de lembretes', () => {
  test('reversão vazia quando disponível; com inscrição recusa antes de qualquer DDL', () => transacao(async (tx) => {
    const migracao = (await lerMigracoes()).find((m) => m.nome === '0013_lembretes')
    if (!migracao) throw new Error('Sem migration')
    const [r] = await tx<{ n: number }[]>`select (select count(*) from lembretes_interno.inscricoes)::integer+
      (select count(*) from lembretes_interno.observacoes)::integer+(select count(*) from lembretes_interno.configuracao)::integer n`
    if (r?.n === 0) { await tx.unsafe(migracao.reverter); await tx.unsafe(migracao.aplicar) }
    await registrar(tx, uuidv7(), uuidv7())
    let recusou = false
    try { await tx.savepoint((sp) => sp.unsafe(migracao.reverter)) } catch (e) {
      if (!(e instanceof SQL.PostgresError)) throw e
      expect(e.errno).toBe('23514'); recusou = true
    }
    expect(recusou).toBe(true)
    expect((await tx<{ n: number }[]>`select count(*)::integer n from lembretes_interno.inscricoes`)[0]?.n).toBeGreaterThan(0)
  }))
  test('identidade local perdida não duplica o mesmo endpoint; replay antigo não o reativa', () => transacao(async (tx) => {
    const conta = uuidv7(), antigo = uuidv7(), novo = uuidv7()
    await registrar(tx, conta, antigo)
    await registrar(tx, conta, novo)
    expect((await preparar(tx, conta)).destinos.map((d) => d.aparelhoId)).toEqual([novo])
    expect(await registrar(tx, conta, antigo)).toEqual({ revisao: 1, estado: 'invalida' })
  }))
  test('reenvio, desligamento, revisão antiga e isolamento entre contas', () => transacao(async (tx) => {
    const conta = uuidv7(), outra = uuidv7(), aparelho = uuidv7()
    expect(await registrar(tx, conta, aparelho)).toEqual({ revisao: 1, estado: 'ativa' })
    expect(await registrar(tx, conta, aparelho)).toEqual({ revisao: 1, estado: 'ativa' })
    expect(await registrar(tx, conta, aparelho, 2, 1, false)).toEqual({ revisao: 2, estado: 'desligada' })
    expect(await registrar(tx, conta, aparelho)).toEqual({ revisao: 2, estado: 'conflito' })
    expect(await registrar(tx, outra, aparelho, 2, 1)).toEqual({ revisao: 0, estado: 'conflito' })
    expect((await preparar(tx, conta)).destinos).toEqual([])
  }))
  test('uma rodada/destino, início sem resposta não retenta na oportunidade seguinte', () => transacao(async (tx) => {
    const conta = uuidv7(), aparelho = uuidv7()
    await registrar(tx, conta, aparelho)
    expect((await preparar(tx, conta)).destinos).toEqual([{ aparelhoId: aparelho, revisao: 1, tentativa: 1, inscricao }])
    expect((await preparar(tx, conta)).destinos).toEqual([])
    expect((await preparar(tx, conta, '2026-10-31T12:15:00Z')).destinos).toEqual([])
    const [r] = await tx<{ estado: string }[]>`select estado from lembretes_interno.envios where dono=${conta}::uuid`
    expect(r?.estado).toBe('incerto')
    expect((await preparar(tx, conta, '2026-11-01T12:00:00Z')).destinos).toHaveLength(1)
  }))
  test('rejeição temporária respeita Retry-After, até três tentativas; sucesso não repete', () => transacao(async (tx) => {
    const conta = uuidv7(), aparelho = uuidv7(); await registrar(tx, conta, aparelho)
    await preparar(tx, conta)
    await tx`select public.concluir_envio_lembretes(${conta}::uuid,'2026-10-31',${aparelho}::uuid,1,1,'retentavel','2026-10-31T12:20:00Z')`
    expect((await preparar(tx, conta, '2026-10-31T12:15:00Z')).destinos).toHaveLength(0)
    expect((await preparar(tx, conta, '2026-10-31T12:30:00Z')).destinos[0]?.tentativa).toBe(2)
    await tx`select public.concluir_envio_lembretes(${conta}::uuid,'2026-10-31',${aparelho}::uuid,1,1,'invalida',null)`
    const [atual] = await tx<{ estado: string }[]>`select estado from lembretes_interno.envios where dono=${conta}::uuid`
    expect(atual?.estado).toBe('em-envio')
    await tx`select public.concluir_envio_lembretes(${conta}::uuid,'2026-10-31',${aparelho}::uuid,1,2,'aceito',null)`
    expect((await preparar(tx, conta, '2026-10-31T12:30:00Z')).destinos).toHaveLength(0)
  }))
  test('invalidação antiga não atinge inscrição nova; revisão ativa aceita não duplica dia', () => transacao(async (tx) => {
    const conta = uuidv7(), aparelho = uuidv7(); await registrar(tx, conta, aparelho)
    await preparar(tx, conta)
    await registrar(tx, conta, aparelho, 2, 1)
    await tx`select public.concluir_envio_lembretes(${conta}::uuid,'2026-10-31',${aparelho}::uuid,1,1,'invalida',null)`
    const [r] = await tx<{ invalida: boolean }[]>`select invalida from lembretes_interno.inscricoes where dono=${conta}::uuid`
    expect(r?.invalida).toBe(false)
    expect((await preparar(tx, conta, '2026-10-31T12:15:00Z')).destinos).toHaveLength(0)
  }))
  test('fotografia alterada, ausência de motivo e horários externos não iniciam transporte', () => transacao(async (tx) => {
    const conta = uuidv7(); await registrar(tx, conta, uuidv7())
    expect((await preparar(tx, conta, undefined, 'obsoleto')).estado).toBe('alterada')
    expect((await preparar(tx, conta, undefined, undefined, false)).estado).toBe('sem-motivo')
    for (const agora of ['2026-10-31T11:59:59Z', '2026-10-31T12:31:00Z', '2026-10-31T23:00:00Z']) {
      expect((await preparar(tx, conta, agora)).estado).toBe('fora-do-horario')
    }
    const [r] = await tx<{ n: number }[]>`select count(*)::integer n from lembretes_interno.envios where dono=${conta}::uuid`
    expect(r?.n).toBe(0)
  }))
  test('RPC administrativa e tabelas não são acessíveis ao app; configuração exige autenticação', () => transacao(async (tx) => {
    await assumir(tx, uuidv7())
    for (const comando of ['select public.listar_contas_lembretes()', 'select * from lembretes_interno.inscricoes',
      'select public.fotografia_lembretes(\'00000000-0000-4000-8000-000000000000\')']) {
      let recusado = false
      try { await tx.savepoint((sp) => sp.unsafe(comando)) } catch (e) { if (!(e instanceof SQL.PostgresError)) throw e; expect(e.errno).toBe('42501'); recusado = true }
      expect(recusado).toBe(true)
    }
    await tx.unsafe('reset role')
  }))
  test('SQL direto recusa endpoint arbitrário e número fracionário; retrato do negócio fica igual', () => transacao(async (tx) => {
    const conta = uuidv7(), aparelho = uuidv7()
    const [antes] = await tx<{ f: unknown }[]>`select lembretes_interno.fontes(${conta}::uuid) f`
    await registrar(tx, conta, aparelho)
    for (const comando of [
      `update lembretes_interno.inscricoes set inscricao=jsonb_set(inscricao,'{endpoint}','"https://localhost/segredo"') where dono='${conta}'`,
      `select public.registrar_inscricao_lembretes('{"aparelhoId":"${aparelho}","ativa":false,"revisao":1.5,"anterior":1}')`,
    ]) {
      let recusado = false
      try { await tx.savepoint(async (sp) => { await assumir(sp, conta); await sp.unsafe('reset role'); return sp.unsafe(comando) }) }
      catch (e) { if (!(e instanceof SQL.PostgresError)) throw e; expect(e.errno).toBe('23514'); recusado = true }
      expect(recusado).toBe(true)
    }
    const [depois] = await tx<{ f: unknown }[]>`select lembretes_interno.fontes(${conta}::uuid) f`
    expect(depois?.f).toEqual(antes?.f)
  }))
  test('fontes reais mudam carimbo antes da reserva; codecs conservam centavos e dono', () => transacao(async (tx) => {
    const conta = uuidv7(), aparelho = uuidv7(); await registrar(tx, conta, aparelho)
    const [antes] = await tx<{ foto: unknown }[]>`select public.fotografia_lembretes(${conta}::uuid) foto`
    const primeira = lerFotografiaLembretes(antes?.foto)
    await assumir(tx, conta)
    const cliente = uuidv7(), gasto = uuidv7(), operacao = uuidv7()
    await tx`insert into public.clientes(id,nome) values(${cliente}::uuid,'Fictícia E38')`
    await tx`select public.aceitar_grupo_caixa(${{ operacao: { id: operacao, formato: 1, revisao: 1, tipo: 'registro', fatos: [{ id: gasto, revisao: 1 }] },
      fatos: [{ id: gasto, revisao: 1, tipo: 'receita-avulsa', data: '2026-10-31', valor: '9007199254740993', categoria: 'Fictícia', classificacao: 'pessoal' }] }}::jsonb)`
    await tx.unsafe('reset role')
    expect((await preparar(tx, conta, undefined, primeira.carimbo)).estado).toBe('alterada')
    const [depois] = await tx<{ foto: unknown }[]>`select public.fotografia_lembretes(${conta}::uuid) foto`
    const segunda = lerFotografiaLembretes(depois?.foto)
    expect(segunda.fontes.clientes.map((c) => c.id)).toEqual([cliente])
    const fato = segunda.fontes.fatosCaixa[0]
    expect(fato?.tipo === 'receita-avulsa' ? fato.valor : null).toBe(9007199254740993n)
  }))
  test('duas conexões reservam um único destino e preservam a rodada após commit', async () => {
    const conta = uuidv7(), aparelho = uuidv7(), segunda = conectar()
    await sql.begin((tx) => registrar(tx, conta, aparelho))
    try {
      const respostas = await Promise.all([preparar(sql, conta), preparar(segunda, conta)])
      expect(respostas.reduce((n, r) => n + r.destinos.length, 0)).toBe(1)
      expect((await preparar(segunda, conta)).destinos).toHaveLength(0)
    } finally {
      await sql.begin((tx) => registrar(tx, conta, aparelho, 2, 1, false))
      await segunda.close()
    }
  })
  test('Auth/PostgREST reais guardam inscrição idempotente e não expõem função administrativa', async () => {
    const url = process.env.VITE_SUPABASE_URL, chave = process.env.VITE_SUPABASE_ANON_KEY
    const email = process.env.SUPABASE_TESTE_EMAIL, senha = process.env.SUPABASE_TESTE_SENHA
    if (!url || !chave || !email || !senha) throw new Error('Ambiente de teste incompleto')
    const cliente = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } })
    const login = await cliente.auth.signInWithPassword({ email, password: senha })
    if (login.error) throw new Error('Login de teste não respondeu')
    const aparelhoId = uuidv7(), pedido = { aparelhoId, revisao: 1, anterior: 0, ativa: true,
      inscricao: { ...inscricao, endpoint: `${inscricao.endpoint}-${aparelhoId}` } }
    const falhas: unknown[] = []
    try {
      for (let n = 0; n < 2; n++) {
        const r = await cliente.rpc('registrar_inscricao_lembretes', { pedido })
        expect(r.error).toBeNull(); expect(r.data).toEqual({ revisao: 1, estado: 'ativa' })
      }
      const proibida = await cliente.rpc('listar_contas_lembretes')
      expect(proibida.error).not.toBeNull()
    } catch (erro) { falhas.push(erro) }
    try {
      const r = await cliente.rpc('registrar_inscricao_lembretes', { pedido: { aparelhoId, revisao: 2, anterior: 1, ativa: false } })
      if (r.error) throw new Error('Inscrição fictícia ainda precisa ser desligada')
    } catch (erro) { falhas.push(erro) }
    if (falhas.length) throw new AggregateError(falhas, 'Falha na prova/encerramento da inscrição fictícia')
  })
})
