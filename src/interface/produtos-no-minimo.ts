import type { EstadoLocalEstoque } from '../dados/repositorio-estoque.ts'
import { posicaoEstoque, projetarEstoque } from '../dominio/estoque.ts'
import { prometidoDoProduto } from '../dominio/vendas-estoque.ts'

/** RF-15/D-053: compara físico menos prometido, sem confundir mínimo vazio com zero. */
export function lerProdutosNoMinimo(estado: EstadoLocalEstoque) {
  return estado.produtos.flatMap((produto) => {
    if (produto.estoqueMinimo === undefined) return []
    const projecao = projetarEstoque(estado.movimentos, produto.id)
    const prometido = prometidoDoProduto(estado.lancamentos, estado.movimentos, produto.id)
    if (!projecao.ok || !prometido.ok) throw new Error('Estoque incompleto')
    const posicao = posicaoEstoque(projecao.valor.fisico, prometido.valor, produto.estoqueMinimo)
    if (!posicao.ok) throw new Error('Posição de estoque inválida')
    return posicao.valor.noMinimo ? [{ produto, ...posicao.valor, contagensAfetadas: projecao.valor.contagensAfetadas.length > 0 }] : []
  }).sort((a, b) => a.produto.nome.localeCompare(b.produto.nome, 'pt-BR') || a.produto.id.localeCompare(b.produto.id))
}
