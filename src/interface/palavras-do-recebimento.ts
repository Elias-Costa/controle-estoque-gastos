import { emReais, type Centavos } from '../dominio/dinheiro.ts'
import type { GuardaDoRecebimento } from './rascunho-do-recebimento.ts'

/**
 * As palavras do recebimento, da confirmação dele e da anotação (RI-07) — num lugar só, como
 * `palavras-da-venda.ts`. As do caminho principal ("Como", "Pix", "Dinheiro", "Quando", "Hoje",
 * "Ontem", "Confirmar", "Ainda deve R$ Z") são as do protótipo validado em 2026-09-08 (RT-14 em
 * 14 s e 3 toques). **Na visita de E-15 ela trocou o verbo** (`D-050`, item 4): "Recebi R$ X"
 * virou **"Abater valor"** — para parte das clientes não há parcela, há um total que vai
 * baixando, e "Recebi R$ 500" prometia a parcela inteira. O título e a confirmação foram junto,
 * no impessoal (item 2): "Abater na fichinha de X", "Quanto pagou", "Anotado: R$ X de Y", "Não
 * deve mais nada", "Desfazer este pagamento" (o histórico já dizia "Pagou no Pix"). As demais
 * entraram por `D-046` e são **hipótese até a próxima observação**: "Troco de R$ X", "Anotar
 * algo", "Considerar pago". Trocar é uma linha, aqui.
 */
export const PALAVRAS_DO_RECEBIMENTO = {
  abater: 'Abater valor',
  quantoPagou: 'Quanto pagou',
  quando: 'Quando',
  anotarAlgo: 'Anotar algo',
  observacao: 'Observação',
  confirmar: 'Confirmar',
  considerarPago: 'Considerar pago',
  naoDeu: 'Não deu para anotar. Tente de novo.',
  anotacao: {
    pagouEm: 'Pagou em',
    desfazer: 'Desfazer este pagamento',
    comProblema: 'Este pagamento ficou com problema no envio. Desfaça e anote de novo.',
  },
} as const

/** "Abater na fichinha de Rosa" — o título da tela; o campo já vem com o que falta da próxima parcela (D-006). */
export function tituloDoRecebimento(nome: string): string {
  return `Abater na fichinha de ${nome}`
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
  const primeira = `Anotado: ${emReais(valor)} de ${nome}`
  return [primeira, saldo === 0n ? 'Não deve mais nada' : `Ainda deve ${emReais(saldo)}`]
}
