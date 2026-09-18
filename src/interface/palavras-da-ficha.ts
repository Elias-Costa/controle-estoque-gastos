import { emReais, type Centavos } from '../dominio/dinheiro.ts'
import type { FormaDePagamento, ItemVenda, Lancamento } from '../dominio/ficha.ts'
import { diaCurto } from './datas.ts'

/**
 * As palavras da lista, da ficha e do cadastro (RI-07) — num lugar só, como `palavras-do-envio.ts`.
 *
 * As que o protótipo de E-02 usou ("Fichinhas", "Deve", "Nada", "O que aconteceu", "em dia",
 * "Parcela 2 de 4", "Está tudo pago", "Pronto") passaram pela sessão de 2026-09-08 sem trava.
 * **Na visita de E-15 ela pediu frases impessoais** (`D-050`, item 2): tudo que dizia "ela",
 * "cliente nova" ou "atrasada" passou a falar da *fichinha*, não da pessoa — ela vende também
 * para homens. As demais são **hipótese até a próxima observação** (`D-044`): qual palavra ela
 * usa é observação, não escolha do agente. Trocar é uma linha, aqui.
 */
export const PALAVRAS = {
  titulo: 'Fichinhas',
  procurar: 'Procurar pelo nome',
  nenhumaFicha: 'Nenhuma fichinha ainda',
  ninguemComEsseNome: 'Ninguém com esse nome',
  clienteNova: '+ Nova fichinha',
  emDia: 'em dia',
  deve: 'Deve',
  nada: 'Nada',
  naoDeveNada: 'Não deve nada',
  tudoPago: 'Está tudo pago',
  oQueAconteceu: 'O que aconteceu',
  nadaAnotado: 'Nada anotado ainda',
  voltar: 'Voltar',
  /** A base local não respondeu (EL-06): dito com palavras dela, sem tela de erro técnica. */
  naoDeuParaAbrir: 'Não deu para abrir as fichinhas. Feche o aplicativo e abra de novo.',
  /** O que foi desfeito fica sob um toque (D-050, item 1); "Esconder" é o mesmo lugar, invertido. */
  esconderDesfeitas: 'Esconder o que foi desfeito',
  /** A ficha desativada continua abrindo; esta linha, sob o nome, diz por que ela não está na lista. */
  fichinhaDesativada: 'Fichinha desativada',
  /** A linha no fim da lista inicial: as desativadas a um toque (D-050, item 6). */
  voltarParaAsFichinhas: 'Voltar para as fichinhas',
  nenhumaDesativada: 'Nenhuma fichinha desativada',
  cadastro: {
    titulo: 'Nova fichinha',
    nome: 'Nome',
    telefone: 'Telefone',
    apelido: 'Apelido',
    apelidoExemplo: 'do salão, vizinha do 302',
    observacao: 'Observação',
    jaMeDeve: 'Já me deve',
    desde: 'Desde',
    venceEm: 'Vence em',
    pronto: 'Pronto',
    faltaONome: 'Falta o nome',
    naoDeu: 'Não deu para anotar. Tente de novo.',
  },
  /** "Mudar dados" (D-050, item 8): os mesmos campos do cadastro, e a fichinha desativada/reativada no fim. */
  dados: {
    abrir: 'Mudar dados',
    titulo: 'Mudar dados',
    desativar: 'Desativar a fichinha',
    desativarMesmo: 'Desativar mesmo? Ela sai da lista, mas nada é apagado.',
    simDesativar: 'Sim, desativar',
    reativar: 'Reativar a fichinha',
  },
} as const

/** "Ver o que foi desfeito (2)": a linha no fim do histórico, com a contagem dos alvos desfeitos. */
export function verDesfeitas(quantas: number): string {
  return `Ver o que foi desfeito (${quantas})`
}

/** "Ver as fichinhas desativadas (1)": a linha no fim da lista inicial; some com zero. */
export function verDesativadas(quantas: number): string {
  return `Ver as fichinhas desativadas (${quantas})`
}

/** A coluna da direita na lista: "em dia" ou quanto deve. */
export function quantoDeve(saldo: Centavos): string {
  return saldo === 0n ? PALAVRAS.emDia : emReais(saldo)
}

/** "há quantos dias" é literal de RF-10: é o que ordena a cobrança dela na rua. "Em atraso" fala da fichinha (D-050, item 2). */
export function avisoDeAtraso(dias: number): string {
  return dias === 1 ? 'em atraso há 1 dia' : `em atraso há ${dias} dias`
}

/** A linha sob o valor grande da ficha (RF-02): a próxima parcela, vencida ou não, ou o motivo de não haver. */
export function linhaDaProxima(
  proxima: { readonly restante: Centavos; readonly vencimento: string; readonly vencida: boolean } | null,
  fichaVazia: boolean,
): string {
  if (proxima === null) return fichaVazia ? PALAVRAS.naoDeveNada : PALAVRAS.tudoPago
  if (proxima.vencida) return `${emReais(proxima.restante)} venceu em ${diaCurto(proxima.vencimento)}`
  return `Próxima: ${emReais(proxima.restante)} em ${diaCurto(proxima.vencimento)}`
}

/**
 * "N de M" é dentro do débito que gerou a parcela, nunca sobre a lista inteira da ficha: uma
 * cliente com duas compras tem duas contagens (regra do protótipo).
 */
export function nomeDaParcela(ordem: number, de: number): string {
  return de === 1 ? 'Parcela' : `Parcela ${ordem} de ${de}`
}

/** "Creme, perfume e sabonete" — como ela escreveu, sem mexer em maiúscula (lição do protótipo). */
export function descricaoDosItens(itens: readonly ItemVenda[]): string {
  const nomes = itens.map((item) => item.descricao.trim()).filter((nome) => nome !== '')
  if (nomes.length === 0) return `Levou ${itens.length} ${itens.length === 1 ? 'coisa' : 'coisas'}`
  if (nomes.length === 1) return nomes[0] ?? ''
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`
}

/** "Pagou no Pix" / "Pagou em dinheiro": a linha do recebimento no histórico e a forma na anotação da venda à vista (E-10). */
export function comoPagou(forma: FormaDePagamento): string {
  switch (forma) {
    case 'pix':
      return 'Pagou no Pix'
    case 'dinheiro':
      return 'Pagou em dinheiro'
    case 'outro':
      return 'Pagou'
  }
}

/** A descrição de um lançamento no histórico. O estorno cita o alvo, que continua na lista, marcado (RN-07). */
export function descricaoDoLancamento(lancamento: Lancamento, alvoDoEstorno: Lancamento | undefined): string {
  switch (lancamento.tipo) {
    case 'venda':
      return lancamento.pagamento === 'fiado'
        ? descricaoDosItens(lancamento.itens)
        : `${descricaoDosItens(lancamento.itens)} · pagou na hora`
    case 'saldo-anterior':
      return 'Já devia'
    case 'recebimento':
      return comoPagou(lancamento.forma)
    case 'desconto-quitacao':
      return 'Considerou pago'
    case 'estorno':
      return alvoDoEstorno === undefined ? 'Desfez' : `Desfez: ${descricaoDoLancamento(alvoDoEstorno, undefined)}`
  }
}
