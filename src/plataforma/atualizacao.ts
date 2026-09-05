/**
 * Como uma versão nova chega ao aparelho dela (D-032, RF-23).
 *
 * A decisão é **atualizar na próxima abertura**: o service worker novo é baixado e
 * instalado em segundo plano, mas fica em espera e só assume o controle quando o app
 * for aberto de novo. A sessão em andamento nunca é recarregada.
 *
 * O porquê está em D-032 e não é conforto: recarregar a tela de quem está com uma
 * cliente na frente pode custar um lançamento pela metade (EL-01) e é o tipo de
 * interrupção que faz voltar para o caderno (EL-08). O intervalo até a versão nova
 * entrar é de horas, não de semanas.
 *
 * A espera é garantida pela configuração, não por este arquivo. Com `registerType: 'prompt'`
 * em vite.config.ts, o `sw.js` gerado não tem `clientsClaim()` e o único `skipWaiting()`
 * que existe está **dentro de um listener** que só dispara se um cliente postar
 * `{ type: 'SKIP_WAITING' }` — e nada neste projeto posta. Verificado no build de
 * 2026-09-05, não presumido. Logo, o service worker novo fica em espera até a abertura
 * seguinte, que é o que D-032 pede.
 *
 * Esse listener é, de propósito, a porta que D-032 deixou registrada para F1: se um dia
 * for preciso oferecer "atualizar agora" para uma correção de dinheiro, é por ele — e só
 * em tela ociosa, nunca com formulário aberto. Não é escopo de E-01.
 */

/**
 * Pede a verificação de versão explicitamente, na abertura do app.
 *
 * O `registerSW.js` do vite-plugin-pwa apenas registra o service worker; a checagem
 * automática do navegador não é confiável em tempo útil num PWA instalado, que
 * raramente é encerrado de verdade. Sem este pedido explícito, a versão nova pode
 * demorar indefinidamente — foi o que travou o teste de 2026-09-05.
 */
export function pedirVerificacaoDeVersao(): void {
  if (!('serviceWorker' in navigator)) return

  // Falha aqui é irrelevante para a usuária: significa apenas que a versão nova entra
  // numa abertura seguinte. Nada do que ela faz depende de rede (RI-02), então o erro
  // é engolido de propósito em vez de virar tela (EL-06).
  void navigator.serviceWorker.ready
    .then((registro) => registro.update())
    .catch(() => undefined)
}
