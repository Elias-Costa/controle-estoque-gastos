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
  const base = 'w-full min-h-14 px-4 rounded-[14px] text-[1.125rem] font-semibold leading-none'
  const variante =
    tipo === 'principal'
      ? 'bg-acento text-acento-tinta border-0 disabled:bg-borda disabled:text-suave'
      : 'bg-papel text-tinta border border-borda'
  return (
    <button type="button" className={`${base} ${variante} ${className}`} onClick={aoTocar} disabled={desabilitado}>
      {children}
    </button>
  )
}
