import { CARIMBO_DE_BUILD } from '../plataforma/versao'
import { IndicadorDeEnvio } from './IndicadorDeEnvio'

/**
 * Invólucro mínimo do aplicativo.
 *
 * **Não é tela de produto e não é protótipo.** Existe por dois motivos: RF-23 exige que a
 * versão em uso seja identificável na interface, e sem alguma superfície montada o carimbo de
 * build de D-032 não teria onde aparecer; e RF-25 exige o indicador de sincronização, que
 * desde E-07 tem estado de verdade para mostrar.
 *
 * As telas dela nascem em E-09 em diante. Este componente é substituído lá, inteiro — o
 * indicador vai junto, para onde E-09 decidir.
 */
export function InvolucroMinimo() {
  return (
    <main className="involucro">
      <h1>Controle de Fiado</h1>
      <p className="aviso">
        Ainda não há telas. A base local e a sincronização estão prontas; as telas começam em E-09.
      </p>
      <IndicadorDeEnvio />
      {/* Discreto de propósito: serve ao mantenedor durante o teste, não a ela. */}
      <p className="carimbo">versão {CARIMBO_DE_BUILD}</p>
    </main>
  )
}
