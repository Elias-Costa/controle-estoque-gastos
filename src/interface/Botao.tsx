import type { ReactNode } from 'react'

/**
 * O botão do kit (D-023), nas duas variantes do protótipo: **principal** (verde, a ação que o
 * polegar procura correndo) e **secundário** (papel com borda). 56 px de altura — acima do
 * mínimo de 44 de RNF-03, de propósito.
 *
 * Desabilitado é **indisponível, não morto**: muda a cor, não a nitidez (sem `opacity`),
 * porque a tela é lida sem óculos de perto. Um botão verde que não fazia nada custou segundos
 * da tarefa cronometrada na revisão do protótipo (`docs/fatos-verificados.md`, lições de E-02).
 */
export function Botao({
  tipo,
  children,
  aoTocar,
  desabilitado = false,
  className = '',
}: {
  tipo: 'principal' | 'secundario'
  children: ReactNode
  aoTocar: () => void
  desabilitado?: boolean
  className?: string
}) {
  return (
    <button type="button" className={`${classesDoBotao(tipo)} ${className}`} onClick={aoTocar} disabled={desabilitado}>
      {children}
    </button>
  )
}

/**
 * O mesmo botão, quando o toque abre outro aplicativo (o WhatsApp, RF-09): um `<a>` de verdade,
 * em aba nova, e não `window.open` — o Safari bloqueia janela aberta depois de um `await`, e
 * um link o sistema entende sem truque. Nada é enviado: é só o `href` (D-007, D-047).
 */
export function BotaoLink({ tipo, href, children, className = '' }: { tipo: 'principal' | 'secundario'; href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${classesDoBotao(tipo)} inline-flex items-center justify-center no-underline ${className}`}>
      {children}
    </a>
  )
}

function classesDoBotao(tipo: 'principal' | 'secundario'): string {
  const base = 'w-full min-h-14 px-4 rounded-[14px] text-[1.125rem] font-semibold leading-none'
  const variante =
    tipo === 'principal'
      ? 'bg-acento text-acento-tinta border-0 disabled:bg-borda disabled:text-suave'
      : 'bg-papel text-tinta border border-borda'
  return `${base} ${variante}`
}
