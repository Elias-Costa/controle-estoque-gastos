/**
 * As operações que a tela chama: a costura entre o domínio e a base (E-05, D-040).
 *
 * Cada função aqui faz a mesma sequência, e só ela: **gera o id** (UUIDv7, D-029, RI-04 —
 * é o único lugar do app que gera id), **lê a ficha** pelo repositório, **chama o domínio**
 * (`src/dominio/lancamentos.ts`, que valida e devolve `Resultado`) e **grava o que foi
 * aceito** — a gravação já entra na fila de sincronização na mesma transação
 * (`repositorio.ts`). Uma recusa do domínio passa intacta, com o `motivo` em código, e nada é
 * gravado. Nenhuma regra de negócio mora aqui: se uma linha deste arquivo decide algo sobre
 * dinheiro, saldo ou parcela, ela está no lugar errado.
 *
 * Todo caminho de escrita de F1 passa por este arquivo. É o que permite provar, por
 * contagem (`testes/operacoes.test.ts`), que nenhuma escrita acontece sem item na fila
 * (RI-02, EL-01) e que todo id persistido nasceu aqui.
 *
 * As três correções (`corrigirLancamento`, `renegociar`, `moverParaOutraCliente`) recebem
 * `{ sincronizado }` como argumento, igual ao domínio (D-013): quem responde "já subiu?" é a
 * fila, em E-07 — este arquivo não inventa a resposta.
 *
 * Limitação registrada (`ARCHITECTURE.md`): ler a ficha e gravar são duas transações, não
 * uma. Uma usuária, um aparelho por vez, e o domínio revalida a ficha inteira antes de
 * devolver — o intervalo entre as duas não tem outro escritor.
 */

import type { Centavos } from '../dominio/dinheiro.ts'
import {
  aceito,
  recusado,
  type Cliente,
  type Debito,
  type DescontoQuitacao,
  type Dia,
  type Estorno,
  type Ficha,
  type Id,
  type Lancamento,
  type Parcela,
  type Recebimento,
  type Resultado,
  type SaldoAnterior,
  type VendaAVista,
  type VendaFiado,
} from '../dominio/ficha.ts'
import {
  considerarPago,
  corrigir,
  corrigirCliente,
  estornar,
  novaVendaAVista,
  novaVendaFiado,
  novoCliente,
  novoSaldoAnterior,
  registrarRecebimento,
  renegociarParcelas,
  type Correcao,
  type EntradaCliente,
  type EntradaEstorno,
  type EntradaQuitacao,
  type EntradaRecebimento,
  type EntradaSaldoAnterior,
  type EntradaVendaAVista,
  type EntradaVendaFiado,
} from '../dominio/lancamentos.ts'
import { uuidv7 } from './identidade.ts'
import type { Repositorio } from './repositorio.ts'

/** Uma parcela como a tela a monta — quanto e quando. O id nasce aqui, na criação. */
export type ParcelaNova = {
  readonly vencimento: Dia
  readonly valor: Centavos
}

/** Dá id a cada parcela nova; a que já tem id (renegociação, RN-08) fica com o seu. */
function comIds(parcelas: readonly (Parcela | ParcelaNova)[]): Parcela[] {
  return parcelas.map((parcela) => ('id' in parcela ? parcela : { id: uuidv7(), ...parcela }))
}

/**
 * A ficha da cliente, ou a recusa `cliente-nao-encontrado` (D-040): lançamento sem cliente
 * cadastrado não tem onde aparecer, e E-06 vai recusá-lo no banco com a chave estrangeira —
 * melhor recusar aqui do que subir lixo pela fila.
 */
async function fichaDe(repositorio: Repositorio, clienteId: Id): Promise<Resultado<Ficha>> {
  if ((await repositorio.lerCliente(clienteId)) === undefined) return recusado('cliente-nao-encontrado')
  return aceito(await repositorio.lerFicha(clienteId))
}

/** Grava o lançamento que o domínio aceitou; a recusa passa intacta. */
async function gravar<L extends Lancamento>(repositorio: Repositorio, resultado: Resultado<L>): Promise<Resultado<L>> {
  if (resultado.ok) await repositorio.gravarLancamento(resultado.valor)
  return resultado
}

/** Cadastro de cliente (RF-01): id gerado aqui, nome conferido pelo domínio. */
export async function cadastrarCliente(repositorio: Repositorio, entrada: Omit<EntradaCliente, 'id'>): Promise<Resultado<Cliente>> {
  const resultado = novoCliente({ ...entrada, id: uuidv7() })
  if (resultado.ok) await repositorio.gravarCliente(resultado.valor)
  return resultado
}

/** Venda fiado (RF-03, RF-05): ids da venda e de cada parcela gerados aqui. */
export async function lancarVendaFiado(
  repositorio: Repositorio,
  entrada: Omit<EntradaVendaFiado, 'id' | 'parcelas'> & { readonly parcelas: readonly ParcelaNova[] },
): Promise<Resultado<VendaFiado>> {
  const ficha = await fichaDe(repositorio, entrada.clienteId)
  if (!ficha.ok) return ficha
  return gravar(repositorio, novaVendaFiado({ ...entrada, id: uuidv7(), parcelas: comIds(entrada.parcelas) }))
}

/** Venda à vista (RN-04): um lançamento só, que não mexe no saldo (D-039). */
export async function lancarVendaAVista(repositorio: Repositorio, entrada: Omit<EntradaVendaAVista, 'id'>): Promise<Resultado<VendaAVista>> {
  const ficha = await fichaDe(repositorio, entrada.clienteId)
  if (!ficha.ok) return ficha
  return gravar(repositorio, novaVendaAVista({ ...entrada, id: uuidv7() }))
}

/** Saldo anterior (RF-07): a migração do papel, em parcelas com id próprio. */
export async function lancarSaldoAnterior(
  repositorio: Repositorio,
  entrada: Omit<EntradaSaldoAnterior, 'id' | 'parcelas'> & { readonly parcelas: readonly ParcelaNova[] },
): Promise<Resultado<SaldoAnterior>> {
  const ficha = await fichaDe(repositorio, entrada.clienteId)
  if (!ficha.ok) return ficha
  return gravar(repositorio, novoSaldoAnterior({ ...entrada, id: uuidv7(), parcelas: comIds(entrada.parcelas) }))
}

/** Recebimento (RF-06): o domínio limita ao saldo e devolve o troco (RN-03, D-016). */
export async function receber(
  repositorio: Repositorio,
  entrada: Omit<EntradaRecebimento, 'id'>,
): Promise<Resultado<{ recebimento: Recebimento; troco: Centavos }>> {
  const ficha = await fichaDe(repositorio, entrada.clienteId)
  if (!ficha.ok) return ficha
  const resultado = registrarRecebimento(ficha.valor, { ...entrada, id: uuidv7() })
  if (resultado.ok) await repositorio.gravarLancamento(resultado.valor.recebimento)
  return resultado
}

/** "Considerar pago" (RN-15, D-031): o domínio confere o limite e fixa o valor. */
export async function quitar(repositorio: Repositorio, entrada: Omit<EntradaQuitacao, 'id'>): Promise<Resultado<DescontoQuitacao>> {
  const ficha = await fichaDe(repositorio, entrada.clienteId)
  if (!ficha.ok) return ficha
  return gravar(repositorio, considerarPago(ficha.valor, { ...entrada, id: uuidv7() }))
}

/** Estorno (RF-08, RN-07): o lançamento inverso, ao lado do alvo. Nada é apagado (RI-03). */
export async function estornarLancamento(repositorio: Repositorio, entrada: Omit<EntradaEstorno, 'id'>): Promise<Resultado<Estorno>> {
  const ficha = await fichaDe(repositorio, entrada.clienteId)
  if (!ficha.ok) return ficha
  return gravar(repositorio, estornar(ficha.valor, { ...entrada, id: uuidv7() }))
}

/**
 * Correção no lugar (D-013): o substituto já vem com o id do original — não há id novo, é a
 * mesma linha regravada. Só enquanto não sincronizou, e é `correcao` quem diz.
 */
export async function corrigirLancamento<L extends Lancamento>(
  repositorio: Repositorio,
  substituto: L,
  correcao: Correcao,
): Promise<Resultado<L>> {
  const ficha = await fichaDe(repositorio, substituto.clienteId)
  if (!ficha.ok) return ficha
  return gravar(repositorio, corrigir(ficha.valor, substituto, correcao))
}

/**
 * Renegociação de parcelas (RN-08, D-012): parcela que já existia mantém o id (é assim que
 * "parcela paga não muda" tem o que comparar); parcela nova ganha um.
 */
export async function renegociar(
  repositorio: Repositorio,
  entrada: { readonly clienteId: Id; readonly debitoId: Id; readonly parcelas: readonly (Parcela | ParcelaNova)[] },
  correcao: Correcao,
): Promise<Resultado<Debito>> {
  const ficha = await fichaDe(repositorio, entrada.clienteId)
  if (!ficha.ok) return ficha
  return gravar(repositorio, renegociarParcelas(ficha.valor, entrada.debitoId, comIds(entrada.parcelas), correcao))
}

/**
 * Cliente errado (RF-08, D-040): move o lançamento da ficha em que ela lançou por engano para
 * a ficha certa. O domínio valida os dois lados; aqui só se leem as duas fichas e se grava o
 * substituto — uma linha, mesmo id, `clienteId` novo.
 */
export async function moverParaOutraCliente(
  repositorio: Repositorio,
  entrada: { readonly lancamentoId: Id; readonly deClienteId: Id; readonly paraClienteId: Id },
  correcao: Correcao,
): Promise<Resultado<Lancamento>> {
  const origem = await fichaDe(repositorio, entrada.deClienteId)
  if (!origem.ok) return origem
  const destino = await fichaDe(repositorio, entrada.paraClienteId)
  if (!destino.ok) return destino
  return gravar(repositorio, corrigirCliente(origem.valor, destino.valor, entrada.lancamentoId, entrada.paraClienteId, correcao))
}
