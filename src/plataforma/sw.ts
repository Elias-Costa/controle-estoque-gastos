import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { avisoDaMensagemPush } from './aviso-push.ts'

declare const self: ServiceWorkerGlobalScope & { readonly __WB_MANIFEST: (string | PrecacheEntry)[] }

// D-032: instalar em espera; não chamar skipWaiting/clientsClaim nem recarregar clientes.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')))

self.addEventListener('message', (evento) => {
  if (evento.data?.tipo === 'CONFERIR_LEMBRETES') evento.ports[0]?.postMessage({ formato: 1 })
})
self.addEventListener('push', (evento) => {
  let valor: unknown = null
  try { valor = evento.data?.json() } catch { /* Mesmo um payload inválido só mostra o aviso genérico. */ }
  const aviso = avisoDaMensagemPush(valor)
  evento.waitUntil(self.registration.showNotification(aviso.titulo, aviso.opcoes))
})
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close()
  evento.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const atual = janelas.find((j) => new URL(j.url).origin === self.location.origin && new URL(j.url).pathname === '/')
    if (atual) {
      // Focar e sinalizar preserva o formulário; a janela decide quando voltar ao começo.
      await atual.focus()
      atual.postMessage({ tipo: 'ABRIR_LEMBRETES' })
    } else await self.clients.openWindow('/?lembretes=1')
  })())
})
