import type { MotivoCaixa } from '../dominio/gastos.ts'

/** Palavras propostas para RF-16–18; reconhecimento pela usuária ainda não observado. */
export const PALAVRAS_DO_CAIXA = {
  titulo: 'Caixa', mes: 'Mês', mostrar: 'Mostrar', tudo: 'Tudo', negocio: 'Negócio', pessoal: 'Pessoal',
  entrou: 'Entrou', saiu: 'Saiu', diferenca: 'Diferença do mês',
  alcance: 'Entradas e saídas anotadas neste mês. Gastos antigos podem não estar todos aqui. A diferença não é o dinheiro disponível na carteira ou no banco.',
  vazio: 'Nenhuma entrada ou saída anotada neste mês para esta escolha.',
  escolherMes: 'Escolha o mês para consultar.',
  movimentos: 'Entradas e saídas', historico: 'Histórico das anotações',
  despesa: 'Anotar gasto', receita: 'Anotar entrada avulsa', corrigir: 'Corrigir',
  correcao: 'Corrigir anotação', valor: 'Quanto', data: 'Quando foi', categoria: 'Categoria',
  classificacao: 'De onde', mercadoria: 'Foi pagamento de mercadoria?', sim: 'Sim', nao: 'Não',
  mercadoriaExplicacao: 'Anote o valor pago. A entrada dos produtos no estoque é anotada em Produtos.',
  receitaExplicacao: 'Venda à vista e dinheiro recebido na fichinha já aparecem no caixa. Anote aqui outras entradas.',
  compra: 'Pagamento de mercadoria', gasto: 'Gasto', entrada: 'Entrada avulsa',
  venda: 'Venda à vista', recebimento: 'Recebimento',
  salvar: 'Pronto', salvando: 'Anotando…', lendo: 'Abrindo…',
  falhou: 'Não foi possível abrir as anotações neste aparelho. Feche e abra de novo.',
  falhaAoGravar: 'Não foi possível guardar a anotação neste aparelho. Tente de novo.',
  mudou: 'Esta anotação mudou. Volte ao caixa e confira antes de corrigir.',
  desfazer: 'Desfazer esta anotação', confirmarDesfazer: 'Sim, desfazer', manter: 'Deixar como está',
  desfazerExplicacao: 'Use para corrigir uma anotação errada. Isso retira o valor do mês original e conserva o histórico. Dinheiro realmente devolvido deve ser anotado separadamente na data em que entrou ou saiu.',
  corrigirExplicacao: 'A correção acerta a anotação no mês em que o dinheiro entrou ou saiu e conserva o histórico. Não cria outra entrada ou saída na data de hoje.',
  enviada: 'Enviada', anterior: 'Anotação anterior', anotada: 'Anotada neste aparelho',
  desfeita: 'Desfez uma anotação', conferir: 'Anotações para conferir',
  recusada: 'Esta tentativa não foi aceita.', dependente: 'Esta anotação depende de uma tentativa que não foi aceita.',
  copiada: 'Esta anotação veio de uma cópia anterior ao que já estava guardado na conta.',
  fora: 'Não entra nos totais. Os totais usam a anotação aceita; podem ter mudado ao receber as anotações do outro aparelho.',
  provisoria: 'Ainda entra nos totais deste aparelho. Confira antes de anotar novamente.',
} as const

/** Traduz recusas sem expor códigos ou pedir decisão técnica (RI-07/08). */
export function fraseDaGuardaDoCaixa(motivo: MotivoCaixa): string {
  switch (motivo) {
    case 'valor-invalido': return 'Informe um valor maior que zero.'
    case 'categoria-obrigatoria': return 'Escreva a categoria desta anotação.'
    case 'classificacao-invalida': return 'Escolha negócio ou pessoal.'
    case 'mercadoria-invalida': return 'Pagamento de mercadoria precisa estar marcado como negócio.'
    case 'data-invalida': return 'Confira a data da anotação.'
    case 'envio-com-problema': return 'Esta anotação precisa de conferência no caixa antes de ser corrigida.'
    default: return PALAVRAS_DO_CAIXA.mudou
  }
}
