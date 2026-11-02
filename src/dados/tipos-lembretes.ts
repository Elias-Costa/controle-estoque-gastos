import type { ObservacaoLembretes } from '../dominio/lembretes.ts'

/** Credencial de entrega do navegador; privada para esta instalação/servidor, fora da cópia. */
export type InscricaoPush = { readonly endpoint: string; readonly p256dh: string; readonly auth: string }
/** Intenção durável, independente da FIFO financeira; confirmada pertence ao servidor (D-079). */
export type InscricaoLocal = {
  readonly chave: 'atual'; readonly aparelhoId: string; readonly contaId: string; readonly destino: string
  readonly revisao: number; readonly confirmada: number; readonly ativa: boolean
  readonly inscricao?: InscricaoPush
  readonly estado: 'solicitada' | 'pendente' | 'ativa' | 'desligada' | 'invalida' | 'problema'
}
/** Observação deste aparelho; estados do servidor nunca são importados como observação local. */
export type ObservacaoLocalLembretes = { readonly chave: 'local'; readonly valor: ObservacaoLembretes }
/** Documento retentável: id local e comparação com a revisão conhecida na conta autenticada. */
export type PedidoInscricaoLembretes = {
  readonly aparelhoId: string; readonly revisao: number; readonly anterior: number
  readonly ativa: boolean; readonly inscricao?: InscricaoPush
}

/** Evita usar o emissor como fetch arbitrário; provedores alvo de D-079, sem redirects. */
export function inscricaoPushValida(v: unknown): v is InscricaoPush {
  if (typeof v !== 'object' || v === null || !('endpoint' in v) || !('p256dh' in v) || !('auth' in v) ||
    Object.keys(v).sort().join(',') !== 'auth,endpoint,p256dh' || typeof v.endpoint !== 'string' ||
    v.endpoint.length > 4096 || typeof v.p256dh !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(v.p256dh) ||
    typeof v.auth !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(v.auth)) return false
  try {
    const url = new URL(v.endpoint)
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
      (url.hostname === 'fcm.googleapis.com' || url.hostname.endsWith('.push.apple.com'))
  } catch { return false }
}
