import { multiplicar, repartir, somar } from './dinheiro.ts'
import { parcelas, totalDaVenda, validar, type Dia, type Id, type Lancamento } from './ficha.ts'
import { baseConhecida, projetarEstoque, registrarMovimentos, type MovimentoEstoque } from './estoque.ts'
import { custoDoProduto, type Produto } from './produtos.ts'
import { conteudoDoEfeito, quantidadeValida, type ResultadoEstoque } from './regras-estoque.ts'
import { situacaoDoItem, type GrupoEstoque, type IdentidadeOperacao, type ItemVendido, type VendaEstoque } from './vendas-estoque.ts'

/** Quantidade que realmente voltou; avulso altera só o financeiro (D-059). */
export type DevolucaoItem = { readonly itemId: Id; readonly quantidade: number }

/** Valores da substituição, sem lançar retorno ou alterar as entregas antigas. */
export function conferirTroca(venda: VendaEstoque, devolucoes: readonly DevolucaoItem[], novos: readonly ItemVendido[]) {
  const mantidos = venda.itens.flatMap((item) => {
    const quantidade = item.quantidade - (devolucoes.find((d) => d.itemId === item.id)?.quantidade ?? 0)
    return quantidade > 0 ? [{ ...item, quantidade, preco: multiplicar(item.precoUnitario, quantidade) }] : []
  })
  const brutoAnterior = somar(venda.itens.map((item) => item.preco))
  const brutoMantido = somar(mantidos.map((item) => item.preco))
  const desconto = brutoAnterior > 0n ? venda.desconto * brutoMantido / brutoAnterior : 0n
  const itens = [...mantidos, ...novos]
  const total = somar(itens.map((item) => item.preco)) - desconto
  return { itens, desconto, total, diferenca: total - totalDaVenda(venda) }
}

/** Fato posterior: estorno/substituição + retornos reais + saídas novas indivisíveis (D-059). */
export function prepararTrocaVenda(lancamentos: readonly Lancamento[], historico: readonly MovimentoEstoque[],
  original: VendaEstoque, produtos: readonly Produto[], entrada: {
    readonly operacao: IdentidadeOperacao; readonly data: Dia; readonly revisaoVenda: number
    readonly estornoId: Id; readonly vendaId: Id; readonly parcelaIds: readonly Id[]
    readonly devolucoes: readonly (DevolucaoItem & { readonly movimentoId: Id })[]
    readonly novos: readonly { readonly item: ItemVendido; readonly entregue: number; readonly movimentoId: Id }[]
  }): ResultadoEstoque<GrupoEstoque> {
  if (!lancamentos.some((l) => conteudoDoEfeito(l) === conteudoDoEfeito(original)) ||
    lancamentos.some((l) => l.tipo === 'estorno' && l.estornaId === original.id)) return { ok: false, motivo: 'alvo-invalido' }
  if (parcelas(lancamentos.filter((l) => l.clienteId === original.clienteId)).some((p) => p.debito.id === original.id && p.pago > 0n)) {
    return { ok: false, motivo: 'parcela-paga-alterada' }
  }
  if (!entrada.devolucoes.some((d) => d.quantidade > 0) || new Set(entrada.devolucoes.map((d) => d.itemId)).size !== entrada.devolucoes.length) {
    return { ok: false, motivo: 'quantidade-invalida' }
  }
  const movimentos: MovimentoEstoque[] = []
  for (const devolucao of entrada.devolucoes) {
    const item = original.itens.find((i) => i.id === devolucao.itemId)
    if (!item || !quantidadeValida(devolucao.quantidade) || devolucao.quantidade > item.quantidade) return { ok: false, motivo: 'excede-retorno' }
    if (!item.produtoId) continue
    const situacao = situacaoDoItem(item, historico, false)
    if (!situacao.ok) return situacao
    if (devolucao.quantidade > situacao.valor.podeRetornar) return { ok: false, motivo: 'excede-retorno' }
    if (devolucao.quantidade > 0) movimentos.push({ tipo: 'retorno', id: devolucao.movimentoId, revisao: 1,
      operacaoId: entrada.operacao.id, data: entrada.data, produtoId: item.produtoId, itemId: item.id,
      quantidade: devolucao.quantidade, conhecidos: baseConhecida(historico, item.produtoId) })
  }
  const antigos = new Set(lancamentos.flatMap((l) => l.tipo === 'venda' ? l.itens.flatMap((i) => i.id ? [i.id] : []) : []))
  for (const { item, entregue, movimentoId } of entrada.novos) {
    if (antigos.has(item.id) || !quantidadeValida(item.quantidade, 1) || !quantidadeValida(entregue) || entregue > item.quantidade) return { ok: false, motivo: 'item-invalido' }
    if (!item.produtoId) {
      if (entregue !== 0) return { ok: false, motivo: 'item-invalido' }
      continue
    }
    const produto = produtos.find((p) => p.id === item.produtoId)
    if (!produto) return { ok: false, motivo: 'produto-inexistente' }
    const projecao = projetarEstoque(historico, produto.id)
    if (!projecao.ok) return projecao
    if (entregue > 0) movimentos.push({ tipo: 'entrega', id: movimentoId, revisao: 1, operacaoId: entrada.operacao.id,
      produtoId: produto.id, itemId: item.id, quantidade: entregue, data: entrada.data,
      conhecidos: baseConhecida(historico, produto.id), custoUnitario: custoDoProduto(produto, projecao.valor.comprasVigentes) })
  }
  const conferencia = conferirTroca(original, entrada.devolucoes, entrada.novos.map((n) => n.item))
  if (conferencia.itens.length > 0 && conferencia.total <= 0n) return { ok: false, motivo: 'venda-gratuita' }
  const financeiros: Lancamento[] = [{ tipo: 'estorno', id: entrada.estornoId, clienteId: original.clienteId,
    data: entrada.data, estornaId: original.id }]
  if (conferencia.itens.length > 0) {
    const base = { ...original, id: entrada.vendaId, itens: conferencia.itens, desconto: conferencia.desconto }
    const valores = original.pagamento === 'fiado' ? repartir(conferencia.total, original.parcelas.length) : []
    financeiros.push(original.pagamento === 'fiado' ? { ...base, pagamento: 'fiado', parcelas: original.parcelas.map((p, i) =>
      ({ id: entrada.parcelaIds[i] ?? '', vencimento: p.vencimento, valor: valores[i] ?? 0n })) } : { ...base, pagamento: 'avista', forma: original.forma })
  }
  const ficha = validar([...lancamentos.filter((l) => l.clienteId === original.clienteId), ...financeiros])
  if (!ficha.ok) return ficha
  const fisicos = registrarMovimentos(historico, movimentos)
  if (!fisicos.ok) return fisicos
  return { ok: true, valor: { operacao: { ...entrada.operacao, formato: 1, tipo: 'troca',
    alvo: { id: original.id, revisao: entrada.revisaoVenda },
    lancamentos: financeiros.map((l) => ({ id: l.id, revisao: entrada.operacao.revisao })),
    movimentos: movimentos.map((m) => ({ id: m.id, revisao: m.revisao })) }, lancamentos: financeiros, movimentos } }
}
