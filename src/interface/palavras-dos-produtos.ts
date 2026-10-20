import type { MotivoEstoque } from '../dominio/regras-estoque.ts'

/** Palavras de E-23: apresentação aprovada pelo mantenedor, hipótese de uso até E-28 (RI-07). */
export const PALAVRAS_DOS_PRODUTOS = {
  titulo: 'Produtos', novo: '+ Novo produto', cadastro: 'Novo produto', editar: 'Mudar produto', salvar: 'Salvar',
  nome: 'Nome', categoria: 'Categoria', escolherCategoria: 'Escolha a categoria', novaCategoria: '+ Nova categoria',
  nomeCategoria: 'Nome da categoria', criarCategoria: 'Usar esta categoria', fecharCategoria: 'Deixar para depois',
  marca: 'Marca', codigo: 'Código do catálogo', custo: 'Preço de custo', preco: 'Preço de venda', minimo: 'Estoque mínimo',
  opcionais: 'Só nome e categoria são obrigatórios.', vazio: 'Nenhum produto ainda', lendo: 'Abrindo os produtos…',
  falhaLeitura: 'Não consegui abrir os produtos. Tente abrir de novo.',
  falhaGravacao: 'Não consegui salvar. Os dados continuam aqui. Tente de novo.',
  parecido: 'Já existe um produto parecido. Confira antes de salvar.',
  categoriasIguais: 'Há categorias com o mesmo nome. Os números distinguem as opções. Cada produto continua na categoria escolhida. Confira antes de salvar.',
  custoCompra: 'Custo da última compra', corrigirCompra: 'Para mudar este custo, corrija a entrada da compra.',
  desconhecido: 'Não informado', zero: 'Gratuito', semFoto: 'Sem foto', aguardandoFoto: 'Foto ainda não chegou neste aparelho',
  tirarFoto: 'Tirar foto', escolherFoto: 'Escolher foto', preparando: 'Preparando a foto…',
  falhaFoto: 'Não consegui preparar esta foto. Tente outra. Ao salvar, fica a foto exibida.',
  fotoProtegida: 'Não consegui abrir a foto para mudar o produto. Volte e abra de novo.',
  abrindoFoto: 'Abrindo a foto para mudar o produto…',
  salvando: 'Salvando…', criandoCategoria: 'Guardando a categoria…',
  noMinimo: 'No mínimo', disponivel: 'Disponível', prometido: 'Prometido', faltam: 'Faltam',
  explicacaoDoMinimo: 'Produtos com estoque físico menos o prometido igual ou abaixo do mínimo. Só aparecem os que têm mínimo informado.',
  vazioNoMinimo: 'Nenhum produto no mínimo',
} as const

/** Traduz as guardas locais antes do toque em Salvar, sem código técnico na tela. */
export function fraseDaGuardaDoProduto(motivo: MotivoEstoque): string {
  switch (motivo) {
    case 'nome-obrigatorio': return 'Falta o nome do produto.'
    case 'categoria-obrigatoria': return 'Escolha uma categoria ou crie uma nova.'
    case 'categoria-inexistente': return 'Escolha uma categoria da lista.'
    case 'custo-invalido': return 'Confira o preço de custo.'
    case 'preco-negativo': return 'Confira o preço de venda.'
    case 'quantidade-invalida': return 'O mínimo precisa ser um número inteiro, de zero para cima.'
    case 'custo-definido-por-compra': return 'O custo mudou com uma compra. Abra o produto de novo para conferir.'
    default: return PALAVRAS_DOS_PRODUTOS.falhaGravacao
  }
}
