import { FORMATO_UUIDV7 } from './identidade.ts'

/** D-076: orçamento da imagem inteira; PNG conserva transparência sem Storage público. */
export const LIMITE_LOGO_BYTES = 204_800
/** D-076: lado máximo da imagem preparada, sem distorção nem ampliação. */
export const LADO_LOGO = 512
/** Conteúdo da identificação; ausência de logo é remoção explícita na preferência inteira. */
export type IdentidadeLoja = { readonly nome: string; readonly descricao: string; readonly logo?: string }
/** Uma identificação por conta, sem associação fictícia com cliente ou produto. */
export type PreferenciaIdentidadeLoja = { readonly chave: 'loja'; readonly id: string; readonly atualizadoEm: string; readonly identidade: IdentidadeLoja }

/** Aceita somente PNG local limitado; nenhuma URL, SVG ou dado arbitrário entra no PDF. */
export function logoValida(valor: unknown): valor is string {
  if (typeof valor !== 'string' || valor.length > 22 + 4 * Math.ceil(LIMITE_LOGO_BYTES / 3) ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(valor)) return false
  try {
    const binario = atob(valor.slice(22))
    if (binario.length < 33 || binario.length > LIMITE_LOGO_BYTES || btoa(binario) !== valor.slice(22)) return false
    const bytes = Uint8Array.from(binario, (letra) => letra.charCodeAt(0))
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) || binario.slice(12, 16) !== 'IHDR') return false
    const vista = new DataView(bytes.buffer)
    return vista.getUint32(16) > 0 && vista.getUint32(16) <= LADO_LOGO && vista.getUint32(20) > 0 && vista.getUint32(20) <= LADO_LOGO
  } catch { return false }
}

/** Forma fechada compartilhada pela gravação, borda e futura cópia F3 (D-076). */
export function identidadeLojaValida(valor: unknown): valor is IdentidadeLoja {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return false
  const v: Record<string, unknown> = Object.fromEntries(Object.entries(valor))
  return Object.keys(v).every((chave) => ['nome', 'descricao', 'logo'].includes(chave)) &&
    typeof v['nome'] === 'string' && v['nome'].trim().length > 0 && v['nome'] === v['nome'].trim() &&
    typeof v['descricao'] === 'string' && (!Object.hasOwn(v, 'logo') || logoValida(v['logo']))
}

/** Identidade e relógio válidos antes de publicar qualquer preferência recebida. */
export function preferenciaIdentidadeValida(valor: unknown): valor is PreferenciaIdentidadeLoja {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return false
  const v: Record<string, unknown> = Object.fromEntries(Object.entries(valor))
  return Object.keys(v).sort().join(',') === 'atualizadoEm,chave,id,identidade' && v['chave'] === 'loja' &&
    typeof v['id'] === 'string' && FORMATO_UUIDV7.test(v['id']) && typeof v['atualizadoEm'] === 'string' &&
    !Number.isNaN(Date.parse(v['atualizadoEm'])) && new Date(v['atualizadoEm']).toISOString() === v['atualizadoEm'] && identidadeLojaValida(v['identidade'])
}

/** Conteúdo explícito: ordem das chaves JSON não é uma edição da loja. */
export function mesmaIdentidade(a: IdentidadeLoja | undefined, b: IdentidadeLoja | undefined): boolean {
  return a?.nome === b?.nome && a?.descricao === b?.descricao && a?.logo === b?.logo
}

/** Conserva rascunho quando a preferência observada já mudou, inclusive com relógio igual. */
export function mesmaPreferenciaIdentidade(a: PreferenciaIdentidadeLoja | undefined, b: PreferenciaIdentidadeLoja | undefined): boolean {
  return a?.id === b?.id && a?.atualizadoEm === b?.atualizadoEm && mesmaIdentidade(a?.identidade, b?.identidade)
}
