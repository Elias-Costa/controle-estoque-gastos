import { emReais, type Centavos } from '../dominio/dinheiro.ts'
import type { GuardaDoRecebimento } from './rascunho-do-recebimento.ts'

/**
 * As palavras do recebimento, da confirmação dele e da anotação (RI-07) — num lugar só, como
 * `palavras-da-venda.ts`. As do caminho principal ("Recebi R$ X", "Recebi da X", "Quanto ela
 * pagou", "Como", "Pix", "Dinheiro", "Quando", "Hoje", "Ontem", "Confirmar", "Anotado: R$ X da
 * Y", "Ainda deve R$ Z", "Ela não deve mais nada") são as do protótipo validado em 2026-09-08
 * (RT-14 em 14 s e 3 toques). As demais entraram por `D-046` e são **hipótese até E-15**:
 * "Troco de R$ X", "Anotar algo", "Considerar pago", "Desfazer este recebimento". Trocar é
 * uma linha, aqui.
 */
export const PALAVRAS_DO_RECEBIMENTO = {
  recebi: 'Recebi',
  quantoPagou: 'Quanto ela pagou',
  quando: 'Quando',
  anotarAlgo: 'Anotar algo',
  observacao: 'Observação',
  confirmar: 'Confirmar',
  considerarPago: 'Considerar pago',
  naoDeu: 'Não deu para anotar. Tente de novo.',
  anotacao: {
    recebiEm: 'Recebi em',
    desfazer: 'Desfazer este recebimento',
    comProblema: 'Este recebimento ficou com problema no envio. Desfaça e anote de novo.',
  },
} as const

/** "Recebi R$ 30,00" — o botão da ficha, com o que falta da próxima parcela (protótipo, D-006). */
export function botaoRecebi(restante: Centavos): string {
  return `${PALAVRAS_DO_RECEBIMENTO.recebi} ${emReais(restante)}`
}

/** "Recebi da Rosa" — o título da tela, como no protótipo. */
export function tituloDoRecebimento(nome: string): string {
  return `${PALAVRAS_DO_RECEBIMENTO.recebi} da ${nome}`
}

/** "Troco de R$ 3,00" (D-016) — antes de confirmar e na confirmação. */
export function fraseDoTroco(troco: Centavos): string {
  return `Troco de ${emReais(troco)}`
}

/** A frase de cada guarda; `sem-valor` e `valor-ilegivel` não têm (o botão indisponível e o campo já dizem). */
export function fraseDaGuardaDoRecebimento(guarda: GuardaDoRecebimento): string | null {
  switch (guarda) {
    case 'sem-valor':
    case 'valor-ilegivel':
      return null
    case 'falta-a-data':
      return 'Falta o dia'
    case 'data-no-futuro':
      return 'Esse dia ainda não chegou'
  }
}

/** A confirmação do recebimento (protótipo): o que entrou e o que ficou — o que ela confere em voz alta com a cliente. */
export function linhasDoRecebido(nome: string, valor: Centavos, saldo: Centavos): [string, string] {
  const primeira = `Anotado: ${emReais(valor)} da ${nome}`
  return [primeira, saldo === 0n ? 'Ela não deve mais nada' : `Ainda deve ${emReais(saldo)}`]
}
