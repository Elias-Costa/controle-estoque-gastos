import type { Centavos } from './dinheiro.ts'
import type { Dia, Id } from './ficha.ts'
import { quantidadeValida, type ResultadoEstoque } from './regras-estoque.ts'

/** Categoria criada no aparelho; nomes iguais não tornam duas identidades a mesma (D-058). */
export type Categoria = { readonly id: Id; readonly nome: string }

/** Valores opcionais aprovados em D-074; ausência não significa não se aplica. */
export type ClassificacaoProduto = 'feminino' | 'masculino' | 'unissex' | 'nao-se-aplica'

/** Confere o conjunto fechado sem deduzir classificação pelo nome/categoria (D-074). */
export function classificacaoProdutoValida(valor: unknown): valor is ClassificacaoProduto {
  return valor === 'feminino' || valor === 'masculino' || valor === 'unissex' || valor === 'nao-se-aplica'
}

/** Cadastro vencedor por LWW, inteiro; custo manual não é sobrescrito pela compra (Q48A). */
export type Produto = {
  readonly id: Id
  readonly nome: string
  readonly categoriaId: Id
  readonly marca?: string
  readonly classificacao?: ClassificacaoProduto
  readonly codigoCatalogo?: string
  readonly fotoId?: Id
  readonly custoManual?: Centavos
  readonly precoVenda?: Centavos
  readonly estoqueMinimo?: number
}

/** Compra já considerada válida pela projeção; id e ordem são os originais, mesmo após correção. */
export type ReferenciaCompra = {
  readonly id: Id
  readonly produtoId: Id
  readonly data: Dia
  readonly ordemCadastro: bigint
  readonly custoUnitario?: Centavos
}

function nomeComparavel(nome: string): string { return nome.trim().toLowerCase() }

/** Reutiliza uma categoria conhecida, sem equiparar sinônimos ou remover acentos (Q46A). */
export function novaCategoria(entrada: Categoria, conhecidas: readonly Categoria[]): ResultadoEstoque<Categoria> {
  const nome = entrada.nome.trim()
  if (!nome) return { ok: false, motivo: 'nome-obrigatorio' }
  const existente = conhecidas.find((categoria) => nomeComparavel(categoria.nome) === nomeComparavel(nome))
  if (existente) return { ok: true, valor: existente }
  if (!entrada.id || conhecidas.some((categoria) => categoria.id === entrada.id)) return { ok: false, motivo: 'id-repetido' }
  return { ok: true, valor: { ...entrada, nome } }
}

/** Identifica duplicatas concorrentes para aviso; não une categorias nem troca vínculos. */
export function categoriasComMesmoNome(categoria: Categoria, conhecidas: readonly Categoria[]): readonly Categoria[] {
  return conhecidas.filter((outra) => outra.id !== categoria.id && nomeComparavel(outra.nome) === nomeComparavel(categoria.nome))
}

/** Somente nome e categoria são campos obrigatórios; ausência de preço/mínimo difere de zero. */
export function novoProduto(entrada: Produto, categorias: readonly Categoria[]): ResultadoEstoque<Produto> {
  if (!entrada.id) return { ok: false, motivo: 'id-repetido' }
  if (!entrada.nome.trim()) return { ok: false, motivo: 'nome-obrigatorio' }
  if (!entrada.categoriaId) return { ok: false, motivo: 'categoria-obrigatoria' }
  if (!categorias.some((categoria) => categoria.id === entrada.categoriaId)) return { ok: false, motivo: 'categoria-inexistente' }
  if (entrada.classificacao !== undefined && !classificacaoProdutoValida(entrada.classificacao)) return { ok: false, motivo: 'classificacao-invalida' }
  if (entrada.custoManual !== undefined && (typeof entrada.custoManual !== 'bigint' || entrada.custoManual < 0n)) {
    return { ok: false, motivo: 'custo-invalido' }
  }
  if (entrada.precoVenda !== undefined && (typeof entrada.precoVenda !== 'bigint' || entrada.precoVenda < 0n)) {
    return { ok: false, motivo: 'preco-negativo' }
  }
  if (entrada.estoqueMinimo !== undefined && !quantidadeValida(entrada.estoqueMinimo)) return { ok: false, motivo: 'quantidade-invalida' }
  return { ok: true, valor: { ...entrada, nome: entrada.nome.trim() } }
}

/** Referência pela data do fato, ordem lógica e id original; compra sem custo vence como desconhecida. */
export function custoDoProduto(produto: Produto, comprasVigentes: readonly ReferenciaCompra[]): Centavos | undefined {
  let ultima: ReferenciaCompra | undefined
  for (const compra of comprasVigentes) {
    if (compra.produtoId !== produto.id) continue
    if (!ultima || compra.data > ultima.data || (compra.data === ultima.data && (
      compra.ordemCadastro > ultima.ordemCadastro || (compra.ordemCadastro === ultima.ordemCadastro && compra.id > ultima.id)
    ))) ultima = compra
  }
  return ultima ? ultima.custoUnitario : produto.custoManual
}

/** Havendo compra conhecida, o custo é corrigido na origem; sem ela, conserva-se o manual em LWW. */
export function alterarCustoManual(produto: Produto, custo: Centavos | undefined, comprasVigentes: readonly ReferenciaCompra[]): ResultadoEstoque<Produto> {
  if (comprasVigentes.some((compra) => compra.produtoId === produto.id)) return { ok: false, motivo: 'custo-definido-por-compra' }
  if (custo !== undefined && (typeof custo !== 'bigint' || custo < 0n)) return { ok: false, motivo: 'custo-invalido' }
  return { ok: true, valor: { ...produto, custoManual: custo } }
}

/** Q42: função pura; guardar o máximo e coordenar abas junto da escrita é responsabilidade de E-19. */
export function proximoCarimboDeCadastro(relogio: bigint, ultimo: bigint): bigint {
  return relogio > ultimo ? relogio : ultimo + 1n
}
