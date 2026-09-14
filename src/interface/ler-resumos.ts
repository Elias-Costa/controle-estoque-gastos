import { repositorio } from '../dados/instancia.ts'
import { hoje } from './datas.ts'
import { resumir, type ResumoDaFicha } from './leitura-da-ficha.ts'

/**
 * O resumo de todas as fichas, lido na hora pelo `repositorio` — o que a lista de fichinhas
 * (E-09) e a lista de devedores (E-12) mostram. Todas as clientes cabem em memória (RNF-05):
 * uma leitura por ficha é o suficiente em F1. Nenhum número é guardado: `resumir` deriva (RN-01).
 */
export async function lerResumos(): Promise<ResumoDaFicha[]> {
  const dia = hoje()
  const clientes = await repositorio.listarClientes()
  return Promise.all(clientes.map(async (cliente) => resumir(cliente, await repositorio.lerFicha(cliente.id), dia)))
}
