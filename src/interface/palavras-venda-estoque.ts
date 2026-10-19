import type { MotivoEstoque } from '../dominio/regras-estoque.ts'
import { fraseDaRecusa } from './palavras-da-venda.ts'

/** Recusas de operações conjuntas em palavras para conferência; hipóteses até E-28. */
export function fraseVendaEstoque(motivo: MotivoEstoque): string {
  switch (motivo) {
    case 'quantidade-invalida': return 'Confira a quantidade: use um número inteiro.'
    case 'excede-pendencia': return 'A quantidade é maior que o que falta entregar. Confira a venda.'
    case 'excede-retorno': return 'Voltou mais do que foi entregue e ainda não tinha voltado. Confira as quantidades.'
    case 'alvo-invalido': case 'ja-anulado': return 'Esta anotação já mudou. Volte e confira como ficou.'
    case 'confirmacao-necessaria': return 'Há uma anotação para conferir antes de continuar.'
    case 'correcao-invalida': return 'Confira se foi apenas o valor ou se a anotação do que saiu estava errada.'
    case 'item-invalido': return 'Confira os produtos e as quantidades da venda.'
    case 'produto-inexistente': return 'Não foi possível encontrar esse produto. Escolha de novo.'
    case 'venda-gratuita': return 'Se tudo for gratuito, anote uma saída por brinde no estoque.'
    case 'parcela-paga-alterada': return 'Já há pagamento nesta venda. Confira o pagamento antes de mudar a venda.'
    case 'recusa-nao-confirmada': return 'Esta anotação ainda não pode ser encerrada. Confira o envio.'
    default: return fraseDaRecusa(motivo)
  }
}
