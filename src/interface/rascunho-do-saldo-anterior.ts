import { lerDinheiro, repartir, somar, type Centavos } from '../dominio/dinheiro.ts'
import type { Dia, SaldoAnterior } from '../dominio/ficha.ts'
import { mesesDepois } from './datas.ts'
import { guardaDaData, montarParcelas, textoDeCentavos, type EdicaoDeParcela, type ParcelaMontada } from './rascunho-da-venda.ts'

/**
 * O saldo anterior enquanto ela digita (E-14, RF-07, D-049) — puro, sem React, testável no
 * `bun test` (`testes/rascunho-do-saldo-anterior.test.ts`). "Já me deve R$ X desde tal dia,
 * vence em tal dia, em N vezes": o cadastro (D-044) e a tela "O que a X já devia" guardam o
 * texto cru; este módulo lê pelo domínio (`lerDinheiro`, `repartir`, `somar`) e devolve o
 * que ela precisa ver antes do toque. Nenhum `number` aqui é dinheiro (EL-03).
 */

/** Tudo que as duas telas guardam. `venceEm` é a 1ª parcela; as seguintes vêm de mês em mês a partir dela. */
export type RascunhoDoSaldoAnterior = {
  readonly valorTexto: string
  readonly desde: Dia
  readonly venceEm: Dia
  readonly vezes: number
  readonly edicoes: readonly EdicaoDeParcela[]
}

/**
 * O que impede o "Pronto", em código; a tela põe as palavras (RI-07). `sem-valor` é "nada a
 * anotar" — no cadastro é permitido (cliente sem dívida antiga); na tela própria, só botão
 * indisponível. Com `sem-valor` ou `valor-ilegivel` nenhuma outra guarda é emitida: as datas
 * e as parcelas nem aparecem ainda.
 */
export type GuardaDoSaldoAnterior =
  | 'sem-valor'
  | 'valor-ilegivel'
  | 'falta-a-data'
  | 'data-no-futuro'
  | 'falta-o-vencimento'
  | 'parcela-ilegivel'
  | 'parcelas-nao-fecham'

/** O que a tela mostra: o valor lido (`0n` enquanto não há), as parcelas montadas e as guardas. */
export type ConferenciaDoSaldoAnterior = {
  readonly valor: Centavos
  readonly parcelas: ParcelaMontada[]
  readonly guardas: GuardaDoSaldoAnterior[]
}

/** As datas de N parcelas a partir da primeira: ela mesma, e depois de mês em mês (`mesesDepois`, presa ao último dia do mês). */
export function datasAPartirDe(primeira: Dia, vezes: number): Dia[] {
  return Array.from({ length: vezes }, (_, posicao) => mesesDepois(primeira, posicao))
}

/** Confere o rascunho inteiro: lê o valor, monta as parcelas a partir de "vence em" e lista o que falta. `hoje` é parâmetro para o teste fixar o dia. */
export function conferirSaldoAnterior(rascunho: RascunhoDoSaldoAnterior, hoje: Dia): ConferenciaDoSaldoAnterior {
  const texto = rascunho.valorTexto.trim()
  const lido = texto === '' ? null : lerDinheiro(texto)
  if (texto !== '' && lido === null) return { valor: 0n, parcelas: [], guardas: ['valor-ilegivel'] }
  // Valor zero é "não deve nada": não vira lançamento (um saldo anterior de R$ 0,00 seria lixo na ficha).
  if (lido === null || lido === 0n) return { valor: 0n, parcelas: [], guardas: ['sem-valor'] }

  const guardas: GuardaDoSaldoAnterior[] = []
  // "Desde" é a data do fato (RN-09): a mesma regra da venda e do recebimento. "Vence em" pode ser futuro.
  const guardaDeData = guardaDaData(rascunho.desde, hoje)
  if (guardaDeData !== null) guardas.push(guardaDeData)
  if (rascunho.venceEm === '') guardas.push('falta-o-vencimento')

  const parcelas = rascunho.venceEm === '' ? [] : montarParcelas(lido, datasAPartirDe(rascunho.venceEm, rascunho.vezes), rascunho.edicoes)
  if (parcelas.some((parcela) => parcela.ilegivel)) guardas.push('parcela-ilegivel')
  else if (parcelas.length > 0 && somar(parcelas.map((parcela) => parcela.valor)) !== lido) guardas.push('parcelas-nao-fecham')

  return { valor: lido, parcelas, guardas }
}

/**
 * O rascunho de um saldo anterior já gravado, para a correção (D-013, D-049): a mesma regra
 * de `rascunhoDaVenda` — toda data de parcela entra como editada (as datas são dela); o valor
 * só entra como editado quando difere do que `repartir` daria.
 */
export function rascunhoDoSaldoAnterior(original: SaldoAnterior): RascunhoDoSaldoAnterior {
  const total = somar(original.parcelas.map((parcela) => parcela.valor))
  const automaticas = repartir(total, original.parcelas.length)
  const edicoes = original.parcelas.map((parcela, posicao): EdicaoDeParcela => ({
    vencimento: parcela.vencimento,
    ...(parcela.valor !== automaticas[posicao] && { valorTexto: textoDeCentavos(parcela.valor) }),
  }))
  return {
    valorTexto: textoDeCentavos(total),
    desde: original.data,
    venceEm: original.parcelas[0]?.vencimento ?? original.data,
    vezes: original.parcelas.length,
    edicoes,
  }
}
