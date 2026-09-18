import { emReais, type Centavos } from '../dominio/dinheiro.ts'
import type { GuardaDoSaldoAnterior } from './rascunho-do-saldo-anterior.ts'

/**
 * As palavras do saldo anterior fora do cadastro (E-14, RF-07, D-049): a linha da ficha, a
 * tela "O que X já devia" e a anotação. As do cadastro ("Já me deve", "Desde", "Vence em")
 * continuam em `palavras-da-ficha.ts`, e as duas telas usam as mesmas. Todas são **hipótese
 * até a próxima observação** (`D-049`; impessoais desde `D-050`, item 2): qual palavra ela usa
 * é observação, não escolha do agente.
 */
export const PALAVRAS_DO_SALDO_ANTERIOR = {
  anotarJaDevia: 'Anotar o que já devia',
  quanto: 'Quanto',
  pronto: 'Pronto',
  naoDeu: 'Não deu para anotar. Tente de novo.',
  anotacao: {
    jaDeviaDesde: 'Já devia desde',
    desfazer: 'Desfazer esta anotação',
    comProblema: 'Esta anotação ficou com problema no envio. Desfaça e anote de novo.',
  },
} as const

/** "O que Rosa já devia" — o título da tela, no molde de "O que Rosa levou". */
export function tituloDoSaldoAnterior(nome: string): string {
  return `O que ${nome} já devia`
}

/** A frase de cada guarda (RI-07). `sem-valor` não tem frase: é o estado inicial, e o botão indisponível já diz. */
export function fraseDaGuardaDoSaldoAnterior(guarda: GuardaDoSaldoAnterior, soma: Centavos, total: Centavos): string | null {
  switch (guarda) {
    case 'sem-valor':
      return null
    case 'valor-ilegivel':
      return 'Não entendi o valor'
    case 'falta-a-data':
      return 'Falta o dia'
    case 'data-no-futuro':
      return 'Esse dia ainda não chegou'
    case 'falta-o-vencimento':
      return 'Falta o vencimento'
    case 'parcela-ilegivel':
      return 'Não entendi o valor de uma parcela'
    case 'parcelas-nao-fecham':
      return `As parcelas somam ${emReais(soma)}; o saldo é ${emReais(total)}`
  }
}
