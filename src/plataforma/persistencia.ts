/**
 * Pedido de armazenamento persistente (D-020, D-040, EL-05).
 *
 * `navigator.storage.persist()` pede ao navegador que a origem não seja candidata a despejo
 * silencioso sob pressão de armazenamento. O que se sabe por medição, não por documentação
 * (`AGENTS.md` §2.1): no iOS, **com o PWA instalado na tela de início, é concedido**; no
 * Chromium do desktop, sem engajamento, é negado — e não conclui nada sobre o iPhone. A base
 * de uma revendedora com anos de fichas não pode depender de sorte, então o pedido é feito em
 * toda abertura: é idempotente e barato.
 *
 * Fire-and-forget, erro engolido: nada que ela faz depende da resposta (RNF-04), e um
 * navegador sem a API só significa que a proteção não existe ali — não é tela de erro.
 */

/** Pede persistência da origem na abertura do app. Não devolve nada de propósito: ninguém decide com isso. */
export function pedirPersistencia(): void {
  if (!('storage' in navigator) || typeof navigator.storage.persist !== 'function') return
  void navigator.storage.persist().catch(() => undefined)
}
