import type { Centavos } from '../dominio/dinheiro.ts'
import type { Dia } from '../dominio/ficha.ts'
import { MODELOS_ORIGINAIS } from '../dados/modelos-whatsapp.ts'
import { renderizarModelo } from './modelos-da-mensagem.ts'
import type { FiltroDeDevedoras, OrdemDeDevedoras } from './leitura-da-ficha.ts'

/**
 * As palavras da lista de devedores e da cobrança (RI-07) — num lugar só, como as outras.
 * As da lista são **hipótese até a próxima observação** (D-047; impessoais desde D-050, item 2:
 * "Ninguém em atraso", "Maior atraso"). **O texto da cobrança é dela**, ditado na visita de
 * E-15 (D-050, item 7); o recibo continua sendo proposta do agente (D-047). O envio é manual
 * (D-007). E-36/D-069/072 oferece os quatro modelos editáveis; os padrões têm uma fonte
 * em dados/modelos-whatsapp.ts, e a renderização única em modelos-da-mensagem.ts.
 */
export const PALAVRAS_DA_COBRANCA = {
  quemEstaDevendo: 'Quem está devendo',
  mostrar: 'Mostrar',
  ordem: 'Ordem',
  ninguemAtrasada: 'Ninguém em atraso',
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

/** As pílulas da ordem, na ordem de RF-10; "Maior atraso" é o padrão. */
export const ORDENS: readonly { readonly valor: OrdemDeDevedoras; readonly texto: string }[] = [
  { valor: 'atraso', texto: 'Maior atraso' },
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
// Tratamento e renderização únicos em modelos-da-mensagem.ts; padrões em dados/modelos-whatsapp.ts.

/**
 * A cobrança (RF-09) é **o texto que ela ditou** na visita de E-15 (D-050, item 7), palavra por
 * palavra, com "Fulano(a)" no lugar do nome: "Oi, Fulano(a), tudo bem? Passando para lembrar da
 * parcela que está atrasada. Quando puder, me mande, por favor. Obrigada!". Sem valor, sem
 * total, sem chave Pix — ela não os ditou. Com parcela ainda por vencer, o botão existe (D-047)
 * e só o trecho "que está atrasada" vira "que vence em dd/mm": é a única palavra do agente.
 */
export function mensagemDeCobranca(dados: { readonly nome: string; readonly vencimento: Dia; readonly vencida: boolean }): string {
  const situacao = dados.vencida ? 'cobranca-vencida' : 'cobranca-a-vencer'
  const resultado = renderizarModelo(MODELOS_ORIGINAIS[situacao], situacao, dados)
  if (!resultado.ok) throw new Error('Dados da cobrança inválidos')
  return resultado.texto
}

/** O recibo (RF-09): o que entrou e o que ficou — o mesmo que a confirmação mostra, com o saldo relido (RN-01). */
export function mensagemDeRecibo(dados: { readonly nome: string; readonly valor: Centavos; readonly saldo: Centavos }): string {
  const situacao = dados.saldo === 0n ? 'recibo-quitado' : 'recibo-com-saldo'
  const resultado = renderizarModelo(MODELOS_ORIGINAIS[situacao], situacao, dados)
  if (!resultado.ok) throw new Error('Dados do recibo inválidos')
  return resultado.texto
}
