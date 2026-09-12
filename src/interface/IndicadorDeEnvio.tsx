import { useSyncExternalStore } from 'react'
import { sincronizacao } from '../sincronizacao/instancia'
import { palavrasDoEstado } from './palavras-do-envio'

/**
 * O indicador de estado da sincronização (RF-25): uma linha de texto, passiva, zero toques.
 * As palavras estão em `palavras-do-envio.ts` (hipótese até E-15, D-042). Não é tela: E-09
 * decide onde ele mora; aqui só existe para o invólucro mínimo ter o que mostrar e para o motor
 * ter um assinante desde já. `useSyncExternalStore` é o que o motor foi feito para servir:
 * `estado()` devolve a mesma referência enquanto nada muda.
 */
export function IndicadorDeEnvio() {
  const estado = useSyncExternalStore(sincronizacao.assinar, sincronizacao.estado, sincronizacao.estado)
  return (
    <p className="indicador" data-pendentes={estado.pendentes} data-com-problema={estado.comProblema}>
      {palavrasDoEstado(estado)}
    </p>
  )
}
