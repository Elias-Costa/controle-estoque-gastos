import { emReais, lerDinheiro } from '../dominio/dinheiro.ts'
import { classificacaoProdutoValida, novoProduto, type Categoria, type Produto } from '../dominio/produtos.ts'
import type { ResultadoEstoque } from '../dominio/regras-estoque.ts'

/** Texto editável: vazio não vira preço, custo ou mínimo zero (D-055). */
export type RascunhoDoProduto = {
  readonly nome: string; readonly categoriaId: string; readonly marca: string; readonly codigoCatalogo: string
  readonly custoTexto: string; readonly precoTexto: string; readonly minimoTexto: string
  readonly classificacao: string
}

/** Preenche só o cadastro; custo vindo de compra é mostrado separadamente, sem copiá-lo para o manual. */
export function rascunhoDoProduto(produto?: Produto): RascunhoDoProduto {
  return { nome: produto?.nome ?? '', categoriaId: produto?.categoriaId ?? '', marca: produto?.marca ?? '', classificacao: produto?.classificacao ?? '',
    codigoCatalogo: produto?.codigoCatalogo ?? '', custoTexto: produto?.custoManual === undefined ? '' : emReais(produto.custoManual).slice(3),
    precoTexto: produto?.precoVenda === undefined ? '' : emReais(produto.precoVenda).slice(3), minimoTexto: produto?.estoqueMinimo?.toString() ?? '' }
}

/** Confere o formulário sem conversão monetária para number e sem inventar campos opcionais. */
export function conferirProduto(rascunho: RascunhoDoProduto, categorias: readonly Categoria[], original?: Produto,
  custoDaCompra = false): ResultadoEstoque<Produto> {
  const custo = custoDaCompra ? original?.custoManual : rascunho.custoTexto === '' ? undefined : lerDinheiro(rascunho.custoTexto)
  const preco = rascunho.precoTexto === '' ? undefined : lerDinheiro(rascunho.precoTexto)
  const minimo = rascunho.minimoTexto === '' ? undefined : /^\d+$/.test(rascunho.minimoTexto) ? Number(rascunho.minimoTexto) : NaN
  if (custo === null) return { ok: false, motivo: 'custo-invalido' }
  if (preco === null) return { ok: false, motivo: 'preco-negativo' }
  if (rascunho.classificacao !== '' && !classificacaoProdutoValida(rascunho.classificacao)) return { ok: false, motivo: 'classificacao-invalida' }
  return novoProduto({ id: original?.id ?? 'novo', nome: rascunho.nome, categoriaId: rascunho.categoriaId,
    ...(rascunho.marca.trim() && { marca: rascunho.marca.trim() }),
    ...(classificacaoProdutoValida(rascunho.classificacao) && { classificacao: rascunho.classificacao }),
    ...(rascunho.codigoCatalogo.trim() && { codigoCatalogo: rascunho.codigoCatalogo.trim() }),
    ...(original?.fotoId && { fotoId: original.fotoId }),
    ...(custo !== undefined && { custoManual: custo }), ...(preco !== undefined && { precoVenda: preco }),
    ...(minimo !== undefined && { estoqueMinimo: minimo }) }, categorias)
}

function comparavel(texto: string): string { return texto.trim().toLowerCase() }

/** D-055, emenda de E-23: caixa/pontas apenas; marca e código precisam estar ambos preenchidos. */
export function produtosParecidos(entrada: Pick<Produto, 'nome' | 'marca' | 'codigoCatalogo'> & { readonly id?: string },
  produtos: readonly Produto[]): readonly Produto[] {
  const nome = comparavel(entrada.nome), marca = comparavel(entrada.marca ?? ''), codigo = comparavel(entrada.codigoCatalogo ?? '')
  return produtos.filter((produto) => produto.id !== entrada.id && ((nome !== '' && comparavel(produto.nome) === nome) ||
    (marca !== '' && codigo !== '' && comparavel(produto.marca ?? '') === marca && comparavel(produto.codigoCatalogo ?? '') === codigo)))
}
