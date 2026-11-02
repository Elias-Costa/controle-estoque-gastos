import { inscricaoPushValida, type InscricaoPush } from '../dados/tipos-lembretes.ts'

/** Capacidades do navegador, não uma afirmação de prova de plataforma (D-015). */
export interface PortaPush {
  disponivel(): boolean
  permitida(): boolean
  pedirPermissao(): Promise<boolean>
  inscrever(chave: string): Promise<InscricaoPush>
  atual(): Promise<InscricaoPush | null>
  desligar(): Promise<void>
}
function bytes(texto: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(texto.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}
function base64(buffer: ArrayBuffer | null): string {
  if (!buffer) throw new Error('Chave do navegador ausente')
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function ler(inscricao: PushSubscription): InscricaoPush {
  const valor = { endpoint: inscricao.endpoint, p256dh: base64(inscricao.getKey('p256dh')), auth: base64(inscricao.getKey('auth')) }
  if (!inscricaoPushValida(valor)) throw new Error('Provedor de aviso não reconhecido')
  return valor
}
async function conferirWorker(registro: ServiceWorkerRegistration): Promise<void> {
  await new Promise<void>((resolver, rejeitar) => {
    const canal = new MessageChannel()
    const prazo = setTimeout(() => { canal.port1.close(); rejeitar(new Error('Abra novamente pelo ícone')) }, 3000)
    canal.port1.onmessage = (evento) => {
      clearTimeout(prazo); canal.port1.close()
      if (evento.data?.formato === 1) resolver()
      else rejeitar(new Error('Abra novamente pelo ícone'))
    }
    registro.active?.postMessage({ tipo: 'CONFERIR_LEMBRETES' }, [canal.port2])
  })
}

/** Permissão só no gesto explícito; ativação nunca presume consentimento importado (D-079). */
export function criarPushDoNavegador(): PortaPush {
  function disponivel() { return typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window &&
    'PushManager' in window && 'serviceWorker' in navigator }
  return {
    disponivel,
    permitida: () => disponivel() && Notification.permission === 'granted',
    pedirPermissao: () => disponivel() ? Notification.requestPermission().then((p) => p === 'granted') : Promise.resolve(false),
    async inscrever(chave) {
      if (!disponivel() || Notification.permission !== 'granted' || !/^[A-Za-z0-9_-]{87}$/.test(chave)) throw new Error('Avisos indisponíveis')
      const registro = await navigator.serviceWorker.ready
      await conferirWorker(registro)
      let atual = await registro.pushManager.getSubscription()
      if (atual?.options.applicationServerKey && base64(atual.options.applicationServerKey) !== chave) {
        await atual.unsubscribe(); atual = null
      }
      return ler(atual ?? await registro.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(chave) }))
    },
    async atual() {
      if (!disponivel() || Notification.permission !== 'granted') return null
      const registro = await navigator.serviceWorker.getRegistration()
      const inscricao = await registro?.pushManager.getSubscription()
      return inscricao ? ler(inscricao) : null
    },
    async desligar() {
      if (!disponivel()) return
      const registro = await navigator.serviceWorker.getRegistration()
      await (await registro?.pushManager.getSubscription())?.unsubscribe()
    },
  }
}
