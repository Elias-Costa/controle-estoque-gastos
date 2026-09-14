/**
 * O link do WhatsApp (RF-09, D-007): o app monta o texto e abre a conversa; quem envia é ela,
 * sempre. Sem API, sem custo, sem integração — é um `href`. Puro, sem React, testável no
 * `bun test` (`testes/whatsapp.test.ts`).
 *
 * O telefone fica na base como ela digitou (RF-01) e vira número só aqui.
 */

/**
 * O número no formato que o `wa.me` exige (só dígitos, com o país): "(11) 99999-9999" vira
 * "5511999999999"; "+55 11 99999-9999" também. Zero à esquerda (o "011" de operadora) cai.
 * Sem DDD, ou com algo que não parece telefone, devolve `null` — e o link abre o WhatsApp
 * sem número, para ela escolher a conversa (D-047).
 */
export function telefoneParaWhatsApp(telefone: string | undefined): string | null {
  const digitos = (telefone ?? '').replace(/\D/g, '').replace(/^0+/, '')
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`
  if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith('55')) return digitos
  return null
}

/**
 * `https://wa.me/<número>?text=<texto>` — a forma documentada pelo WhatsApp, que vale no
 * aparelho e no computador. Sem número legível, `https://wa.me/?text=<texto>`: o WhatsApp
 * abre com o texto pronto e pede a conversa (**não confirmado no iOS** — lote de E-15).
 */
export function linkDoWhatsApp(telefone: string | undefined, texto: string): string {
  return `https://wa.me/${telefoneParaWhatsApp(telefone) ?? ''}?text=${encodeURIComponent(texto)}`
}
