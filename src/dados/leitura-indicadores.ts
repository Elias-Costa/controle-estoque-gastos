import type { BancoLocal } from './banco.ts'
import type { DadosIndicadores } from '../dominio/indicadores.ts'

/** Captura as fontes correntes no mesmo r, incluindo os manifestos efetivos de F2. */
export function lerDadosIndicadores(banco: BancoLocal): Promise<DadosIndicadores> {
  return banco.transaction('r', [banco.clientes, banco.lancamentos, banco.fatosCaixa,
    banco.produtos, banco.movimentos, banco.operacoes], async () => {
    const [clientes, lancamentos, fatosCaixa, produtos, movimentos, operacoes] = await Promise.all([
      banco.clientes.toArray(), banco.lancamentos.toArray(), banco.fatosCaixa.toArray(),
      banco.produtos.toArray(), banco.movimentos.toArray(), banco.operacoes.toArray(),
    ])
    return { clientes, lancamentos, fatosCaixa, produtos, movimentos, operacoes }
  })
}
