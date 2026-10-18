import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { conectar, lerMigracoes } from '../../nuvem/migrar.ts'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { lancamentoDaNuvem } from '../../src/sincronizacao/borda.ts'
import { saldo, type Lancamento } from '../../src/dominio/ficha.ts'
import { createClient } from '@supabase/supabase-js'
import { criarNuvemSupabase } from '../../src/sincronizacao/nuvem.ts'
import { lancamentoParaNuvem } from '../../src/sincronizacao/borda.ts'

// D-050: a suíte só alcança os destinos fictícios validados pelo comando de ambiente.
const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let sql: SQL
const A = '00000000-0000-4000-8000-00000000020a'
const B = '00000000-0000-4000-8000-00000000020b'
const DIA = '2026-10-18'
const CARIMBO = '2026-10-18T12:00:00.000Z'
type Documento = Record<string, unknown>
type Grupo = { operacao: Documento; lancamentos: Documento[]; movimentos: Documento[] }

class Revertida extends Error {}
beforeAll(async () => {
  if (!LIGADA) return
  sql = conectar()
})
afterAll(async () => { if (LIGADA) await sql.close() })

async function assumir(tx: SQL, conta = A): Promise<void> {
  await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: conta, role: 'authenticated' })},true)`
  await tx.unsafe('set local role authenticated')
}
async function transacao(fn: (tx: TransactionSQL) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      if (process.env.MUTACAO_ESTOQUE) await tx.unsafe(process.env.MUTACAO_ESTOQUE)
      await assumir(tx)
      await fn(tx)
      // Dispara também as constraints diferidas, antes de desfazer os dados fictícios.
      await tx.unsafe('set constraints all immediate')
      throw new Revertida()
    })
  } catch (erro) { if (!(erro instanceof Revertida)) throw erro }
}
async function recusa(tx: TransactionSQL, fn: (sp: SQL) => Promise<unknown>, regra?: string): Promise<string> {
  try { await tx.savepoint(fn) } catch (erro) {
    if (!(erro instanceof SQL.PostgresError)) throw erro
    if (regra) expect(erro.constraint).toBe(regra)
    return erro.errno ?? erro.code
  }
  throw new Error('o banco aceitou a violação de E-20')
}
async function categoria(tx: SQL, nome = 'Perfumes', id = uuidv7()): Promise<string> {
  await tx`select public.gravar_categoria_estoque(${ { id, nome } }::jsonb)`
  return id
}
async function produto(tx: SQL, categoriaId: string, extras: Documento = {}, id = uuidv7()): Promise<string> {
  await tx`select public.gravar_produto_estoque(${ { id, nome: 'Perfume', categoriaId, atualizadoEm: CARIMBO, ...extras } }::jsonb)`
  return id
}
async function preparar(tx: SQL): Promise<{ clienteId: string; produtoId: string; categoriaId: string }> {
  const clienteId = uuidv7()
  await tx`insert into public.clientes(id,nome) values(${clienteId}::uuid,'Vera fictícia E-20')`
  const categoriaId = await categoria(tx)
  const produtoId = await produto(tx, categoriaId)
  return { clienteId, produtoId, categoriaId }
}
function manifesto(tipo: string, lancamentos: Documento[], movimentos: Documento[], extras: Documento = {}, id = uuidv7()): Grupo {
  return { operacao: { id, formato: 1, revisao: 1, tipo, dependencias: [],
    lancamentos: lancamentos.map((l) => ({ id: l['id'], revisao: 1 })),
    movimentos: movimentos.map((m) => ({ id: m['id'], revisao: m['revisao'] })), ...extras }, lancamentos, movimentos }
}
function compra(produtoId: string, quantidade = 10, extras: Documento = {}): Grupo {
  const id = uuidv7()
  return manifesto('movimento', [], [{ id: uuidv7(), revisao: 1, operacaoId: id, produtoId, data: DIA,
    tipo: 'compra', quantidade, conhecidos: [], ordemCadastro: '1792324800000', ...extras }], {}, id)
}
function venda(clienteId: string, produtoId: string, quantidade = 3, entregue = 1, pagamento = 'fiado'): Grupo {
  const id = uuidv7()
  const item = { id: uuidv7(), descricao: 'Perfume', produtoId, quantidade, precoUnitario: '3000', preco: String(BigInt(quantidade) * 3000n) }
  const lancamento = { id: uuidv7(), clienteId, data: DIA, tipo: 'venda', pagamento, itens: [item], desconto: '0',
    ...(pagamento === 'fiado' ? { parcelas: [{ id: uuidv7(), vencimento: DIA, valor: item.preco }] } : { forma: 'pix' }) }
  return manifesto('venda', [lancamento], entregue ? [{ id: uuidv7(), revisao: 1, operacaoId: id, produtoId,
    data: DIA, tipo: 'entrega', quantidade: entregue, itemId: item.id, conhecidos: [], custoUnitario: '0' }] : [], {}, id)
}
function movimentoDoItem(g: Grupo, tipo: 'entrega' | 'retorno', quantidade: number): Grupo {
  const original = g.movimentos[0]
  if (!original) throw new Error('a amostra precisa de uma entrega')
  const id = uuidv7()
  return manifesto(tipo, [], [{ id: uuidv7(), revisao: 1, operacaoId: id, produtoId: original['produtoId'], data: DIA,
    tipo, quantidade, itemId: original['itemId'], conhecidos: [] }], {}, id)
}
function cancelar(g: Grupo, retornos: Documento[] = []): Grupo {
  const alvo = g.lancamentos[0]
  if (!alvo) throw new Error('a amostra precisa de uma venda')
  const id = uuidv7()
  return manifesto('cancelamento', [{ id: uuidv7(), clienteId: alvo['clienteId'], data: DIA, tipo: 'estorno', estornaId: alvo['id'] }],
    retornos.map((m) => ({ ...m, operacaoId: id })), { alvo: { id: alvo['id'], revisao: 1 } }, id)
}
async function aceitar(tx: SQL, grupo: Grupo, evidencias: Documento[] = [], encerramentoId: string | null = null): Promise<string> {
  const [r] = await tx<{ posicao: string }[]>`select public.aceitar_grupo_estoque(${grupo}::jsonb,${evidencias}::jsonb,${encerramentoId}::uuid) as posicao`
  if (!r) throw new Error('RPC sem posição')
  return r.posicao
}
async function baixar(tx: SQL, apos = '0', limite = 500): Promise<Documento[]> {
  const r = await tx<{ registro: Documento }[]>`select public.baixar_estoque(${apos},${limite}) as registro`
  return r.map((l) => l.registro)
}
function encerramento(g: Grupo, aceitosConhecidos: Grupo[] = [], novaOperacao?: Grupo): Documento {
  return { id: uuidv7(), data: DIA, tentativa: { id: g.operacao['id'], revisao: g.operacao['revisao'], conteudo: JSON.stringify(g) },
    evidencia: { grupo: g, desfecho: 'recusada', diagnostico: '23514: tentativa recusada' }, aceitosConhecidos,
    ...(novaOperacao ? { novaOperacao } : {}) }
}
async function encerrar(tx: SQL, documento: Documento): Promise<Documento> {
  const [r] = await tx<{ resultado: Documento }[]>`select public.gravar_encerramento_estoque(${documento}::jsonb) resultado`
  if (!r) throw new Error('RPC sem encerramento')
  return r.resultado
}

describe.skipIf(!LIGADA)('estoque no Postgres: contrato E-20 sem passar pelo domínio', () => {
  test('categorias offline iguais conservam ids/vínculos; produto exige categoria da conta; LWW inteiro', async () => {
    await transacao(async (tx) => {
      const c1 = await categoria(tx)
      const c2 = await categoria(tx, ' perfumes ')
      const p1 = await produto(tx, c1, { custoManual: '9007199254740993', precoVenda: '0', estoqueMinimo: 0 })
      const p2 = await produto(tx, c2)
      await produto(tx, c1, { nome: 'Antigo', atualizadoEm: '2026-10-17T00:00:00Z' }, p1)
      expect(await tx<Documento[]>`select nome,custo_manual::text,preco_venda::text,estoque_minimo::text from public.produtos where id=${p1}::uuid`)
        .toEqual([{ nome: 'Perfume', custo_manual: '9007199254740993', preco_venda: '0', estoque_minimo: '0' }])
      await produto(tx, c2, { nome: 'Novo', atualizadoEm: '2026-10-19T00:00:00Z' }, p1)
      expect(await tx<Documento[]>`select categoria_id,custo_manual from public.produtos where id=${p1}::uuid`).toEqual([{ categoria_id: c2, custo_manual: null }])
      expect(await tx`select id from public.produtos where categoria_id=${c2}::uuid`).toHaveLength(2)
      expect((await recusa(tx, (sp) => produto(sp, uuidv7()))).startsWith('23')).toBe(true)
      await assumir(tx, B)
      expect(await tx`select id from public.produtos where id=${p2}::uuid`).toHaveLength(0)
      expect(await recusa(tx, (sp) => produto(sp, c1))).toBe('23503')
      expect(await recusa(tx, (sp) => produto(sp, c2, {}, p1))).toBe('23514')
    })
  })

  test('dinheiro fracionário/numérico, quantidade fracionária e custo negativo são recusados antes do cast', async () => {
    await transacao(async (tx) => {
      const { categoriaId, produtoId, clienteId } = await preparar(tx)
      for (const campo of ['custoManual', 'precoVenda']) for (const valor of ['39.9', '-1', 39.9, 3990]) {
        expect(await recusa(tx, (sp) => produto(sp, categoriaId, { [campo]: valor }))).toBe('23514')
      }
      for (const extra of [{ custoUnitario: '39.9' }, { custoUnitario: 3990 }, { quantidade: 1.5 }, { ordemCadastro: '1.5' }]) {
        expect(await recusa(tx, (sp) => aceitar(sp, compra(produtoId, 1, extra)))).toBe('23514')
      }
      const v = venda(clienteId, produtoId)
      const l = v.lancamentos[0]
      if (!l) throw new Error('sem venda')
      expect(await recusa(tx, (sp) => aceitar(sp, { ...v, lancamentos: [{ ...l, desconto: '0.5' }] }))).toBe('23514')
      expect(await baixar(tx)).toEqual([])
    })
  })

  test('venda/baixa são indivisíveis; manifesto incompleto e referência alheia não deixam sequer financeiro', async () => {
    await transacao(async (tx) => {
      const { produtoId, clienteId } = await preparar(tx)
      const v = venda(clienteId, produtoId)
      expect(await recusa(tx, (sp) => aceitar(sp, { ...v, movimentos: [] }), 'estoque_grupo_incompleto')).toBe('23514')
      await assumir(tx, B)
      const categoriaB = await categoria(tx)
      const produtoB = await produto(tx, categoriaB)
      await assumir(tx)
      const m = v.movimentos[0]
      if (!m) throw new Error('sem movimento')
      expect(await recusa(tx, (sp) => aceitar(sp, { ...v, movimentos: [{ ...m, produtoId: produtoB }] }))).toBe('23503')
      expect(await tx`select id from public.lancamentos`).toHaveLength(0)
      expect(await tx`select id from public.movimentos_estoque`).toHaveLength(0)
      expect(await baixar(tx)).toHaveLength(0)
      expect(await aceitar(tx, v)).toBe('1')
    })
  })

  test('reenvio idêntico não repete ids, baixa nem posição; conteúdo/revisão divergente é recusa', async () => {
    await transacao(async (tx) => {
      const { produtoId, clienteId } = await preparar(tx)
      const v = venda(clienteId, produtoId)
      expect(await aceitar(tx, v)).toBe('1')
      expect(await aceitar(tx, v)).toBe('1')
      const m = v.movimentos[0]
      if (!m) throw new Error('sem movimento')
      expect(await recusa(tx, (sp) => aceitar(sp, { ...v, movimentos: [{ ...m, quantidade: 2 }] }), 'estoque_conteudo_divergente')).toBe('23514')
      expect(await recusa(tx, (sp) => aceitar(sp, { ...v, operacao: { ...v.operacao, revisao: 2 } }))).toBe('23514')
      expect(await tx<Documento[]>`select count(*)::int n,count(distinct id)::int ids from public.movimentos_estoque`).toEqual([{ n: 1, ids: 1 }])
      expect(await baixar(tx)).toEqual([{ recepcao: '1', tipo: 'operacao', grupo: v, evidencias: [], encerramentoId: null }])
    })
  })

  test('sem RPC não há escrita F2; imutabilidade e grupo completo também valem para postgres', async () => {
    await transacao(async (tx) => {
      const { produtoId, clienteId } = await preparar(tx)
      const v = venda(clienteId, produtoId)
      await aceitar(tx, v)
      expect(await recusa(tx, (sp) => sp`insert into public.operacoes_estoque(id) values(${uuidv7()}::uuid)`)).toBe('42501')
      await tx.unsafe('reset role')
      for (const tabela of ['operacoes_estoque', 'movimentos_estoque', 'encerramentos_estoque']) {
        if (tabela === 'encerramentos_estoque') await encerrar(tx, encerramento(compra(produtoId)))
        expect(await recusa(tx, (sp) => sp.unsafe(`delete from public.${tabela}`), 'estoque_imutavel')).toBe('23514')
      }
      expect(await recusa(tx, (sp) => sp`update public.movimentos_estoque set quantidade=2 where operacao_id=${v.operacao['id']}::uuid`)).toBe('23514')
      const incompleta = compra(produtoId)
      expect(await recusa(tx, async (sp) => {
        await sp`insert into public.operacoes_estoque(id,dono,revisao,formato,tipo,lancamentos,movimentos,dependencias)
          values(${incompleta.operacao['id']}::uuid,${A}::uuid,1,1,'movimento','[]'::jsonb,${incompleta.operacao['movimentos']}::jsonb,'[]'::jsonb)`
        await sp.unsafe('set constraints all immediate')
      }, 'estoque_grupo_incompleto')).toBe('23514')
    })
  })

  test('F1 continua lendo total agregado (fiado/à vista); rota antiga estorna F1 mas recusa alvo F2', async () => {
    await transacao(async (tx) => {
      const { produtoId, clienteId } = await preparar(tx)
      const anterior = uuidv7()
      await tx`insert into public.lancamentos(id,cliente_id,data,tipo,pagamento,forma,itens,desconto)
        values(${anterior}::uuid,${clienteId}::uuid,${DIA}::date,'venda','avista','pix',${[{ descricao: 'Avulso F1', preco: '1200' }]}::jsonb,0)`
      for (const pagamento of ['fiado', 'avista']) {
        const v = venda(clienteId, produtoId, 3, 1, pagamento)
        await aceitar(tx, v)
        const [linha] = await tx`select id,cliente_id,data::text,tipo,pagamento,forma,itens,desconto::text,parcelas,
          valor::text,observacao,estorna_id,motivo from public.lancamentos where id=${v.lancamentos[0]?.['id']}::uuid`
        const antiga = lancamentoDaNuvem(linha)
        expect(antiga.tipo).toBe('venda')
        expect(saldo([antiga])).toBe(pagamento === 'fiado' ? 9000n : 0n)
        expect(await recusa(tx, (sp) => sp`insert into public.lancamentos(id,cliente_id,data,tipo,estorna_id)
          values(${uuidv7()}::uuid,${clienteId}::uuid,${DIA}::date,'estorno',${v.lancamentos[0]?.['id']}::uuid)`, 'estoque_grupo_obrigatorio')).toBe('23514')
      }
      await tx`insert into public.lancamentos(id,cliente_id,data,tipo,estorna_id)
        values(${uuidv7()}::uuid,${clienteId}::uuid,${DIA}::date,'estorno',${anterior}::uuid)`
      expect(await tx`select id from public.lancamentos where tipo='estorno'`).toHaveLength(1)
    })
  })

  test('entregas concorrentes distintas são preservadas, mesmo acima do vendido/físico; retorno respeita limite', async () => {
    await transacao(async (tx) => {
      const { produtoId, clienteId } = await preparar(tx)
      const v = venda(clienteId, produtoId, 1, 1)
      await aceitar(tx, v)
      await aceitar(tx, movimentoDoItem(v, 'entrega', 1))
      const cancelamento = cancelar(v)
      await aceitar(tx, cancelamento)
      const r1 = movimentoDoItem(v, 'retorno', 1)
      const r2 = movimentoDoItem(v, 'retorno', 1)
      await aceitar(tx, r1)
      await aceitar(tx, r2)
      await aceitar(tx, r1)
      expect(await recusa(tx, (sp) => aceitar(sp, movimentoDoItem(v, 'retorno', 1)), 'estoque_excede_retorno')).toBe('23514')
      expect(await tx<Documento[]>`select tipo,sum(quantidade)::text quantidade from public.movimentos_estoque group by tipo order by tipo`)
        .toEqual([{ tipo: 'entrega', quantidade: '2' }, { tipo: 'retorno', quantidade: '2' }])
    })
  })

  test('correções incompatíveis são recusadas inteiras, inclusive seu financeiro e retorno', async () => {
    await transacao(async (tx) => {
      const { produtoId, clienteId } = await preparar(tx)
      const v = venda(clienteId, produtoId)
      await aceitar(tx, v)
      const primeiro = cancelar(v)
      await aceitar(tx, primeiro)
      const concorrente = cancelar(v, movimentoDoItem(v, 'retorno', 1).movimentos)
      expect(await recusa(tx, (sp) => aceitar(sp, concorrente))).toBe('23505')
      expect(await tx`select id from public.lancamentos where tipo='estorno'`).toHaveLength(1)
      expect(await tx`select id from public.movimentos_estoque where tipo='retorno'`).toHaveLength(0)
      expect(await baixar(tx)).toHaveLength(2)
    })
  })

  test('revisão antiga nunca enviada é evidência, sem outra entrada ativa; base divergente é recusada', async () => {
    await transacao(async (tx) => {
      const { produtoId } = await preparar(tx)
      const p = compra(produtoId)
      const original = p.movimentos[0]
      if (!original) throw new Error('sem compra')
      const ref = { id: original['id'], revisao: 1 }
      const p2: Grupo = { ...p, operacao: { ...p.operacao, revisao: 2, movimentos: [{ ...ref, revisao: 2 }], dependencias: [ref] },
        movimentos: [{ ...original, revisao: 2, quantidade: 8, conhecidos: [ref] }] }
      await aceitar(tx, p2, [original])
      const id = uuidv7()
      const base = { ...ref, tipo: 'compra', quantidade: 10, aplicada: true, conhecidos: [] }
      const contagem = manifesto('movimento', [], [{ id: uuidv7(), revisao: 1, operacaoId: id, produtoId, data: DIA,
        tipo: 'contagem', totalContado: 7, motivo: 'conferencia', conhecidos: [ref], base: [base], resolvidas: [] }], { dependencias: [ref] }, id)
      await aceitar(tx, contagem)
      const m = contagem.movimentos[0]
      if (!m) throw new Error('sem contagem')
      const ruim = manifesto('movimento', [], [{ ...m, id: uuidv7(), base: [{ ...base, quantidade: 9 }] }])
      const novoId = ruim.operacao['id']
      ruim.movimentos = ruim.movimentos.map((mov) => ({ ...mov, operacaoId: novoId }))
      expect(await recusa(tx, (sp) => aceitar(sp, ruim), 'estoque_base_divergente')).toBe('23514')
      expect(await tx<Documento[]>`select count(*)::int n,sum(quantidade)::text quantidade from public.movimentos_estoque where tipo='compra'`).toEqual([{ n: 1, quantidade: '8' }])
    })
  })

  test('encerramento conserva versão aceita com mesmo id, evidência/restauração e idempotência', async () => {
    await transacao(async (tx) => {
      const { produtoId, clienteId } = await preparar(tx)
      const v = venda(clienteId, produtoId)
      await aceitar(tx, v)
      const divergente = { ...v, operacao: { ...v.operacao, revisao: 2 } }
      expect(await recusa(tx, (sp) => aceitar(sp, divergente))).toBe('23514')
      const doc = encerramento(divergente, [v])
      const resposta = await encerrar(tx, doc)
      expect(await encerrar(tx, doc)).toEqual(resposta)
      expect(await recusa(tx, (sp) => encerrar(sp, encerramento(v)), 'estoque_tentativa_aceita')).toBe('23514')
      const perdido = encerramento(compra(produtoId))
      perdido['evidencia'] = { grupo: compra(produtoId), desfecho: 'resposta-perdida', diagnostico: 'sem resposta' }
      expect(await recusa(tx, (sp) => encerrar(sp, perdido))).toBe('23514')
      const pagina = await baixar(tx)
      expect(pagina).toHaveLength(2)
      expect(pagina[0]?.['grupo']).toEqual(v)
      expect(pagina[1]?.['encerramento']).toEqual(doc)
      expect(await tx<Documento[]>`select count(*)::int n from public.lancamentos where tipo='venda'`).toEqual([{ n: 1 }])
      await assumir(tx, B)
      expect(await baixar(tx)).toEqual([])
      for (const tabela of ['categorias', 'produtos', 'operacoes_estoque', 'movimentos_estoque', 'encerramentos_estoque']) {
        expect(await tx.unsafe(`select id from public.${tabela}`)).toHaveLength(0)
        expect(await recusa(tx, async (sp) => {
          await sp.unsafe('set local role anon')
          await sp.unsafe(`select id from public.${tabela}`)
        })).toBe('42501')
      }
      expect(await recusa(tx, (sp) => encerrar(sp, doc))).toBe('23514')
    })
  })

  test('pagina por recepção inteira e não por hora; rollback libera posição e reenvio recupera resposta', async () => {
    await transacao(async (tx) => {
      const { produtoId } = await preparar(tx)
      const grupos = [compra(produtoId), compra(produtoId), compra(produtoId)]
      for (const g of grupos) await aceitar(tx, g)
      const p1 = await baixar(tx, '0', 2)
      expect(p1.map((r) => r['recepcao'])).toEqual(['1', '2'])
      expect((await baixar(tx, '2', 2)).map((r) => r['grupo'])).toEqual([grupos[2]])
      expect(await aceitar(tx, grupos[0] ?? compra(produtoId))).toBe('1')
      expect(await baixar(tx, '3')).toEqual([])
    })
  })

  test('causa cíclica, dependência alheia e identidade de parcela reutilizada são recusadas', async () => {
    await transacao(async (tx) => {
      const { produtoId, clienteId } = await preparar(tx)
      const ciclo = compra(produtoId)
      const primeiro = ciclo.movimentos[0]
      if (!primeiro) throw new Error('sem movimento')
      const segundo = { ...primeiro, id: uuidv7(), conhecidos: [{ id: primeiro['id'], revisao: 1 }] }
      ciclo.movimentos = [{ ...primeiro, conhecidos: [{ id: segundo.id, revisao: 1 }] }, segundo]
      ciclo.operacao['movimentos'] = ciclo.movimentos.map((m) => ({ id: m['id'], revisao: 1 }))
      expect(await recusa(tx, (sp) => aceitar(sp, ciclo), 'estoque_causa_ciclica')).toBe('23514')
      const v = venda(clienteId, produtoId)
      await aceitar(tx, v)
      const duplicada = venda(clienteId, produtoId)
      const original = v.lancamentos[0]
      const outra = duplicada.lancamentos[0]
      if (!original || !outra) throw new Error('sem venda')
      outra['parcelas'] = original['parcelas']
      expect(await recusa(tx, (sp) => aceitar(sp, duplicada), 'estoque_identidade_reutilizada')).toBe('23514')
      await assumir(tx, B)
      const baseB = await preparar(tx)
      const gB = compra(baseB.produtoId)
      await aceitar(tx, gB)
      await assumir(tx)
      const dependente = compra(produtoId)
      dependente.operacao['dependencias'] = [{ id: gB.operacao['id'], revisao: 1 }]
      expect(await recusa(tx, (sp) => aceitar(sp, dependente), 'estoque_dependencia_ausente')).toBe('23514')
      expect(await recusa(tx, async (sp) => {
        await sp.unsafe('set local role anon')
        await baixar(sp)
      })).toBe('42501')
    })
  })

  test('encerrar tentativa legada não cancela aceito; nova operação usa outros ids e pode sofrer nova recusa', async () => {
    await transacao(async (tx) => {
      const { produtoId, clienteId } = await preparar(tx)
      const v = venda(clienteId, produtoId)
      await aceitar(tx, v)
      const legada = cancelar(v)
      delete legada.operacao['alvo']
      expect(await recusa(tx, (sp) => aceitar(sp, legada))).toBe('23514')
      const reutilizada = encerramento(legada, [v], legada)
      expect(await recusa(tx, (sp) => encerrar(sp, reutilizada), 'estoque_identidade_reutilizada')).toBe('23514')
      const nova = cancelar(v)
      const doc = encerramento(legada, [v], nova)
      await encerrar(tx, doc)
      expect(await recusa(tx, (sp) => aceitar(sp, legada), 'estoque_tentativa_ja_encerrada')).toBe('23514')
      // O outro aparelho já cancelou. A resolução não remove nem repete esse financeiro.
      const aceita = cancelar(v)
      await aceitar(tx, aceita)
      expect(await recusa(tx, (sp) => aceitar(sp, nova, [], String(doc['id'])))).toBe('23505')
      expect(await encerrar(tx, doc)).toEqual({ id: doc['id'], recepcao: '2' })
      expect(await tx<Documento[]>`select count(*)::int n from public.lancamentos where tipo='estorno'`).toEqual([{ n: 1 }])
      expect(await baixar(tx)).toHaveLength(3)
    })
  })

  test('correção financeira preserva item/entrega/custo; correção de compra conserva ordem original', async () => {
    await transacao(async (tx) => {
      const { produtoId, clienteId } = await preparar(tx)
      const v = venda(clienteId, produtoId)
      await aceitar(tx, v)
      const velha = v.lancamentos[0]
      if (!velha) throw new Error('sem venda')
      const itemId = v.movimentos[0]?.['itemId']
      const nova = { ...velha, id: uuidv7(), itens: [{ id: itemId, descricao: 'Perfume', produtoId, quantidade: 3, precoUnitario: '3500', preco: '10500' }],
        parcelas: [{ id: uuidv7(), vencimento: DIA, valor: '10500' }] }
      const estorno = cancelar(v).lancamentos[0]
      if (!estorno) throw new Error('sem estorno')
      const correcao = manifesto('correcao', [nova, estorno], [], { alvo: { id: velha['id'], revisao: 1 } })
      await aceitar(tx, correcao)
      expect(await tx<Documento[]>`select quantidade::text,custo_unitario::text from public.movimentos_estoque where tipo='entrega'`)
        .toEqual([{ quantidade: '1', custo_unitario: '0' }])
      const p = compra(produtoId)
      await aceitar(tx, p)
      const origem = p.movimentos[0]
      if (!origem) throw new Error('sem compra')
      const alvo = { id: origem['id'], revisao: 1 }
      const id = uuidv7()
      const substituta = { ...origem, id: uuidv7(), operacaoId: id, quantidade: 8, compraOriginalId: origem['id'], conhecidos: [alvo] }
      const anulacao = { id: uuidv7(), revisao: 1, operacaoId: id, produtoId, tipo: 'anulacao', data: DIA, conhecidos: [alvo], alvo }
      const conserto = manifesto('correcao', [], [anulacao, substituta], { alvo }, id)
      expect(await recusa(tx, (sp) => aceitar(sp, { ...conserto, movimentos: [anulacao, { ...substituta, ordemCadastro: '1792324800001' }] }), 'estoque_ordem_original')).toBe('23514')
      await aceitar(tx, conserto)
    })
  })

  test('upgrade F1 → F2 preserva dados/saldo e a reversão tem alcance restrito aos dados F2', async () => {
    await transacao(async (tx) => {
      await tx.unsafe('reset role')
      const m = (await lerMigracoes()).find((m) => m.nome.startsWith('0004_'))
      if (!m) throw new Error('migration E-20 ausente')
      await tx.unsafe(m.reverter)
      await assumir(tx)
      const clienteId = uuidv7()
      await tx`insert into public.clientes(id,nome) values(${clienteId}::uuid,'Antes do upgrade')`
      const id = uuidv7()
      await tx`insert into public.lancamentos(id,cliente_id,data,tipo,pagamento,itens,desconto,parcelas)
        values(${id}::uuid,${clienteId}::uuid,${DIA}::date,'venda','fiado',${[{ descricao: 'F1 avulso', preco: '5000' }]}::jsonb,0,
          ${[{ id: uuidv7(), vencimento: DIA, valor: '5000' }]}::jsonb)`
      const antes = await tx<{ linha: Documento }[]>`select to_jsonb(l) linha from public.lancamentos l where id=${id}::uuid`
      await tx.unsafe('reset role')
      await tx.unsafe(m.aplicar)
      await assumir(tx)
      const depois = await tx<{ linha: Documento }[]>`select to_jsonb(l) linha from public.lancamentos l where id=${id}::uuid`
      expect(depois.map(({ linha: { operacao_estoque_id: _op, revisao_estoque: _rev, ...l } }) => ({ linha: l }))).toEqual(antes)
      const ficha: Lancamento[] = depois.map(({ linha }) => lancamentoDaNuvem({ ...linha, desconto: String(linha['desconto']) }))
      expect(saldo(ficha)).toBe(5000n)
    })
  })

  test('trava real até commit/rollback impede ultrapassar recepção; retentativa mantém a posição', async () => {
    for (const reverter of [false, true]) {
      const conta = uuidv7()
      const dados = await sql.begin(async (tx) => { await assumir(tx, conta); return preparar(tx) })
      const g1 = compra(dados.produtoId)
      const g2 = compra(dados.produtoId)
      await disputar(conta, g1, g2, reverter)
      await sql.begin(async (tx) => {
        await assumir(tx, conta)
        expect((await baixar(tx)).map((r) => r['grupo'])).toEqual(reverter ? [g2] : [g1, g2])
        expect(await aceitar(tx, g2)).toBe(reverter ? '1' : '2')
      })
    }
  })

  test('Q40 em conexões simultâneas: inverte chegada de cancelamentos e limita retornos sem meia gravação', async () => {
    for (const inversa of [false, true]) {
      const conta = uuidv7()
      const v = await sql.begin(async (tx) => {
        await assumir(tx, conta)
        const { produtoId, clienteId } = await preparar(tx)
        const g = venda(clienteId, produtoId, 1, 1)
        await aceitar(tx, g)
        return g
      })
      const g1 = cancelar(v, movimentoDoItem(v, 'retorno', 1).movimentos)
      const g2 = cancelar(v, movimentoDoItem(v, 'retorno', 1).movimentos)
      const primeiro = inversa ? g2 : g1
      const segundo = inversa ? g1 : g2
      expect(await disputar(conta, primeiro, segundo, false, true)).toBe('23505')
      await sql.begin(async (tx) => {
        await assumir(tx, conta)
        expect((await baixar(tx)).map((r) => r['grupo'])).toEqual([v, primeiro])
        expect(await tx<Documento[]>`select count(*)::int n from public.lancamentos where tipo='estorno'`).toEqual([{ n: 1 }])
      })
    }
    for (const segundaQuantidade of [1, 2]) {
      const conta = uuidv7()
      const v = await sql.begin(async (tx) => {
        await assumir(tx, conta)
        const { produtoId, clienteId } = await preparar(tx)
        const g = venda(clienteId, produtoId, 2, 2)
        await aceitar(tx, g)
        await aceitar(tx, cancelar(g))
        return g
      })
      const r1 = movimentoDoItem(v, 'retorno', 1)
      const r2 = movimentoDoItem(v, 'retorno', segundaQuantidade)
      expect(await disputar(conta, r1, r2, false, segundaQuantidade === 2)).toBe(segundaQuantidade === 2 ? '23514' : undefined)
    }
  })

  test('RPC real/PostgREST: centavos exatos, diagnóstico definitivo legado e resolução restaurável', async () => {
    const cliente = createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.VITE_SUPABASE_ANON_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    try {
      const login = await cliente.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '', password: process.env.SUPABASE_TESTE_SENHA ?? '' })
      if (login.error) throw new Error('login fictício de E-20 falhou')
      const clienteId = uuidv7()
      const categoriaId = uuidv7()
      const produtoId = uuidv7()
      expect((await cliente.from('clientes').insert({ id: clienteId, nome: 'Vera fictícia E-20' })).error).toBeNull()
      expect((await cliente.rpc('gravar_categoria_estoque', { cadastro: { id: categoriaId, nome: 'Perfumes E-20' } })).error).toBeNull()
      expect((await cliente.rpc('gravar_produto_estoque', { cadastro: { id: produtoId, nome: 'Perfume', categoriaId, atualizadoEm: CARIMBO, custoManual: '9007199254740993' } })).error).toBeNull()
      const v = venda(clienteId, produtoId)
      v.movimentos = v.movimentos.map((m) => ({ ...m, custoUnitario: '9007199254740993' }))
      const primeira = await cliente.rpc('aceitar_grupo_estoque', { grupo: v })
      expect(primeira.error).toBeNull()
      expect(typeof primeira.data).toBe('string')
      // Descartar a primeira resposta e reenviar não cria outro grupo nem outro número.
      expect((await cliente.rpc('aceitar_grupo_estoque', { grupo: v })).data).toBe(primeira.data)
      const legada = cancelar(v)
      const l = legada.lancamentos[0]
      if (!l) throw new Error('sem estorno')
      const antigo = criarNuvemSupabase(cliente)
      const resposta = await antigo.enviarLancamento(lancamentoParaNuvem({ tipo: 'estorno', id: String(l['id']),
        clienteId, data: DIA, estornaId: String(l['estornaId']) }))
      if (resposta.ok) throw new Error('a rota antiga aceitou metade da operação')
      expect(resposta.falha.tipo).toBe('recusa')
      if (resposta.falha.tipo === 'recusa') expect(resposta.falha.codigo).toBe('23514')
      delete legada.operacao['alvo']
      const nova = cancelar(v)
      const doc = encerramento(legada, [v], nova)
      expect((await cliente.rpc('gravar_encerramento_estoque', { encerramento: doc })).error).toBeNull()
      expect((await cliente.rpc('aceitar_grupo_estoque', { grupo: nova, encerramento_id: doc['id'] })).error).toBeNull()
      const { data, error } = await cliente.rpc('baixar_estoque', { apos: '0', limite: 500 })
      expect(error).toBeNull()
      expect(Array.isArray(data)).toBe(true)
      const linhas: Documento[] = data
      expect(linhas.map((r) => r['grupo'])).toContainEqual(v)
      expect(linhas.map((r) => r['encerramento'])).toContainEqual(doc)
      const custo = await cliente.from('produtos').select('custo_manual::text').eq('id', produtoId).single()
      expect(custo.data?.custo_manual).toBe('9007199254740993')
    } finally { await cliente.auth.signOut() }
  })
})

/** Espera uma trava observável no Postgres, sem usar tempo decorrido como prova de concorrência. */
async function disputar(conta: string, primeiro: Grupo, segundo: Grupo, rollback: boolean, deveRecusar = false): Promise<string | undefined> {
  const c1 = conectar()
  const c2 = conectar()
  let liberar: () => void = () => undefined
  let notificar: () => void = () => undefined
  let informarPid: (pid: number) => void = () => undefined
  const liberacao = new Promise<void>((resolve) => { liberar = resolve })
  const pronta = new Promise<void>((resolve) => { notificar = resolve })
  const pidPronto = new Promise<number>((resolve) => { informarPid = resolve })
  let p1: Promise<unknown> | undefined
  let p2: Promise<string | undefined> | undefined
  try {
    p1 = c1.begin(async (tx) => {
      await assumir(tx, conta)
      await aceitar(tx, primeiro)
      notificar()
      await liberacao
      if (rollback) throw new Revertida()
    }).catch((erro: unknown) => { if (!(erro instanceof Revertida)) throw erro })
    await Promise.race([pronta, p1.then(() => { throw new Error('primeira conexão terminou antes da disputa') })])
    p2 = c2.begin(async (tx) => {
      await assumir(tx, conta)
      const [r] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`
      if (!r) throw new Error('sem pid')
      informarPid(r.pid)
      await aceitar(tx, segundo)
      return undefined
    }).catch((erro: unknown) => {
      if (!deveRecusar || !(erro instanceof SQL.PostgresError)) throw erro
      return erro.errno ?? erro.code
    })
    const pid = await Promise.race([pidPronto, p2.then(() => { throw new Error('segunda conexão terminou sem informar pid') })])
    const ate = Date.now() + 10_000
    let bloqueada = false
    while (Date.now() < ate) {
      const [r] = await sql<{ bloqueada: boolean }[]>`select cardinality(pg_blocking_pids(${pid}))>0 bloqueada`
      if (r?.bloqueada) { bloqueada = true; break }
      await Bun.sleep(20)
    }
    expect(bloqueada).toBe(true)
    liberar()
    await p1
    return await p2
  } finally {
    liberar()
    await Promise.allSettled([p1, p2])
    await Promise.all([c1.close(), c2.close()])
  }
}
