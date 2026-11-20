import { quantidadeValida } from '../dominio/regras-estoque.ts'
import { FORMATO_UUIDV7 } from './identidade.ts'

/** D-089: uma escolha de prazo por conta, identificada no aparelho. */
export type PreferenciaEncalhe = {
  readonly chave: 'encalhe'
  readonly id: string
  readonly atualizadoEm: string
  readonly dias: number
}

/** Mesma guarda usada no cálculo de encalhe, da escrita local à restauração. */
export function preferenciaEncalheValida(valor: unknown): valor is PreferenciaEncalhe {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return false
  const v: Record<string, unknown> = Object.fromEntries(Object.entries(valor))
  return Object.keys(v).sort().join(',') === 'atualizadoEm,chave,dias,id' && v['chave'] === 'encalhe' &&
    typeof v['id'] === 'string' && FORMATO_UUIDV7.test(v['id']) && typeof v['dias'] === 'number' && quantidadeValida(v['dias']) &&
    typeof v['atualizadoEm'] === 'string' && !Number.isNaN(Date.parse(v['atualizadoEm'])) &&
    new Date(v['atualizadoEm']).toISOString() === v['atualizadoEm']
}

/** Duas edições no mesmo instante ainda podem ter conteúdos diferentes (D-072). */
export function mesmaPreferenciaEncalhe(a: PreferenciaEncalhe | undefined, b: PreferenciaEncalhe | undefined): boolean {
  return a?.id === b?.id && a?.atualizadoEm === b?.atualizadoEm && a?.dias === b?.dias
}
