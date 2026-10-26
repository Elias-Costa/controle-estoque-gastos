import type { RetratoDivulgacao } from '../dados/leitura-divulgacao.ts'
import type { Produto } from '../dominio/produtos.ts'
import { posicaoEstoque, projetarEstoque } from '../dominio/estoque.ts'
import { prometidoDoProduto } from '../dominio/vendas-estoque.ts'

/** Sem escolha não restringe; ausência continua distinta de não se aplica (D-074). */
export type FiltrosDivulgacao = { readonly categoria: string; readonly marca: string; readonly classificacao: string }
/** Posição derivada pelas mesmas funções da venda, sem saldo próprio da divulgação. */
export type LinhaDivulgacao = { readonly produto: Produto; readonly foto?: Uint8Array; readonly fisico: number; readonly prometido: number;
  readonly disponivel: number; readonly falta: number; readonly contagensAfetadas: boolean; readonly divergenciaFisica: boolean }
/** Seleção conferida: releitura preserva desmarcações e só informa resultados novos. */
export type PreviaDivulgacao = { readonly linhas: readonly LinhaDivulgacao[]; readonly desmarcados: readonly string[]; readonly novos: number; readonly alterada: boolean }
/** Conteúdo permitido no PDF; não transporta ficha, telefone, custo ou referências remotas. */
export type ItemPdfDivulgacao = { readonly nome: string; readonly marca?: string; readonly preco: bigint; readonly quantidade: number; readonly foto: Uint8Array }

/** Chave de marca conforme E-28A: pontas/caixa, sem remover acentos ou pontuação. */
export function chaveDaMarca(marca?: string): string { return marca?.trim() ? `marca:${marca.trim().toLowerCase()}` : 'sem-marca' }

/** RF-29/RN-06: interseção dos atributos e disponibilidade estritamente positiva. */
export function filtrarDivulgacao(retrato: RetratoDivulgacao, filtros: FiltrosDivulgacao): readonly LinhaDivulgacao[] {
  const fotos = new Map(retrato.miniaturas.map((foto) => [foto.fotoId, foto.binario]))
  return retrato.produtos.flatMap((produto) => {
    if (filtros.categoria && produto.categoriaId !== filtros.categoria || filtros.marca && chaveDaMarca(produto.marca) !== filtros.marca) return []
    if (filtros.classificacao && (filtros.classificacao === 'sem-classificacao' ? produto.classificacao !== undefined :
      produto.classificacao !== filtros.classificacao && !(['masculino', 'feminino'].includes(filtros.classificacao) && produto.classificacao === 'unissex'))) return []
    const estoque = projetarEstoque(retrato.movimentos, produto.id)
    const prometido = prometidoDoProduto(retrato.lancamentos, retrato.movimentos, produto.id)
    if (!estoque.ok || !prometido.ok) throw new Error('Estoque incompleto')
    const posicao = posicaoEstoque(estoque.valor.fisico, prometido.valor)
    if (!posicao.ok) throw new Error('Posição incompleta')
    return posicao.valor.disponivel > 0 ? [{ produto, foto: produto.fotoId ? fotos.get(produto.fotoId) : undefined,
      ...posicao.valor, contagensAfetadas: estoque.valor.contagensAfetadas.length > 0 }] : []
  }).sort((a, b) => a.produto.nome.localeCompare(b.produto.nome, 'pt-BR') || a.produto.id.localeCompare(b.produto.id))
}

/** Compara inclusive bytes/avisos, sem converter centavos ou confiar em referência de objeto. */
export function mesmasLinhasDivulgacao(a: readonly LinhaDivulgacao[], b: readonly LinhaDivulgacao[]): boolean {
  return a.length === b.length && a.every((linha, i) => {
    const outra = b[i]
    return outra !== undefined && linha.produto.id === outra.produto.id && linha.produto.nome === outra.produto.nome && linha.produto.marca === outra.produto.marca &&
      linha.produto.precoVenda === outra.produto.precoVenda && linha.produto.fotoId === outra.produto.fotoId && linha.produto.categoriaId === outra.produto.categoriaId &&
      linha.produto.classificacao === outra.produto.classificacao && linha.disponivel === outra.disponivel && linha.fisico === outra.fisico && linha.prometido === outra.prometido &&
      linha.contagensAfetadas === outra.contagensAfetadas && linha.divergenciaFisica === outra.divergenciaFisica &&
      linha.foto?.length === outra.foto?.length && (linha.foto?.every((byte, indice) => byte === outra.foto?.[indice]) ?? true)
  })
}

/** Releitura nunca acrescenta produtos silenciosamente nem remarca o que foi desmarcado. */
export function relerPreviaDivulgacao(previa: PreviaDivulgacao, atuais: readonly LinhaDivulgacao[]): PreviaDivulgacao {
  const ids = new Set(previa.linhas.map((linha) => linha.produto.id))
  const linhas = atuais.filter((linha) => ids.has(linha.produto.id))
  return { linhas, desmarcados: previa.desmarcados, novos: atuais.length - linhas.length,
    alterada: previa.alterada || !mesmasLinhasDivulgacao(previa.linhas, linhas) }
}

/** Permite zero informado, mas jamais substitui preço/foto ausentes por valores fabricados. */
export function itensPdfDivulgacao(linhas: readonly LinhaDivulgacao[]): readonly ItemPdfDivulgacao[] {
  if (!linhas.length) throw new Error('Escolha pelo menos um produto.')
  return linhas.map((linha) => {
    if (linha.produto.precoVenda === undefined || !linha.foto?.length) throw new Error('Complete a foto e o preço dos produtos ou desmarque o que falta.')
    return { nome: linha.produto.nome, marca: linha.produto.marca, preco: linha.produto.precoVenda, quantidade: linha.disponivel, foto: linha.foto }
  })
}
