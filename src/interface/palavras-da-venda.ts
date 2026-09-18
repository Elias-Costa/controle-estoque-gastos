import { emReais, type Centavos } from '../dominio/dinheiro.ts'
import type { Dia, Motivo } from '../dominio/ficha.ts'
import { diaCurto } from './datas.ts'
import type { Guarda } from './rascunho-da-venda.ts'

/**
 * As palavras da venda, da confirmação e da anotação (RI-07) — num lugar só, como
 * `palavras-da-ficha.ts`. As do caminho principal ("Nova venda", "Para quem?", "O que X
 * levou", "+ Mais um", "Total", "Fiado", "À vista", "Em quantas vezes", "Hoje", "Ontem",
 * "Pronto", "Anotado na fichinha de X", "Agora deve", "Ver a fichinha") são as do protótipo
 * validado em 2026-09-08 (RT-15 em 48 s), **postas no impessoal na visita de E-15** (`D-050`,
 * item 2: "Vender fiado para ela" virou "Vender fiado", e tudo que dizia "ela" fala da fichinha).
 * As demais entraram por `D-045` e são **hipótese até a próxima observação**: "Dar desconto",
 * "Outro dia", "Mudar datas ou valores", "Corrigir", "Desfazer esta venda" e as guardas.
 * Trocar é uma linha, aqui.
 */
export const PALAVRAS_DA_VENDA = {
  novaVenda: 'Nova venda',
  venderFiado: 'Vender fiado',
  paraQuem: 'Para quem?',
  itemExemplo: 'O que levou',
  precoExemplo: '0,00',
  maisUm: '+ Mais um',
  total: 'Total',
  darDesconto: 'Dar desconto',
  desconto: 'Desconto',
  comoVaiPagar: 'Como vai pagar',
  fiado: 'Fiado',
  aVista: 'À vista',
  como: 'Como',
  pix: 'Pix',
  dinheiro: 'Dinheiro',
  emQuantasVezes: 'Em quantas vezes',
  mudarParcelas: 'Mudar datas ou valores',
  quandoFoi: 'Quando foi',
  hoje: 'Hoje',
  ontem: 'Ontem',
  outroDia: 'Outro dia',
  pronto: 'Pronto',
  naoDeu: 'Não deu para anotar. Tente de novo.',
  verAFichinha: 'Ver a fichinha',
  voltarParaOComeco: 'Voltar para o começo',
  naoDeveNada: 'Não deve nada',
  anotacao: {
    fiadoEm: 'Fiado em',
    pagouNaHoraEm: 'Pagou na hora em',
    corrigir: 'Corrigir',
    desfazer: 'Desfazer esta venda',
    desfazerMesmo: 'Desfazer mesmo? As duas linhas ficam na fichinha.',
    simDesfazer: 'Sim, desfazer',
    deixarComoEsta: 'Deixar como está',
    comProblema: 'Esta venda ficou com problema no envio. Desfaça e anote de novo.',
    naoDeuParaDesfazer: 'Não deu para desfazer. Tente de novo.',
  },
} as const

/** "O que Rosa levou" — o título da tela de venda, como no protótipo, sem o artigo (D-050, item 2). */
export function tituloDaVenda(nome: string): string {
  return `O que ${nome} levou`
}

/** "1ª em 12/10": a linha de uma parcela na lista da venda e na anotação (formato do protótipo). */
export function quandoDaParcela(posicao: number, vencimento: Dia): string {
  return `${posicao}ª em ${diaCurto(vencimento)}`
}

/** A frase de cada guarda (RI-07). `sem-valor` não tem frase: é o estado inicial, e o botão indisponível já diz. */
export function fraseDaGuarda(guarda: Guarda, soma: Centavos, total: Centavos): string | null {
  switch (guarda) {
    case 'sem-valor':
      return null
    case 'falta-preco':
      return 'Falta o preço de um item'
    case 'preco-ilegivel':
      return 'Não entendi um dos preços'
    case 'desconto-ilegivel':
      return 'Não entendi o desconto'
    case 'desconto-maior':
      return 'O desconto é maior que a venda'
    case 'parcela-ilegivel':
      return 'Não entendi o valor de uma parcela'
    case 'parcelas-nao-fecham':
      return `As parcelas somam ${emReais(soma)}; a venda é ${emReais(total)}`
    case 'falta-a-data':
      return 'Falta o dia'
    case 'data-no-futuro':
      return 'Esse dia ainda não chegou'
  }
}

/** A confirmação da venda: a primeira linha (o que aconteceu) e a segunda (o saldo, que ela confere em voz alta). */
export function linhasDaConfirmacao(nome: string, fiado: boolean, total: Centavos, saldo: Centavos): [string, string] {
  const primeira = fiado ? `Anotado na fichinha de ${nome}` : `${nome} levou e pagou ${emReais(total)}`
  if (saldo === 0n) return [primeira, PALAVRAS_DA_VENDA.naoDeveNada]
  return [primeira, fiado ? `Agora deve ${emReais(saldo)}` : `Ainda deve ${emReais(saldo)}`]
}

/**
 * A recusa do domínio numa correção, num estorno, num recebimento ou numa quitação, em
 * palavras dela (RI-07); o resto é "não deu". As três últimas só acontecem se a ficha mudou
 * por outro aparelho entre abrir a tela e tocar — a tela já não oferece o botão nesses casos.
 */
export function fraseDaRecusa(motivo: Motivo): string {
  switch (motivo) {
    case 'ja-sincronizado':
      return 'Já foi enviada. Desfaça e anote de novo.'
    case 'parcela-paga-alterada':
      return 'Uma parcela já paga não pode mudar.'
    case 'ficha-ficaria-negativa':
      return 'Já pagou parte. Desfaça o pagamento antes.'
    case 'ja-estornado':
      return 'Já foi desfeita.'
    case 'nada-a-receber':
    case 'nada-a-quitar':
      return 'Não deve nada.'
    case 'acima-do-limite-de-quitacao':
      return 'Ainda falta mais de R$ 0,10.'
    default:
      return PALAVRAS_DA_VENDA.naoDeu
  }
}
