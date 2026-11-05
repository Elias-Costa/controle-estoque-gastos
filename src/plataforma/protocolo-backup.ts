import { exigirCopia } from '../dados/formato-copia.ts'
import type { BackupConfirmado } from '../dados/tipos-copia.ts'

/** Data civil do catálogo e do gatilho diário (D-082). */
export function diaDoBackup(instante: Date): string {
  const partes = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instante)
  const campo = (tipo: Intl.DateTimeFormatPartTypes) => partes.find((p) => p.type === tipo)?.value
  return `${campo('year')}-${campo('month')}-${campo('day')}`
}

/** Endereço aceito apenas para uma sessão privada de envio do Drive. Nunca registrar em log. */
export function sessaoDoDrive(uri: string): string {
  const u = new URL(uri)
  exigirCopia(u.origin === 'https://www.googleapis.com' && !u.username && !u.password && !u.hash &&
    /^\/upload\/drive\/v3\/files(?:\/[a-zA-Z0-9_-]+)?$/.test(u.pathname) && !!u.searchParams.get('upload_id'))
  return u.href
}

/** A identidade da conta vem da sessão Supabase; o pedido só indica o estágio e os bytes. */
export type PedidoBackupAparelho = { readonly acao: 'estado' } |
  { readonly acao: 'confirmar'; readonly captura: string; readonly aparelho: string } |
  { readonly acao: 'abrir'; readonly captura: string; readonly aparelho: string; readonly instante: string
    readonly tamanho: number; readonly sha256: string; readonly material: readonly string[]; readonly exclusivos: readonly string[] }

/** A única capacidade entregue ao app é a sessão de upload de uma candidata. */
export type RespostaBackupAparelho =
  { readonly estado: 'configuracao'; readonly habilitado: boolean; readonly ultima: BackupConfirmado | null } |
  { readonly estado: 'enviando'; readonly sessao: string; readonly posicao: number } |
  { readonly estado: 'pronta'; readonly confirmada: BackupConfirmado }
