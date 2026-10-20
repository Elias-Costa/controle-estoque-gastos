import type { MovimentoEstoque } from '../dominio/estoque.ts'
import type { MotivoEstoque } from '../dominio/regras-estoque.ts'

/** Palavras de E-24/26 são hipóteses até E-28; não expõem fila, revisão ou causalidade. */
export const PALAVRAS_DO_ESTOQUE = {
  ver: 'Ver estoque ›', titulo: 'Estoque', compra: 'Anotar compra', inicial: 'Anotar estoque inicial',
  corrigir: 'Corrigir', correcao: 'Corrigir entrada', produto: 'Produto', quantidade: 'Quantidade', contado: 'Total contado',
  custo: 'Custo de cada unidade (se souber)', data: 'Quando foi', dataContagem: 'Data da contagem', total: 'Total da compra',
  desconhecido: 'Não informado', fisico: 'Em estoque', historico: 'O que aconteceu', vazio: 'Ainda não há entradas ou saídas.',
  salvar: 'Pronto', salvando: 'Anotando…', falhaLeitura: 'Não foi possível abrir o estoque. Tente abrir de novo.',
  lendo: 'Abrindo…', falhaGravacao: 'Não foi possível anotar. O que foi digitado continua aqui. Tente de novo.',
  inicialExplicacao: 'Conte o que existe agora e informe a data da contagem. Isso não é uma compra.',
  custoInicial: 'O custo inicial é o informado no cadastro do produto, se conhecido.', cadastro: 'Mudar dados do produto',
  custoAtual: 'Custo de referência', compraExplicacao: 'Pode deixar o custo vazio se não souber. A compra mais recente define o custo das próximas saídas; as anteriores não mudam.',
  correcaoExplicacao: 'Se já foi enviado, o original fica no histórico com sua anulação e a entrada corrigida.',
  afetada: 'Há contagem que precisa ser conferida de novo. A quantidade acima ainda não considera essa contagem.',
  divergencia: 'Há mais saídas anotadas do que entradas. Confira as quantidades.',
  problema: 'Esta anotação precisa de conferência antes de outra correção.',
  anulada: 'Anulada', corrigida: 'Corrigida', conferir: 'Conferir contagem',
  ajuste: 'Ajustar estoque', corrigirAjuste: 'Corrigir ajuste', motivo: 'Motivo', escolherMotivo: 'Escolha o motivo',
  efeito: 'Efeito desta anotação', efeitoCorrigido: 'Efeito da anotação corrigida', resolvida: 'Conferida novamente',
  contagemExplicacao: 'Informe o total que contou agora. A diferença é calculada pelo estoque físico, sem descontar o que está prometido.',
  corrigirContagemExplicacao: 'Corrija o total anotado naquela contagem. Se contou de novo agora, volte e use “Conferir contagem”.',
  correcaoAjusteExplicacao: 'Se já foi enviado, o original fica no histórico com sua anulação e o ajuste corrigido.',
} as const

/** Motivos aprovados de RF-14: seleção obrigatória, sem acrescentar despesa ou caixa de F3. */
export const MOTIVOS_DO_AJUSTE = [
  { valor: 'perda', rotulo: 'Perda' }, { valor: 'quebra', rotulo: 'Quebra' },
  { valor: 'uso-pessoal', rotulo: 'Uso pessoal' }, { valor: 'brinde', rotulo: 'Brinde' },
  { valor: 'conferencia', rotulo: 'Correção de contagem' },
] as const

/** Sinal explícito da diferença, inclusive zero, sem pedir que ela calcule a saída. */
export function quantidadeComSinal(quantidade: number): string {
  return quantidade > 0 ? `+${quantidade}` : quantidade < 0 ? `−${-quantidade}` : '0'
}

/** O tipo do movimento vira o fato reconhecível no histórico, inclusive inversos e saídas existentes. */
export function nomeDoMovimento(movimento: MovimentoEstoque): string {
  switch (movimento.tipo) {
    case 'compra': return 'Compra'
    case 'contagem': return movimento.motivo === 'estoque-inicial' ? 'Estoque inicial' : 'Contagem'
    case 'anulacao': return 'Anulação da entrada ou saída'
    case 'entrega': return 'Entrega'
    case 'retorno': return 'Retorno'
    case 'saida': return { perda: 'Perda', quebra: 'Quebra', 'uso-pessoal': 'Uso pessoal', brinde: 'Brinde' }[movimento.motivo]
  }
}

/** Recusas locais e concorrentes permanecem visíveis, sem sugerir que uma falha de rede desfez o fato. */
export function fraseDaGuardaDaEntrada(motivo: MotivoEstoque): string {
  switch (motivo) {
    case 'quantidade-invalida': return 'Informe uma quantidade inteira. Na compra, precisa ser maior que zero.'
    case 'custo-invalido': return 'Confira o custo ou deixe vazio se não souber.'
    case 'data-invalida': return 'Informe uma data válida, até hoje.'
    case 'produto-inexistente': return 'Escolha o produto.'
    case 'confirmacao-necessaria': return PALAVRAS_DO_ESTOQUE.problema
    case 'alvo-invalido': case 'ja-anulado': case 'revisao-invalida': return 'Essa entrada mudou. Volte ao estoque e confira antes de corrigir.'
    default: return PALAVRAS_DO_ESTOQUE.falhaGravacao
  }
}

/** Guardas de RF-14 distinguem saída positiva de total contado que pode ser zero. */
export function fraseDaGuardaDoAjuste(motivo: MotivoEstoque): string {
  switch (motivo) {
    case 'motivo-obrigatorio': return 'Escolha o motivo do ajuste.'
    case 'quantidade-invalida': return 'Informe uma quantidade inteira. Para uma saída, precisa ser maior que zero; na contagem, pode ser zero.'
    case 'alvo-invalido': case 'ja-anulado': case 'revisao-invalida': return 'Esse ajuste mudou. Volte ao estoque e confira antes de corrigir.'
    default: return fraseDaGuardaDaEntrada(motivo)
  }
}
