import { baseConhecida, projetarEstoque, type ReferenciaEfeito, type CompraEstoque, type SaidaEstoque, type ContagemEstoque } from '../dominio/estoque.ts'
import type { Venda } from '../dominio/ficha.ts'
import { ehVendaEstoque, prepararCancelamento, prepararCorrecaoVenda, prepararEntrega, prepararMovimentosEstoque,
  prepararRetorno, prepararVendaEstoque, type GrupoEstoque, type IdentidadeOperacao, type VendaEstoque } from '../dominio/vendas-estoque.ts'
import { novaContagem } from '../dominio/estoque.ts'
import { prepararTrocaVenda } from '../dominio/trocas-venda.ts'
import type { ResultadoEstoque } from '../dominio/regras-estoque.ts'
import { uuidv7 } from './identidade.ts'
import type { EstadoLocalEstoque } from './repositorio-estoque.ts'

function referencia(estado: EstadoLocalEstoque, venda: Venda): ReferenciaEfeito {
  return estado.operacoes.flatMap((o) => o.lancamentos).find((r) => r.id === venda.id) ?? { id: venda.id, revisao: 1 }
}
function novaOcorrencia(venda: VendaEstoque, preservarItens: boolean): VendaEstoque {
  const base = { ...venda, id: uuidv7(), itens: venda.itens.map((i) => ({ ...i, id: preservarItens ? i.id : uuidv7() })) }
  return venda.pagamento === 'fiado' ? { ...base, pagamento: 'fiado', parcelas: venda.parcelas.map((p) => ({ ...p, id: uuidv7() })) }
    : { ...base, pagamento: 'avista', forma: venda.forma }
}

/** Nova confirmação sobre o estado sem a tentativa; cada ramo usa a preparação completa de domínio (Q47A). */
export function prepararIntencaoRecusada(estado: EstadoLocalEstoque, recusado: GrupoEstoque, data: string,
  quantidades: Readonly<Record<string, number>>): ResultadoEstoque<GrupoEstoque> {
  const operacao: IdentidadeOperacao = { id: uuidv7(), revisao: 1, dependencias: [] }
  const vendas = estado.lancamentos.filter((l): l is VendaEstoque => l.tipo === 'venda' && ehVendaEstoque(l))
  const vendaRecusada = recusado.lancamentos.find((l): l is VendaEstoque => l.tipo === 'venda' && ehVendaEstoque(l))
  const estorno = recusado.lancamentos.find((l) => l.tipo === 'estorno')
  const alvoId = recusado.operacao.alvo?.id ?? (estorno?.tipo === 'estorno' ? estorno.estornaId : undefined)
  const alvo = vendas.find((v) => v.id === alvoId)
  const cancelada = alvo && estado.lancamentos.some((l) => l.tipo === 'estorno' && l.estornaId === alvo.id)
  if (recusado.operacao.tipo === 'cancelamento' && alvo) {
    const entrada = { operacao: { ...operacao, dependencias: [referencia(estado, alvo)] }, data,
      retornos: alvo.itens.filter((i) => i.produtoId).map((i) => ({ itemId: i.id, quantidade: quantidades[i.id] ?? 0, movimentoId: uuidv7() })) }
    return cancelada ? prepararRetorno(estado.lancamentos, estado.movimentos, alvo, entrada)
      : prepararCancelamento(estado.lancamentos, estado.movimentos, alvo, { ...entrada, estornoId: uuidv7(), revisaoVenda: referencia(estado, alvo).revisao })
  }
  if (recusado.operacao.tipo === 'retorno') {
    const venda = vendas.find((v) => v.itens.some((i) => recusado.movimentos.some((m) => m.tipo === 'retorno' && m.itemId === i.id)) &&
      estado.lancamentos.some((l) => l.tipo === 'estorno' && l.estornaId === v.id))
    if (!venda) return { ok: false, motivo: 'alvo-invalido' }
    return prepararRetorno(estado.lancamentos, estado.movimentos, venda, { operacao, data,
      retornos: recusado.movimentos.flatMap((m) => m.tipo === 'retorno' ? [{ itemId: m.itemId, quantidade: quantidades[m.itemId] ?? 0, movimentoId: uuidv7() }] : []) })
  }
  if (recusado.operacao.tipo === 'entrega') {
    const entrega = recusado.movimentos[0]
    const venda = entrega?.tipo === 'entrega' ? vendas.find((v) => v.itens.some((i) => i.id === entrega.itemId) &&
      !estado.lancamentos.some((l) => l.tipo === 'estorno' && l.estornaId === v.id)) : undefined
    const produto = estado.produtos.find((p) => p.id === entrega?.produtoId)
    if (!venda || !produto || entrega?.tipo !== 'entrega') return { ok: false, motivo: 'alvo-invalido' }
    return prepararEntrega(estado.lancamentos, estado.movimentos, venda, { operacao: { ...operacao, dependencias: [referencia(estado, venda)] },
      id: uuidv7(), data, itemId: entrega.itemId, quantidade: quantidades[entrega.itemId] ?? 0 }, produto)
  }
  if (recusado.operacao.tipo === 'venda' && vendaRecusada) {
    const nova = novaOcorrencia(vendaRecusada, false)
    return prepararVendaEstoque(estado.lancamentos, estado.movimentos, nova, operacao, estado.produtos, nova.itens.map((i, indice) => ({
      itemId: i.id, quantidade: quantidades[vendaRecusada.itens[indice]?.id ?? ''] ?? 0, movimentoId: uuidv7() })))
  }
  if (recusado.operacao.tipo === 'correcao' && alvo && vendaRecusada) {
    const nova = novaOcorrencia(vendaRecusada, true)
    return prepararCorrecaoVenda(estado.lancamentos, estado.movimentos, alvo, nova, { operacao: { ...operacao, dependencias: [referencia(estado, alvo)] },
      revisaoOriginal: referencia(estado, alvo).revisao, sincronizado: true, estornoId: uuidv7(), data,
      natureza: 'anotacao', entregas: recusado.movimentos.flatMap((m) => {
        if (m.tipo !== 'anulacao') return []
        const anterior = estado.movimentos.find((e) => e.id === m.alvo.id && e.revisao === m.alvo.revisao)
        const substituto = recusado.movimentos.find((e) => e.tipo === 'entrega' && anterior?.tipo === 'entrega' && e.itemId === anterior.itemId)
        return anterior?.tipo === 'entrega' && substituto?.tipo === 'entrega' ? [{ alvo: m.alvo,
          anulacao: { ...m, id: uuidv7(), operacaoId: operacao.id, revisao: 1, conhecidos: baseConhecida(estado.movimentos, m.produtoId) },
          substituto: { ...substituto, id: uuidv7(), operacaoId: operacao.id, revisao: 1, conhecidos: baseConhecida(estado.movimentos, substituto.produtoId) } }] : []
      }) })
  }
  if (recusado.operacao.tipo === 'troca' && alvo) {
    const novos = vendaRecusada?.itens.filter((i) => !alvo.itens.some((a) => a.id === i.id)) ?? []
    return prepararTrocaVenda(estado.lancamentos, estado.movimentos, alvo, estado.produtos, { operacao, data,
      revisaoVenda: referencia(estado, alvo).revisao, estornoId: uuidv7(), vendaId: uuidv7(),
      parcelaIds: alvo.pagamento === 'fiado' ? alvo.parcelas.map(() => uuidv7()) : [],
      devolucoes: alvo.itens.map((i) => ({ itemId: i.id, quantidade: quantidades[i.id] ?? 0, movimentoId: uuidv7() })),
      novos: novos.map((i) => ({ item: { ...i, id: uuidv7() }, entregue: quantidades[i.id] ?? 0, movimentoId: uuidv7() })) })
  }
  // Movimentos sem financeiro também podem precisar de nova confirmação após Q47A.
  if (recusado.operacao.tipo === 'movimento') {
    const movimentos: (CompraEstoque | SaidaEstoque | ContagemEstoque)[] = []
    for (const m of recusado.movimentos) {
      const base = { id: uuidv7(), revisao: 1, operacaoId: operacao.id, produtoId: m.produtoId, data,
        conhecidos: baseConhecida(estado.movimentos, m.produtoId) }
      if (m.tipo === 'compra') movimentos.push({ ...m, ...base, ordemCadastro: estado.carimbo, compraOriginalId: undefined })
      if (m.tipo === 'saida') movimentos.push({ ...m, ...base })
      if (m.tipo === 'contagem') {
        const contagem = novaContagem(estado.movimentos, { id: base.id, revisao: 1, operacaoId: operacao.id,
          produtoId: m.produtoId, data, totalContado: m.totalContado, motivo: m.motivo })
        if (!contagem.ok) return contagem
        movimentos.push(contagem.valor)
      }
    }
    const produtosValidos = movimentos.every((m) => projetarEstoque(estado.movimentos, m.produtoId).ok)
    if (!produtosValidos) return { ok: false, motivo: 'base-invalida' }
    return prepararMovimentosEstoque(estado.movimentos, operacao, movimentos)
  }
  return { ok: false, motivo: 'alvo-invalido' }
}
