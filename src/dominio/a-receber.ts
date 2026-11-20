import type { Centavos } from './dinheiro.ts'
import { parcelas, saldo, type Cliente, type Dia, type Id, type Lancamento } from './ficha.ts'
import { diasCivisEntre } from './calendario-resumo.ts'

/** RF-19/D-086: dívida aberta e restante das parcelas, inclusive em fichas desativadas. */
export function projetarAReceber(clientes: readonly Cliente[], lancamentos: readonly Lancamento[], hoje: Dia) {
  const fichas = new Map<Id, Lancamento[]>()
  for (const lancamento of lancamentos) {
    const ficha = fichas.get(lancamento.clienteId) ?? []
    ficha.push(lancamento)
    fichas.set(lancamento.clienteId, ficha)
  }
  const faixas: [Centavos, Centavos, Centavos, Centavos] = [0n, 0n, 0n, 0n]
  let total = 0n, devedoras = 0, desativadas = 0, saldoDesativadas = 0n, aVencer = 0n
  for (const cliente of clientes) {
    const ficha = fichas.get(cliente.id) ?? []
    const aberto = saldo(ficha)
    if (aberto <= 0n) continue
    total += aberto
    devedoras++
    if (cliente.desativadoEm !== undefined) {
      desativadas++
      saldoDesativadas += aberto
    }
    for (const { parcela, restante } of parcelas(ficha)) {
      const atraso = diasCivisEntre(parcela.vencimento, hoje)
      if (atraso <= 0) aVencer += restante
      else if (atraso <= 30) faixas[0] += restante
      else if (atraso <= 60) faixas[1] += restante
      else if (atraso <= 90) faixas[2] += restante
      else faixas[3] += restante
    }
  }
  const vencido = faixas[0] + faixas[1] + faixas[2] + faixas[3]
  return { total, devedoras, saldoDesativadas, desativadas, aVencer, vencido, faixas }
}
