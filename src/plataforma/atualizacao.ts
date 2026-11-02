/**
 * Como uma versão nova chega ao aparelho dela (D-032, RF-23).
 *
 * A decisão é **atualizar na próxima abertura**: o service worker novo é baixado e
 * instalado em segundo plano, mas fica em espera e só assume o controle quando o app
 * for aberto de novo. A sessão em andamento nunca é recarregada.
 *
 * O porquê está em D-032 e não é conforto: recarregar a tela de quem está com uma
 * cliente na frente pode custar um lançamento pela metade (EL-01/06). A adoção segue
 * D-060; não depende de comparação com o caderno.
 *
 * E-38/D-079 substitui generateSW por `sw.ts` próprio, com a mesma URL/escopo,
 * precache e fallback de navegação. O worker não chama skipWaiting/clientsClaim;
 * este módulo continua apenas pedindo a verificação. Não garante prazo de atualização
 * ou comportamento de aparelho sem prova própria. O artefato antigo e seu listener
 * SKIP_WAITING permanecem descritos no histórico de E-01, não como código vigente.
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
