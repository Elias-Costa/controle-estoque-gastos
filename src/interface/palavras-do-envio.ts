import type { EstadoDaSincronizacao } from '../sincronizacao/sincronizacao'

/**
 * As palavras do indicador de sincronização (RF-25, RI-07) — **hipótese** até E-15 medir com
 * ela (D-042, item 6). "Enviar" é palavra do WhatsApp dela; "sincronizar", "nuvem" e "servidor"
 * não entram. Trocar é uma linha, aqui.
 *
 * Honesto por construção: "para enviar" vale enquanto há item na fila, seja por falta de rede,
 * de sessão ou de tempo — o motivo não é dela. "Com problema" é o que a nuvem recusou em
 * definitivo e espera ação (E-10).
 */
export function palavrasDoEstado(estado: EstadoDaSincronizacao): string {
  const partes: string[] = []
  if (estado.enviando) partes.push('Enviando…')
  else if (estado.pendentes > 0) partes.push(`${estado.pendentes} para enviar`)
  if (estado.comProblema > 0) partes.push(`${estado.comProblema} com problema`)
  return partes.length === 0 ? 'Tudo em dia' : partes.join(' · ')
}
