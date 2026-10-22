import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { conectar, lerMigracoes } from '../../nuvem/migrar.ts'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let sql: SQL
type Documento = Record<string, unknown>
type Grupo = { operacao: Documento; lancamentos: Documento[]; movimentos: Documento[] }
class Revertida extends Error {}
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })

async function assumir(tx: SQL, dono: string): Promise<void> {
  await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: dono, role: 'authenticated' })},true)`
  await tx.unsafe('set local role authenticated')
}
async function transacao(fn: (tx: TransactionSQL) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      if (process.env.MUTACAO_ESTOQUE) await tx.unsafe(process.env.MUTACAO_ESTOQUE)
      await fn(tx)
      await tx.unsafe('set constraints all immediate')
      throw new Revertida()
    })
  } catch (erro) { if (!(erro instanceof Revertida)) throw erro }
}
async function preparar(tx: SQL, quantidade: number): Promise<{ dono: string; grupos: Grupo[] }> {
  const dono = uuidv7(), categoriaId = uuidv7(), produtoId = uuidv7()
  await assumir(tx, dono)
  await tx`select public.gravar_categoria_estoque(${ { id: categoriaId, nome: 'Teste Q47' } }::jsonb)`
  await tx`select public.gravar_produto_estoque(${ { id: produtoId, nome: 'Fictício Q47', categoriaId,
    atualizadoEm: '2026-10-20T12:00:00.000Z' } }::jsonb)`
  const grupos = Array.from({ length: quantidade }, (_, i): Grupo => {
    const id = uuidv7(), movimentoId = uuidv7()
    return { operacao: { id, formato: 1, revisao: 1, tipo: 'movimento', lancamentos: [],
      movimentos: [{ id: movimentoId, revisao: 1 }], dependencias: [] }, lancamentos: [],
    movimentos: [{ id: movimentoId, revisao: 1, operacaoId: id, produtoId, data: '2026-10-20', tipo: 'compra',
      quantidade: 1, conhecidos: [], custoUnitario: '123', ordemCadastro: String(1792497600000n + BigInt(i)) }] }
  })
  // Carga em lote, com ids do cliente e todas as constraints/gatilhos ativos. Tudo será desfeito.
  await tx.unsafe('reset role')
  await tx`insert into public.operacoes_estoque(id,dono,revisao,formato,tipo,lancamentos,movimentos,dependencias)
    select (g->'operacao'->>'id')::uuid,${dono}::uuid,1,1,'movimento','[]',g->'operacao'->'movimentos','[]'
    from jsonb_array_elements(${grupos}::jsonb) g`
  await tx`insert into public.movimentos_estoque(id,dono,revisao,operacao_id,produto_id,data,tipo,conhecidos,quantidade,custo_unitario,ordem_cadastro)
    select (m->>'id')::uuid,${dono}::uuid,1,(m->>'operacaoId')::uuid,${produtoId}::uuid,'2026-10-20','compra','[]',1,123,(m->>'ordemCadastro')::bigint
    from jsonb_array_elements(${grupos}::jsonb) g cross join lateral jsonb_array_elements(g->'movimentos') m`
  await tx.unsafe('set constraints all immediate')
  await tx.unsafe('set constraints all deferred')
  await assumir(tx, dono)
  return { dono, grupos }
}
function documento(grupo: Grupo, aceitos: readonly Grupo[]): Documento {
  return { id: uuidv7(), data: '2026-10-20', tentativa: { id: grupo.operacao['id'], revisao: grupo.operacao['revisao'], conteudo: JSON.stringify(grupo) },
    evidencia: { grupo, desfecho: 'recusada', diagnostico: '23514: tentativa fictícia Q47' }, aceitosConhecidos: aceitos }
}
async function encerrar(tx: SQL, doc: Documento): Promise<Documento> {
  const [r] = await tx<{ resultado: Documento }[]>`select public.gravar_encerramento_estoque(${doc}::jsonb) resultado`
  if (!r) throw new Error('RPC sem resposta')
  return r.resultado
}
async function recusar(tx: TransactionSQL, fn: (sp: SQL) => Promise<unknown>, regra: string): Promise<void> {
  try { await tx.savepoint(fn) } catch (erro) {
    if (!(erro instanceof SQL.PostgresError)) throw erro
    expect(erro.errno).toBe('23514')
    expect(erro.constraint).toBe(regra)
    return
  }
  throw new Error(`O banco aceitou a violação ${regra}`)
}
function primeiro(grupos: readonly Grupo[]): Grupo {
  const grupo = grupos[0]
  if (!grupo) throw new Error('Amostra vazia')
  return grupo
}

describe.skipIf(!LIGADA)('Q47 volume e identidade', () => {
  test('confere 240 aceites completos no limite real de 8s, preserva conteúdo e reenvio', async () => {
    await transacao(async (tx) => {
      const { grupos } = await preparar(tx, 240)
      const aceita = primeiro(grupos)
      const divergente = { ...aceita, operacao: { ...aceita.operacao, revisao: 2 } }
      const doc = documento(divergente, grupos)
      // Mesmo limite de authenticated/PostgREST medido nos dois destinos, sem elevá-lo.
      await tx.unsafe("set local statement_timeout = '8s'")
      const inicio = performance.now()
      const resposta = await encerrar(tx, doc)
      await tx.unsafe('set constraints all immediate')
      console.log('Q47 240 aceites, RPC + constraints (ms):', Math.round(performance.now() - inicio))
      expect(resposta['id']).toBe(doc['id'])
      expect(await encerrar(tx, doc)).toEqual(resposta)
      expect(await encerrar(tx, { ...doc, id: uuidv7() })).toEqual(resposta)
      const linhas = await tx<{ grupo: Grupo }[]>`select registro->'grupo' grupo
        from public.baixar_estoque('0',500) registro where registro->>'tipo'='operacao' order by (registro->>'recepcao')::bigint`
      expect(linhas.map((l) => l.grupo)).toEqual(grupos.slice(0, 500))
      expect(await tx`select id from public.operacoes_estoque`).toHaveLength(240)
      expect(await tx`select id from public.movimentos_estoque`).toHaveLength(240)
      expect(await tx`select id from public.encerramentos_estoque`).toHaveLength(1)
      const [salvo] = await tx<{ aceitos_conhecidos: Grupo[] }[]>`select aceitos_conhecidos from public.encerramentos_estoque`
      expect(salvo?.aceitos_conhecidos).toEqual(grupos)
    })
  })

  test('mesmo id exige conteúdo/revisão completos e dono; SQL direto conserva a guarda diferida', async () => {
    await transacao(async (tx) => {
      const { dono, grupos } = await preparar(tx, 1)
      const aceita = primeiro(grupos), movimento = aceita.movimentos[0]
      if (!movimento) throw new Error('Sem movimento')
      const divergente = { ...aceita, movimentos: [{ ...movimento, quantidade: 2 }] }
      const doc = documento(divergente, grupos)
      await recusar(tx, (sp) => encerrar(sp, documento(aceita, grupos)), 'estoque_tentativa_aceita')
      await recusar(tx, (sp) => encerrar(sp, documento(divergente, [divergente])), 'estoque_aceite_desconhecido')
      await recusar(tx, (sp) => encerrar(sp, documento(divergente, [{ ...aceita, operacao: { ...aceita.operacao, id: 'inválido' } }])), 'estoque_aceite_desconhecido')
      expect((await encerrar(tx, doc))['id']).toBe(doc['id'])
      await tx.unsafe('set constraints all immediate')
      await tx.unsafe('set constraints all deferred')
      await assumir(tx, uuidv7())
      await recusar(tx, (sp) => encerrar(sp, documento(divergente, grupos)), 'estoque_aceite_desconhecido')
      await assumir(tx, dono)
      await tx.unsafe('reset role')
      await recusar(tx, async (sp) => {
        await sp`insert into public.encerramentos_estoque(id,dono,data,tentativa,evidencia,aceitos_conhecidos)
          values(${uuidv7()}::uuid,${dono}::uuid,'2026-10-20',${doc['tentativa']}::jsonb,${doc['evidencia']}::jsonb,${[divergente]}::jsonb)`
        await sp.unsafe('set constraints all immediate')
      }, 'estoque_aceite_desconhecido')
    })
  })

  test('reversão e reaplicação da 0007 conservam operações, efeitos e encerramento', async () => {
    await transacao(async (tx) => {
      const { dono, grupos } = await preparar(tx, 1), aceita = primeiro(grupos)
      const doc = documento({ ...aceita, operacao: { ...aceita.operacao, revisao: 2 } }, grupos)
      const resposta = await encerrar(tx, doc)
      await tx.unsafe('set constraints all immediate')
      const retrato = () => tx`select
        (select jsonb_agg(to_jsonb(o)) from public.operacoes_estoque o where o.dono=${dono}::uuid) operacoes,
        (select jsonb_agg(to_jsonb(m)) from public.movimentos_estoque m where m.dono=${dono}::uuid) movimentos,
        (select jsonb_agg(to_jsonb(e)) from public.encerramentos_estoque e where e.dono=${dono}::uuid) encerramentos`
      const antes = await retrato()
      const migracao = (await lerMigracoes()).find((m) => m.nome === '0007_conferencia-por-identidade')
      if (!migracao) throw new Error('Migration 0007 ausente')
      await tx.unsafe('reset role')
      await tx.unsafe(migracao.reverter)
      expect(await retrato()).toEqual(antes)
      expect(await encerrar(tx, doc)).toEqual(resposta)
      await tx.unsafe(migracao.aplicar)
      expect(await retrato()).toEqual(antes)
      expect(await encerrar(tx, doc)).toEqual(resposta)
    })
  })
})
