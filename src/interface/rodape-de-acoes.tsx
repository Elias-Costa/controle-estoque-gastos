import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** Reserva o tamanho real das ações fixas, inclusive com três botões e texto ampliado (RNF-03). */
export function RodapeDeAcoes({ children }: { children: ReactNode }) {
  const referencia = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const rodape = referencia.current
    if (!rodape) return
    const raiz = document.documentElement
    function reservarEspaco() {
      if (rodape) raiz.style.setProperty('--altura-rodape', `${rodape.getBoundingClientRect().height}px`)
    }
    reservarEspaco()
    const observador = new ResizeObserver(reservarEspaco)
    observador.observe(rodape, { box: 'border-box' })
    return () => {
      observador.disconnect()
      raiz.style.removeProperty('--altura-rodape')
    }
  }, [])

  return <div ref={referencia} className="rodape-acao">{children}</div>
}
