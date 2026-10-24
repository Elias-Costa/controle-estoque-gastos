import type { EntradaCaixaLocal } from '../dados/operacoes-caixa.ts'
import { lerDinheiro } from '../dominio/dinheiro.ts'
import type { Despesa, ReceitaAvulsa, ResultadoCaixa } from '../dominio/gastos.ts'
import { diaValido } from '../dominio/regras-estoque.ts'
import { textoDeCentavos } from './rascunho-da-venda.ts'

/** Campos de RF-16/17; classificação começa vazia para não atribuir natureza por suposição. */
export type RascunhoDoCaixa = {
  readonly valorTexto: string; readonly data: string; readonly categoria: string
  readonly classificacao: '' | 'negocio' | 'pessoal'; readonly mercadoria: boolean
}

/** Preenche correção com a revisão lida, usando a mesma máscara de dinheiro do restante do app. */
export function rascunhoDoCaixa(fato?: Despesa | ReceitaAvulsa, hoje = ''): RascunhoDoCaixa {
  return fato ? { valorTexto: textoDeCentavos(fato.valor), data: fato.data, categoria: fato.categoria,
    classificacao: fato.classificacao, mercadoria: fato.tipo === 'despesa' && fato.mercadoria }
    : { valorTexto: '', data: hoje, categoria: '', classificacao: '', mercadoria: false }
}

/** Confere calendário e campos antes da operação; valores continuam bigint até a gravação. */
export function conferirCaixa(r: RascunhoDoCaixa, tipo: EntradaCaixaLocal['tipo'], hoje: string): ResultadoCaixa<EntradaCaixaLocal> {
  const valor = lerDinheiro(r.valorTexto)
  if (valor === null || valor <= 0n) return { ok: false, motivo: 'valor-invalido' }
  const calendario = new Date(`${r.data}T12:00:00`)
  const [ano, mes, dia] = r.data.split('-').map(Number)
  if (!diaValido(r.data) || r.data > hoje || calendario.getFullYear() !== ano ||
    calendario.getMonth() + 1 !== mes || calendario.getDate() !== dia) return { ok: false, motivo: 'data-invalida' }
  if (!r.categoria.trim()) return { ok: false, motivo: 'categoria-obrigatoria' }
  if (r.classificacao !== 'negocio' && r.classificacao !== 'pessoal') return { ok: false, motivo: 'classificacao-invalida' }
  if (tipo === 'despesa' && r.mercadoria && r.classificacao !== 'negocio') return { ok: false, motivo: 'mercadoria-invalida' }
  const comum = { valor, data: r.data, categoria: r.categoria.trim(), classificacao: r.classificacao }
  return { ok: true, valor: tipo === 'despesa' ? { ...comum, tipo, mercadoria: r.mercadoria } : { ...comum, tipo } }
}
