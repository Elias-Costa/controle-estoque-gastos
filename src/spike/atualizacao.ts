/**
 * Propagação de nova versão para o PWA instalado.
 *
 * O `registerSW.js` que o vite-plugin-pwa injeta apenas **registra** o service
 * worker. O `sw.js` gerado chama `skipWaiting()` e `clientsClaim()`, então a
 * versão nova assume o controle — mas isso acontece *depois* de a tela já ter
 * sido montada com o HTML antigo vindo do cache, e nada recarrega a página.
 *
 * No iOS o efeito é pior do que no desktop: o app instalado raramente é
 * encerrado de verdade, então a checagem de atualização pode nunca convergir.
 * Observado em 2026-09-05, quando uma rodada inteira de teste rodou contra o
 * build anterior sem ninguém perceber.
 *
 * Isto não é detalhe de spike: é o caminho pelo qual a usuária receberia uma
 * correção de saldo. Uma correção que não chega é indistinguível de um defeito
 * que não foi corrigido. A forma definitiva no produto é `D-032`.
 */
export function vigiarAtualizacoes(): void {
  if (!('serviceWorker' in navigator)) return

  // Havia controlador quando a página carregou? Se não havia, o `controllerchange`
  // que vem a seguir é o da PRIMEIRA instalação — recarregar ali seria recarregar
  // à toa em toda primeira abertura.
  const jaControlado = navigator.serviceWorker.controller !== null
  let recarregando = false

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!jaControlado || recarregando) return
    recarregando = true
    window.location.reload()
  })

  // Pede a checagem explicitamente: no iOS não dá para contar com a checagem
  // automática do navegador acontecer em tempo útil.
  void navigator.serviceWorker.ready.then((registro) => registro.update())
}

/** Força a checagem sob comando, para o teste no aparelho não depender de espera. */
export async function procurarAtualizacao(): Promise<string> {
  if (!('serviceWorker' in navigator)) return 'service worker indisponível'
  const registro = await navigator.serviceWorker.getRegistration()
  if (!registro) return 'nenhum service worker registrado'
  await registro.update()
  return registro.waiting
    ? 'versão nova encontrada — recarregando'
    : 'nenhuma versão nova disponível'
}
