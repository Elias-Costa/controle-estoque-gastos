import type { Id } from '../dominio/ficha.ts'
import type { FatoCaixa, ReferenciaFatoCaixa } from '../dominio/gastos.ts'
import type { ItemDaFila, Problema } from './banco.ts'

/** Unidade indivisível de gravação/envio, separada dos grupos de estoque (D-069). */
export type OperacaoCaixa = {
  readonly id: Id
  readonly formato: 1
  readonly revisao: number
  readonly tipo: 'registro' | 'estorno' | 'correcao'
  readonly alvo?: ReferenciaFatoCaixa
  readonly fatos: readonly ReferenciaFatoCaixa[]
}

/** Conteúdo completo de uma versão; correção sempre leva estorno e substituto juntos. */
export type GrupoCaixa = { readonly operacao: OperacaoCaixa; readonly fatos: readonly FatoCaixa[] }

/** O manifesto aponta à fotografia vigente sem duplicar fatos editáveis (D-040/069). */
export type OperacaoCaixaLocal = OperacaoCaixa & { readonly versaoId: Id }

/** Evidência preservada inclusive após edição local ou resposta atrasada (RI-03). */
export type VersaoCaixa = {
  readonly id: Id
  readonly operacaoId: Id
  readonly grupo: GrupoCaixa
  readonly aceita?: boolean
  readonly problema?: Problema
}

/** Captura consistente, sem rede; o resultado vale apenas para esta versão da fila. */
export type EnvioCaixa = { readonly item: ItemDaFila; readonly versao: VersaoCaixa }
