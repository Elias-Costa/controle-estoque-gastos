import { emReais, type Centavos } from '../dominio/dinheiro.ts'
import type { Dia } from '../dominio/ficha.ts'
import { diaCurto } from './datas.ts'
import type { FiltroDeDevedoras, OrdemDeDevedoras } from './leitura-da-ficha.ts'

/**
 * As palavras da lista de devedores e da cobrança (RI-07) — num lugar só, como as outras.
 * Nenhuma passou por ela: **tudo aqui é hipótese até E-15** (D-047). Os dois textos do
 * WhatsApp são proposta do agente, porque ela não tem cobrança escrita (cobra de viva voz);
 * o envio é manual (D-007), então ela ajusta no próprio WhatsApp — e o que ela muda é o que
 * define os modelos de F3 (D-014). Trocar é uma linha, aqui.
 */
export const PALAVRAS_DA_COBRANCA = {
  quemEstaDevendo: 'Quem está devendo',
  mostrar: 'Mostrar',
  ordem: 'Ordem',
  ninguemAtrasada: 'Ninguém atrasada',
  ninguemAVencer: 'Ninguém a vencer',
  ninguemDevendo: 'Ninguém devendo',
  cobrar: 'Cobrar no WhatsApp',
  mandarRecibo: 'Mandar o recibo no WhatsApp',
} as const

/** As pílulas do filtro, na ordem de RF-10; "Em atraso" é o padrão (D-047 item 3). */
export const FILTROS: readonly { readonly valor: FiltroDeDevedoras; readonly texto: string }[] = [
  { valor: 'em-atraso', texto: 'Em atraso' },
  { valor: 'a-vencer', texto: 'A vencer' },
  { valor: 'todas', texto: 'Todas' },
]

/** As pílulas da ordem, na ordem de RF-10; "Mais atrasada" é o padrão. */
export const ORDENS: readonly { readonly valor: OrdemDeDevedoras; readonly texto: string }[] = [
  { valor: 'atraso', texto: 'Mais atrasada' },
  { valor: 'valor', texto: 'Maior valor' },
  { valor: 'nome', texto: 'Nome' },
]

/** O que a lista vazia diz, por filtro: vazia em "Em atraso" é boa notícia, e a frase precisa soar assim. */
export function fraseDaListaVazia(filtro: FiltroDeDevedoras): string {
  switch (filtro) {
    case 'em-atraso':
      return PALAVRAS_DA_COBRANCA.ninguemAtrasada
    case 'a-vencer':
      return PALAVRAS_DA_COBRANCA.ninguemAVencer
    case 'todas':
      return PALAVRAS_DA_COBRANCA.ninguemDevendo
  }
}

/**
 * Como a mensagem chama a cliente: pelo primeiro nome ("Maria Silva" → "Maria"), como entre
 * vizinhas. "Dona Rosa" e "Seu João" são tratamento + nome, e o tratamento sozinho seria errado.
 */
function comoChamar(nome: string): string {
  const palavras = nome.trim().split(/\s+/)
  const primeira = palavras[0] ?? nome
  const tratamento = /^(dona|seu)\.?$/i.test(primeira)
  return tratamento && palavras.length > 1 ? `${primeira} ${palavras[1]}` : primeira
}

/**
 * A cobrança (RF-09): nome, o que falta da parcela e o vencimento — "venceu em" ou "vence em",
 * conforme o dia. O total da fichinha só quando é diferente da parcela: repetir o mesmo número
 * duas vezes confunde. Sem chave Pix em F1 (D-047 item 1).
 */
export function mensagemDeCobranca(dados: {
  readonly nome: string
  readonly restante: Centavos
  readonly vencimento: Dia
  readonly vencida: boolean
  readonly saldo: Centavos
}): string {
  const verbo = dados.vencida ? 'venceu' : 'vence'
  const total = dados.saldo !== dados.restante ? ` No total, a fichinha está em ${emReais(dados.saldo)}.` : ''
  return (
    `Oi, ${comoChamar(dados.nome)}, tudo bem? Passando para lembrar da parcela de ${emReais(dados.restante)} da sua fichinha, ` +
    `que ${verbo} em ${diaCurto(dados.vencimento)}.${total} Quando puder, me avisa. Obrigada!`
  )
}

/** O recibo (RF-09): o que entrou e o que ficou — o mesmo que a confirmação mostra, com o saldo relido (RN-01). */
export function mensagemDeRecibo(dados: { readonly nome: string; readonly valor: Centavos; readonly saldo: Centavos }): string {
  const resto = dados.saldo === 0n ? 'Sua fichinha está quitada!' : `Agora falta ${emReais(dados.saldo)} na sua fichinha.`
  return `Oi, ${comoChamar(dados.nome)}! Recebi os ${emReais(dados.valor)}, obrigada! ${resto}`
}
