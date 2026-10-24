import type { Centavos } from './dinheiro.ts'
import type { Dia, Id } from './ficha.ts'
import type { Correcao } from './lancamentos.ts'
import { diaValido, quantidadeValida } from './regras-estoque.ts'

/** Corte informado no fato, independente do texto livre da categoria (D-065). */
export type ClassificacaoCaixa = 'negocio' | 'pessoal'

/** A revisão corrente do fato, usada para conferir o alvo de uma correção (D-069). */
export type ReferenciaFatoCaixa = { readonly id: Id; readonly revisao: number }

type BaseFatoCaixa = ReferenciaFatoCaixa & { readonly data: Dia }
type DadosMovimentoCaixa = BaseFatoCaixa & {
  readonly valor: Centavos
  readonly categoria: string
  readonly classificacao: ClassificacaoCaixa
}

/** Dinheiro pago; mercadoria é uma identificação própria e exige negócio (RF-16). */
export type Despesa = DadosMovimentoCaixa & { readonly tipo: 'despesa'; readonly mercadoria: boolean }

/** Dinheiro recebido fora de venda/recebimento de ficha, sem cliente fictício (RF-17). */
export type ReceitaAvulsa = DadosMovimentoCaixa & { readonly tipo: 'receita-avulsa' }

/** Correção da anotação: referencia o alvo, sem copiar seu valor nem fabricar reembolso. */
export type EstornoCaixa = BaseFatoCaixa & { readonly tipo: 'estorno'; readonly alvo: ReferenciaFatoCaixa }

/** Os únicos fatos próprios do caixa; não ampliam Lancamento da ficha (D-069). */
export type FatoCaixa = Despesa | ReceitaAvulsa | EstornoCaixa

/** Dados de uma anotação nova ou corrigida; identidade vem do aparelho, revisão do domínio. */
export type EntradaMovimentoCaixa = Omit<Despesa, 'revisao'> | Omit<ReceitaAvulsa, 'revisao'>

/** Recusas do caixa em código; as palavras da tela pertencem à interface (RI-07). */
export type MotivoCaixa =
  | 'id-invalido' | 'id-repetido' | 'revisao-invalida' | 'data-invalida'
  | 'valor-invalido' | 'categoria-obrigatoria' | 'classificacao-invalida' | 'mercadoria-invalida'
  | 'tipo-invalido' | 'alvo-invalido' | 'ja-estornado' | 'ja-sincronizado' | 'tipo-diferente'
  | 'mes-invalido'

/** Resultado puro, sem gravação, fila ou confirmação de envio. */
export type ResultadoCaixa<T> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly motivo: MotivoCaixa }

function referenciaValida(ref: ReferenciaFatoCaixa): boolean {
  return !!ref.id.trim() && quantidadeValida(ref.revisao, 1)
}

/**
 * Confere a fotografia corrente de uma única conta: um registro por id (D-069).
 * O chamador separa contas e revisões antigas; isolamento real será exigido também no banco.
 */
export function validarFatosCaixa(fatos: readonly FatoCaixa[]): ResultadoCaixa<readonly FatoCaixa[]> {
  const porId = new Map<Id, FatoCaixa>()
  for (const fato of fatos) {
    if (!fato.id.trim()) return { ok: false, motivo: 'id-invalido' }
    if (!quantidadeValida(fato.revisao, 1)) return { ok: false, motivo: 'revisao-invalida' }
    if (porId.has(fato.id)) return { ok: false, motivo: 'id-repetido' }
    if (!diaValido(fato.data)) return { ok: false, motivo: 'data-invalida' }
    porId.set(fato.id, fato)
    switch (fato.tipo) {
      case 'despesa':
      case 'receita-avulsa':
        if (typeof fato.valor !== 'bigint' || fato.valor <= 0n) return { ok: false, motivo: 'valor-invalido' }
        if (!fato.categoria.trim()) return { ok: false, motivo: 'categoria-obrigatoria' }
        if (fato.classificacao !== 'negocio' && fato.classificacao !== 'pessoal') return { ok: false, motivo: 'classificacao-invalida' }
        if (fato.tipo === 'despesa' && (typeof fato.mercadoria !== 'boolean' || (fato.mercadoria && fato.classificacao !== 'negocio'))) {
          return { ok: false, motivo: 'mercadoria-invalida' }
        }
        break
      case 'estorno': break
      default: return { ok: false, motivo: 'tipo-invalido' }
    }
  }
  const estornados = new Set<Id>()
  for (const fato of fatos) {
    if (fato.tipo !== 'estorno') continue
    const alvo = porId.get(fato.alvo.id)
    if (!referenciaValida(fato.alvo) || !alvo || alvo.tipo === 'estorno' || alvo.revisao !== fato.alvo.revisao) {
      return { ok: false, motivo: 'alvo-invalido' }
    }
    if (estornados.has(alvo.id)) return { ok: false, motivo: 'ja-estornado' }
    estornados.add(alvo.id)
  }
  return { ok: true, valor: fatos }
}

function acrescentar<T extends FatoCaixa>(fatos: readonly FatoCaixa[], fato: T): ResultadoCaixa<T> {
  const resultado = validarFatosCaixa([...fatos, fato])
  return resultado.ok ? { ok: true, valor: fato } : resultado
}

/** Prepara despesa ou receita com centavos positivos, categoria livre e revisão inicial. */
export function registrarMovimentoCaixa(fatos: readonly FatoCaixa[], entrada: EntradaMovimentoCaixa): ResultadoCaixa<Despesa | ReceitaAvulsa> {
  return acrescentar(fatos, { ...entrada, revisao: 1, categoria: entrada.categoria.trim() })
}

/** Preserva o alvo e acrescenta somente a evidência da correção, sem movimento de dinheiro. */
export function estornarFatoCaixa(fatos: readonly FatoCaixa[], entrada: Omit<EstornoCaixa, 'tipo' | 'revisao'>): ResultadoCaixa<EstornoCaixa> {
  return acrescentar(fatos, { tipo: 'estorno', id: entrada.id, revisao: 1, data: entrada.data,
    alvo: { id: entrada.alvo.id, revisao: entrada.alvo.revisao } })
}

/** Substitui a versão local enquanto não enviada; a fila informa a janela (D-013). */
export function corrigirFatoCaixa(
  fatos: readonly FatoCaixa[], alvo: ReferenciaFatoCaixa, entrada: EntradaMovimentoCaixa, correcao: Correcao,
): ResultadoCaixa<Despesa | ReceitaAvulsa> {
  if (correcao.sincronizado) return { ok: false, motivo: 'ja-sincronizado' }
  const validacao = validarFatosCaixa(fatos)
  if (!validacao.ok) return validacao
  const original = fatos.find((fato) => fato.id === alvo.id)
  if (!original || original.tipo === 'estorno' || original.id !== entrada.id || original.revisao !== alvo.revisao) {
    return { ok: false, motivo: 'alvo-invalido' }
  }
  if (fatos.some((fato) => fato.tipo === 'estorno' && fato.alvo.id === original.id)) return { ok: false, motivo: 'ja-estornado' }
  if (original.tipo !== entrada.tipo) return { ok: false, motivo: 'tipo-diferente' }
  const substituto = { ...entrada, revisao: original.revisao + 1, categoria: entrada.categoria.trim() }
  const resultado = validarFatosCaixa(fatos.map((fato) => fato.id === original.id ? substituto : fato))
  return resultado.ok ? { ok: true, valor: substituto } : resultado
}

/** Efeitos inseparáveis de uma correção após envio; E-31/32 implementarão a gravação conjunta. */
export type CorrecaoCaixa = {
  readonly alvo: ReferenciaFatoCaixa
  readonly estorno: EstornoCaixa
  readonly substituto: Despesa | ReceitaAvulsa
}

/** Prepara estorno/substituição sem alterar o histórico; não confirma atomicidade de armazenamento. */
export function prepararCorrecaoCaixa(
  fatos: readonly FatoCaixa[], alvo: ReferenciaFatoCaixa,
  entrada: { readonly estornoId: Id; readonly dataCorrecao: Dia; readonly substituto: EntradaMovimentoCaixa },
): ResultadoCaixa<CorrecaoCaixa> {
  const estorno = estornarFatoCaixa(fatos, { id: entrada.estornoId, data: entrada.dataCorrecao, alvo })
  if (!estorno.ok) return estorno
  const substituto = registrarMovimentoCaixa([...fatos, estorno.valor], entrada.substituto)
  if (!substituto.ok) return substituto
  return { ok: true, valor: { alvo: { id: alvo.id, revisao: alvo.revisao }, estorno: estorno.valor, substituto: substituto.valor } }
}
