import type { Centavos } from './dinheiro.ts'
import type { Dia } from './ficha.ts'
import type { ParteDaVenda } from './historico-de-vendas.ts'
import { diaDoMes, diasDoMes, deslocarMes } from './calendario-resumo.ts'

/** RF-21/D-088: séries e intervalos comparáveis, com ausência distinta de total zero. */
export function projetarVendasPorPeriodo(partes: readonly ParteDaVenda[], hoje: Dia, mes: string) {
  const porDia = new Map<Dia, Centavos>()
  for (const { data, valor, fim } of partes) {
    porDia.set(data, (porDia.get(data) ?? 0n) + valor)
    if (fim) porDia.set(fim.data, (porDia.get(fim.data) ?? 0n) - fim.valor)
  }
  const mesAtual = hoje.slice(0, 7)
  const diaAtual = new Date(`${hoje}T00:00:00Z`).getUTCDate()
  const ultimoDia = (m: string) => m === mesAtual ? diaAtual : diasDoMes(m)
  function intervalo(m: string, ultimo: number) {
    const inicio = diaDoMes(m, 1), fim = diaDoMes(m, ultimo)
    let valor = 0n, temAnotacoes = false
    for (let dia = 1; dia <= ultimo; dia++) {
      const anotado = porDia.get(diaDoMes(m, dia))
      if (anotado === undefined) continue
      valor += anotado
      temAnotacoes = true
    }
    return { inicio, fim, valor, temAnotacoes }
  }
  const anterior = deslocarMes(mes, -1)
  const fimDoAnterior = diasDoMes(anterior)
  return {
    consultado: intervalo(mes, ultimoDia(mes)),
    anterior: intervalo(anterior, mes === mesAtual && diaAtual < fimDoAnterior ? diaAtual : fimDoAnterior),
    diaria: Array.from({ length: ultimoDia(mes) }, (_, i) => {
      const dia = diaDoMes(mes, i + 1)
      const valor = porDia.get(dia)
      return { dia, valor: valor ?? 0n, temAnotacoes: valor !== undefined }
    }),
    mensal: Array.from({ length: 12 }, (_, i) => {
      const m = deslocarMes(mesAtual, i - 11)
      return { mes: m, ...intervalo(m, ultimoDia(m)) }
    }),
  }
}
