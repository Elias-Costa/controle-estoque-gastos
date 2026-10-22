import type { ItemVendaLocal } from '../dados/operacoes-estoque.ts'
import type { EstadoLocalEstoque } from '../dados/repositorio-estoque.ts'
import { multiplicar } from '../dominio/dinheiro.ts'
import type { Venda } from '../dominio/ficha.ts'
import { posicaoEstoque, projetarEstoque } from '../dominio/estoque.ts'
import type { Produto } from '../dominio/produtos.ts'
import { prometidoDoProduto, sugerirEntrega } from '../dominio/vendas-estoque.ts'
import { conferir, rascunhoDaVenda, textoDeCentavos, type ItemDoRascunho, type Rascunho } from './rascunho-da-venda.ts'

/** Texto editável; ausência de entregueTexto mantém a sugestão até ela informar o fato. */
export type ItemComEstoque = ItemDoRascunho & { readonly id?: string; readonly produtoId?: string;
  readonly quantidadeTexto?: string; readonly entregueTexto?: string }
/** O financeiro continua usando o mesmo formulário de parcelas de F1. */
export type RascunhoComEstoque = Omit<Rascunho, 'itens'> & { readonly itens: readonly ItemComEstoque[] }

/** Inteiro seguro de quantidade, distinto de vazio ou texto fracionário. */
export function lerQuantidade(texto: string): number | null {
  if (!/^\d+$/.test(texto.trim())) return null
  const valor = Number(texto)
  return Number.isSafeInteger(valor) ? valor : null
}

/** Cadastro preenche somente o preço de venda, preservando vazio e zero explícito (D-055). */
export function selecionarProduto(item: ItemComEstoque, produto: Produto): ItemComEstoque {
  return { ...item, produtoId: produto.id, descricao: produto.nome, quantidadeTexto: item.quantidadeTexto ?? '1',
    precoTexto: produto.precoVenda === undefined ? '' : textoDeCentavos(produto.precoVenda), entregueTexto: undefined }
}

/** Físico, promessa e falta separados; piso zero só na disponibilidade apresentada (D-017). */
export function disponibilidade(estado: EstadoLocalEstoque, produtoId: string) {
  const projecao = projetarEstoque(estado.movimentos, produtoId)
  const prometido = prometidoDoProduto(estado.lancamentos, estado.movimentos, produtoId)
  if (!projecao.ok || !prometido.ok) throw new Error('Estoque incompleto')
  const posicao = posicaoEstoque(projecao.valor.fisico, prometido.valor)
  if (!posicao.ok) throw new Error('Posição de estoque inválida')
  return posicao.valor
}

/** Sugestão não escreve; itens repetidos na mesma venda compartilham o disponível. */
export function conferirVendaComEstoque(rascunho: RascunhoComEstoque, estado: EstadoLocalEstoque, dia: string, permitirTotalZero = false) {
  const usados = new Map<string, number>()
  const itens: ItemVendaLocal[] = []
  let erro: string | undefined
  const linhas = rascunho.itens.map((item) => {
    const quantidade = lerQuantidade(item.quantidadeTexto ?? '1')
    const preenchido = !!item.produtoId || item.descricao.trim() !== '' || item.precoTexto.trim() !== ''
    if (preenchido && (quantidade === null || quantidade < 1)) erro = 'Informe uma quantidade inteira maior que zero.'
    let entregue = 0
    if (item.produtoId) {
      const disponivel = disponibilidade(estado, item.produtoId).disponivel - (usados.get(item.produtoId) ?? 0)
      entregue = item.entregueTexto === undefined ? sugerirEntrega(quantidade ?? 0, disponivel) : lerQuantidade(item.entregueTexto) ?? -1
      if (entregue < 0 || entregue > (quantidade ?? 0)) erro = 'Confira quantas unidades foram entregues agora.'
      usados.set(item.produtoId, (usados.get(item.produtoId) ?? 0) + Math.max(entregue, 0))
    }
    const financeira = conferir({ ...rascunho, pagamento: 'avista', itens: [{ descricao: item.descricao, precoTexto: item.precoTexto }], descontoTexto: '' }, dia)
    const unitario = financeira.itensDaVenda[0]?.preco
    if (preenchido && unitario !== undefined && quantidade !== null && quantidade > 0) itens.push({ id: item.id, produtoId: item.produtoId,
      descricao: item.descricao.trim(), quantidade, precoUnitario: unitario, entregue })
    return { descricao: item.descricao, precoTexto: unitario === undefined ? item.precoTexto : textoDeCentavos(multiplicar(unitario, quantidade !== null && quantidade > 0 ? quantidade : 1)),
      quantidade, entregue, pendente: item.produtoId ? (quantidade ?? 0) - entregue : 0 }
  })
  const financeira = conferir({ ...rascunho, itens: linhas }, dia)
  if (!permitirTotalZero && itens.length > 0 && financeira.total === 0n && !financeira.guardas.some((g) => g === 'falta-preco' || g === 'preco-ilegivel')) {
    erro = 'A venda precisa ter valor maior que zero. Se tudo for brinde, anote uma saída por brinde no estoque.'
  }
  return { ...financeira, itensLocais: itens, linhas, erro }
}

/** Preço unitário na edição F2; o campo legado continua total da linha (D-057). */
export function rascunhoComEstoque(venda: Venda): RascunhoComEstoque {
  return { ...rascunhoDaVenda(venda), itens: venda.itens.map((i) => ({ id: i.id, produtoId: i.produtoId,
    descricao: i.descricao, quantidadeTexto: String(i.quantidade ?? 1), precoTexto: textoDeCentavos(i.precoUnitario ?? i.preco) })) }
}
