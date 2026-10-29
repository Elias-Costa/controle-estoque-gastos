import { useSyncExternalStore } from 'react'
import { sincronizacao } from '../sincronizacao/instancia'
import { palavrasDoEstado } from './palavras-do-envio'
import { RelatarProblemaEnvio } from './relatar-problema-envio.tsx'

/**
 * O indicador de estado da sincronização (RF-25); D-077 acrescenta relato junto da recusa.
 * As palavras estão em `palavras-do-envio.ts` (hipótese até E-15, D-042). Mora sob o título
 * da tela inicial (D-044): a única tela que ela vê toda vez. O relato não substitui a
 * conferência/recuperação da anotação. `useSyncExternalStore` é o que o motor foi feito para
 * servir: `estado()` devolve a mesma referência enquanto nada muda.
 *
 * A classe `indicador` não é estilo: é o gancho que a prova de offline lê
 * (`testes/navegador/apoio.ts`, `esperarIndicador`), junto dos dois `data-*`. Renomear quebra E-08.
 */
export function IndicadorDeEnvio() {
  const estado = useSyncExternalStore(sincronizacao.assinar, sincronizacao.estado, sincronizacao.estado)
  return (
    <>
      <p role="status" aria-atomic="true" className="indicador m-0 text-[0.9rem] text-suave" data-pendentes={estado.pendentes} data-com-problema={estado.comProblema}>
        {palavrasDoEstado(estado)}
      </p>
      {estado.comProblema > 0 && <RelatarProblemaEnvio />}
    </>
  )
}
