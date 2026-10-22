import type { EntradaMovimentoLocal } from '../dados/operacoes-estoque.ts'
import type { ContagemEstoque, SaidaEstoque } from '../dominio/estoque.ts'
import type { ResultadoEstoque } from '../dominio/regras-estoque.ts'
import { conferirEntrada } from './rascunho-da-entrada.ts'

/** RF-14: os quatro motivos de saída e a conferência pelo total físico contado. */
export type MotivoDoAjuste = SaidaEstoque['motivo'] | 'conferencia'

/** Uma contagem corrigida conserva a base original; uma nova conferência recebe outra base. */
export type AjusteDeEstoque = SaidaEstoque | ContagemEstoque

/** Motivo começa vazio para não transformar uma escolha automática em fato físico. */
export type RascunhoDoAjuste = {
  readonly produtoId: string; readonly motivo: MotivoDoAjuste | ''
  readonly quantidadeTexto: string; readonly data: string
}

/** Reabre motivo, quantidade e data anotados, sem substituir uma contagem pela posição atual. */
export function rascunhoDoAjuste(produtoId: string, hoje: string, original?: AjusteDeEstoque, conferir = false): RascunhoDoAjuste {
  return { produtoId: original?.produtoId ?? produtoId, data: original?.data ?? hoje,
    motivo: original?.tipo === 'saida' ? original.motivo : original || conferir ? 'conferencia' : '',
    quantidadeTexto: original ? String(original.tipo === 'saida' ? original.quantidade : original.totalContado) : '' }
}

/** Confere motivo e reaproveita as guardas de quantidade/calendário da entrada, sem dinheiro. */
export function conferirAjuste(rascunho: RascunhoDoAjuste, hoje: string): ResultadoEstoque<EntradaMovimentoLocal> {
  const motivo = rascunho.motivo
  if (!['perda', 'quebra', 'uso-pessoal', 'brinde', 'conferencia'].includes(motivo)) return { ok: false, motivo: 'motivo-obrigatorio' }
  const conferencia = conferirEntrada({ ...rascunho, custoTexto: '' }, motivo === 'conferencia' ? 'estoque-inicial' : 'compra', hoje)
  if (!conferencia.ok) return conferencia
  const entrada = conferencia.valor.entrada
  if (entrada.tipo === 'contagem') return { ok: true, valor: { ...entrada, motivo: 'conferencia' } }
  if (entrada.tipo === 'compra' && motivo !== '' && motivo !== 'conferencia') return { ok: true, valor: {
    tipo: 'saida', produtoId: entrada.produtoId, data: entrada.data, quantidade: entrada.quantidade, motivo,
  } }
  return { ok: false, motivo: 'motivo-obrigatorio' }
}

/** Diferença da anotação, não saldo guardado: correção de contagem usa sua base observada (Q39). */
export function efeitoDoAjuste(entrada: EntradaMovimentoLocal, fisico: number, original?: AjusteDeEstoque): number {
  if (entrada.tipo === 'saida') return -entrada.quantidade
  if (entrada.tipo !== 'contagem') return 0
  const base = original?.tipo === 'contagem'
    ? original.base.reduce((total, item) => total + (item.aplicada ? item.quantidade : 0), 0) : fisico
  return entrada.totalContado - base
}
