import { preferenciaModelosValida, type PreferenciaModelos } from '../dados/modelos-whatsapp.ts'
import { normalizarCarimbo } from './borda.ts'
import type { LinhaRecebida } from './nuvem.ts'

/** Preferência inteira; dono e instante de chegada são responsabilidade do servidor. */
export function modelosParaNuvem(preferencia: PreferenciaModelos): LinhaRecebida {
  if (!preferenciaModelosValida(preferencia)) throw new Error('Modelos locais inválidos')
  return { id: preferencia.id, chave: preferencia.chave, atualizado_em: preferencia.atualizadoEm, modelos: preferencia.modelos }
}
/** Campos obrigatórios e quatro textos válidos; nenhuma coerção de dados ausentes. */
export function modelosDaNuvem(linha: LinhaRecebida): PreferenciaModelos {
  const preferencia = { id: linha['id'], chave: linha['chave'], modelos: linha['modelos'],
    atualizadoEm: normalizarCarimbo('modelos.atualizado_em', linha['atualizado_em']) }
  if (!preferenciaModelosValida(preferencia)) throw new Error('Modelos da nuvem inválidos')
  return preferencia
}
