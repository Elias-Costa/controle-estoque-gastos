import { lerDinheiro, type Centavos } from '../dominio/dinheiro.ts'
import { saldo, type Dia, type Ficha, type FormaDePagamento, type Id, type Recebimento } from '../dominio/ficha.ts'
import { calcularTroco } from '../dominio/lancamentos.ts'
import { guardaDaData, textoDeCentavos } from './rascunho-da-venda.ts'

/**
 * O que a tela de recebimento (E-11, RF-06) guarda enquanto ela digita, e o que dele se
 * deriva antes do toque — como `rascunho-da-venda.ts`. Puro, para o teste fixar o dia e o
 * saldo. Nenhum número é somado aqui: o troco é `calcularTroco`, do domínio (D-016).
 */

/** O rascunho: o texto cru do valor (quem lê é `lerDinheiro`), a forma, a observação e a data. */
export type RascunhoDoRecebimento = {
  readonly valorTexto: string
  readonly forma: FormaDePagamento
  readonly observacao: string
  readonly data: Dia
}

/**
 * O que trava o "Confirmar" (RI-07: a tela põe a frase). `sem-valor` é o estado inicial e não
 * vira frase; `valor-ilegivel` também não — o campo de dinheiro já diz "Não entendi o valor"
 * logo abaixo do número, e dizer duas vezes é ruído.
 */
export type GuardaDoRecebimento = 'sem-valor' | 'valor-ilegivel' | 'falta-a-data' | 'data-no-futuro'

/** O recebimento conferido: o que ela digitou, o que entra na ficha, o que volta como troco, e o que falta. */
export type ConferenciaDoRecebimento = {
  /** O valor lido do texto; `null` quando o domínio não leu. */
  readonly valor: Centavos | null
  /** O que fica anotado: até o saldo (RN-03). */
  readonly registrado: Centavos
  /** O que ela devolve na hora (D-016). Informação da tela, nunca lançamento. */
  readonly troco: Centavos
  readonly guardas: readonly GuardaDoRecebimento[]
}

/**
 * Confere o rascunho contra o saldo que o recebimento pode abater. Para um recebimento novo é o
 * saldo da ficha; para a correção é `saldoParaCorrigir`, sem o original. `hoje` é parâmetro
 * para o teste fixar o dia.
 */
export function conferirRecebimento(rascunho: RascunhoDoRecebimento, saldoDisponivel: Centavos, hoje: Dia): ConferenciaDoRecebimento {
  const guardas: GuardaDoRecebimento[] = []
  const texto = rascunho.valorTexto.trim()
  const valor = texto === '' ? null : lerDinheiro(texto)
  if (texto === '') guardas.push('sem-valor')
  else if (valor === null) guardas.push('valor-ilegivel')
  else if (valor <= 0n) guardas.push('sem-valor')

  const guardaDeData = guardaDaData(rascunho.data, hoje)
  if (guardaDeData !== null) guardas.push(guardaDeData)

  const { registrado, troco } = valor === null || valor <= 0n ? { registrado: 0n, troco: 0n } : calcularTroco(saldoDisponivel, valor)
  return { valor, registrado, troco, guardas }
}

/**
 * O saldo que a correção de um recebimento pode abater (D-046): a ficha **sem** o recebimento
 * original, porque ele é substituído — o que ele abateu volta a estar em aberto antes de o
 * valor novo entrar.
 */
export function saldoParaCorrigir(ficha: Ficha, recebimentoId: Id): Centavos {
  return saldo(ficha.filter((lancamento) => lancamento.id !== recebimentoId))
}

/** O rascunho de um recebimento já gravado, para a correção (D-013): o valor como texto, o resto como está. */
export function rascunhoDoRecebimento(recebimento: Recebimento): RascunhoDoRecebimento {
  return {
    valorTexto: textoDeCentavos(recebimento.valor),
    forma: recebimento.forma,
    observacao: recebimento.observacao ?? '',
    data: recebimento.data,
  }
}

/** O recebimento como vai para o domínio: observação em branco não é observação. */
export function observacaoDe(rascunho: RascunhoDoRecebimento): string | undefined {
  const observacao = rascunho.observacao.trim()
  return observacao === '' ? undefined : observacao
}
