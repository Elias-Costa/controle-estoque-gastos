import { CARIMBO_DE_BUILD } from '../plataforma/versao'

/**
 * Invólucro mínimo do aplicativo.
 *
 * **Não é tela de produto e não é protótipo.** Existe por um motivo só: RF-23 exige
 * que a versão em uso seja identificável na interface, e sem alguma superfície montada
 * o carimbo de build de D-032 não teria onde aparecer.
 *
 * As telas dela nascem em E-02 (protótipo validado com a usuária) e E-09 em diante.
 * Este componente é substituído lá, inteiro.
 */
export function InvolucroMinimo() {
  return (
    <main className="involucro">
      <h1>Controle de Fiado</h1>
      <p className="aviso">
        Ainda não há telas. A fundação do repositório está pronta; as telas começam em E-02.
      </p>
      {/* Discreto de propósito: serve ao mantenedor durante o teste, não a ela. */}
      <p className="carimbo">versão {CARIMBO_DE_BUILD}</p>
    </main>
  )
}
