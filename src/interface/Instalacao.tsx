import { plataformaDeInstalacao, sinaisDoNavegador } from '../plataforma/instalacao.ts'
import { PALAVRAS_DA_INSTALACAO } from './palavras-da-instalacao.ts'

/**
 * A instrução de instalação (E-13, RF-23, D-038, D-048), no pé da tela inicial: um texto para o
 * iPhone (Safari, sem aviso nativo) e outro para o Android (Chrome). Some no app já instalado e
 * no desktop. É lida uma vez na vida do aparelho — por isso fica sob a lista, fora do caminho
 * cronometrado, e não é um aviso que se fecha (seria um toque a mais e um estado a guardar).
 */
export function Instalacao() {
  const plataforma = plataformaDeInstalacao(sinaisDoNavegador())
  if (plataforma === null) return null
  return (
    <section className="mt-6 rounded-xl border border-borda bg-papel p-4">
      <h2 className="m-0 text-[1rem] font-semibold">{PALAVRAS_DA_INSTALACAO.titulo}</h2>
      <p className="mt-1 mb-0 text-[0.95rem] text-suave">{PALAVRAS_DA_INSTALACAO[plataforma]}</p>
    </section>
  )
}
