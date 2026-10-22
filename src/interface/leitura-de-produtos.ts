import type { CatalogoProdutos } from '../dados/repositorio-estoque.ts'
import { projetarEstoque } from '../dominio/estoque.ts'
import { custoDoProduto, categoriasComMesmoNome, type Categoria, type Produto } from '../dominio/produtos.ts'

/** Cadastro e custo derivado; a referência manual permanece intacta mesmo havendo compras. */
export type LinhaProduto = {
  readonly produto: Produto
  readonly categoria: Categoria
  readonly miniatura?: Uint8Array
  readonly custo?: bigint
  readonly custoDaCompra: boolean
}

/** Lê a referência de custo pelas regras de D-018/Q48A, inclusive compra sem custo e anulação. */
export function lerProdutos(catalogo: CatalogoProdutos): readonly LinhaProduto[] {
  const categorias = new Map(catalogo.categorias.map((categoria) => [categoria.id, categoria]))
  const miniaturas = new Map(catalogo.miniaturas.map((foto) => [foto.fotoId, foto.binario]))
  return catalogo.produtos.map((produto) => {
    const categoria = categorias.get(produto.categoriaId)
    const projecao = projetarEstoque(catalogo.movimentos, produto.id)
    if (!categoria || !projecao.ok) throw new Error('Não foi possível ler o produto completo')
    return { produto, categoria, miniatura: produto.fotoId ? miniaturas.get(produto.fotoId) : undefined,
      custo: custoDoProduto(produto, projecao.valor.comprasVigentes), custoDaCompra: projecao.valor.comprasVigentes.length > 0 }
  }).sort((a, b) => a.produto.nome.localeCompare(b.produto.nome, 'pt-BR') || a.produto.id.localeCompare(b.produto.id))
}

/** Só diferencia opções concorrentes na apresentação; nunca renomeia nem muda o vínculo (Q46A). */
export function rotuloDaCategoria(categoria: Categoria, categorias: readonly Categoria[]): string {
  const iguais = [categoria, ...categoriasComMesmoNome(categoria, categorias)].sort((a, b) => a.id.localeCompare(b.id))
  return iguais.length === 1 ? categoria.nome : `${categoria.nome} (${iguais.findIndex((item) => item.id === categoria.id) + 1})`
}
