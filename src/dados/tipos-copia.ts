import type { BancoLocal, ClienteLocal, EncerramentoLocal, ItemDaFila, OperacaoLocal, ProdutoLocal, RelogioEstoque, VersaoEstoque, CursorDeDownload } from './banco.ts'
import type { Categoria } from '../dominio/produtos.ts'
import type { Lancamento } from '../dominio/ficha.ts'
import type { MovimentoEstoque } from '../dominio/estoque.ts'
import type { FatoCaixa } from '../dominio/gastos.ts'
import type { OperacaoCaixaLocal, VersaoCaixa } from './tipos-caixa.ts'
import type { EnvioProdutoFoto, EstadoFotos, FotoLocal, ProtecaoFotoLocal, UsoFotoLocal } from './tipos-fotos.ts'
import type { PreferenciaModelos } from './modelos-whatsapp.ts'
import type { PreferenciaIdentidadeLoja } from './identidade-loja.ts'

/** Dono e destino da base; nunca contém credenciais (D-071, RNF-07). */
export type VinculoConta = { readonly contaId: string; readonly destino: string }
/** Evidência de colisão F1 durante a restauração; o aceite é a projeção corrente. */
export type EvidenciaCopia = { readonly id: string; readonly tentativa: Lancamento; readonly aceita: Lancamento }
/** Todas as tabelas de uso; temporários de preparação não são dados do negócio. */
export type DadosCopia = {
  clientes: ClienteLocal[]; lancamentos: Lancamento[]; fila: ItemDaFila[]; sincronizacao: CursorDeDownload[]
  categorias: Categoria[]; produtos: ProdutoLocal[]; operacoes: OperacaoLocal[]; movimentos: MovimentoEstoque[]
  versoesEstoque: VersaoEstoque[]; encerramentos: EncerramentoLocal[]; relogioEstoque: RelogioEstoque[]
  fotos: FotoLocal[]; protecoesFotos: ProtecaoFotoLocal[]; enviosProdutoFoto: EnvioProdutoFoto[]
  usosFotos: UsoFotoLocal[]; estadoFotos: EstadoFotos[]; fatosCaixa: FatoCaixa[]
  operacoesCaixa: OperacaoCaixaLocal[]; versoesCaixa: VersaoCaixa[]; evidenciasCopia: EvidenciaCopia[]
  modelos: PreferenciaModelos[]
  identidadesLoja: PreferenciaIdentidadeLoja[]
}
/** Lista explícita: nova tabela de uso exige formato e prova, nunca exportação automática de sessão. */
export const TABELAS_COPIA_V1 = ['clientes', 'lancamentos', 'fila', 'sincronizacao', 'categorias', 'produtos',
  'operacoes', 'movimentos', 'versoesEstoque', 'encerramentos', 'relogioEstoque', 'fotos', 'protecoesFotos',
  'enviosProdutoFoto', 'usosFotos', 'estadoFotos', 'fatosCaixa', 'operacoesCaixa', 'versoesCaixa', 'evidenciasCopia'] as const
/** D-072: formato 2/esquema 7 acrescenta modelos; formato anterior tem lista fechada própria. */
export const TABELAS_COPIA_V2 = [...TABELAS_COPIA_V1, 'modelos'] as const
/** E-28D/D-076: formato 3/esquema 9 conserva identidade/logo e classificação das capturas. */
export const TABELAS_COPIA = [...TABELAS_COPIA_V2, 'identidadesLoja'] as const
/** Nome de tabela permitido no pacote atual. */
export type TabelaCopia = typeof TABELAS_COPIA[number]
/** Controle durável da conta e da barreira de primeiro envio; ausência não apaga dados existentes. */
export type ControleCopia = { readonly chave: 'conta'; readonly vinculo: VinculoConta } |
  { readonly chave: 'restauracao'; readonly id: string; readonly fase: 'escolher' | 'reconciliar' | 'proteger' } |
  { readonly chave: `registro:${string}`; readonly conteudo: string }
/** Cabeçalho do estágio, que só publica depois de validar todos os lotes. */
export type EstagioCopia = { readonly id: string; readonly tipo: 'exportacao' | 'importacao'; readonly vinculo: VinculoConta
  readonly capturadoEm: string; readonly pronto: boolean; readonly publicada?: boolean; readonly usos?: readonly string[] }
/** Lotes limitam o trabalho de leitura e mantêm os bytes fora do JSON. */
export type LoteCopia = { readonly id: string; readonly operacaoId: string; readonly tabela: TabelaCopia; readonly linhas: readonly unknown[] }
/** Tetos aprovados D-071; exceder recusa a operação inteira, nunca trunca. */
export const LIMITES_COPIA = { arquivo: 256 * 1024 * 1024, textos: 64 * 1024 * 1024,
  lote: 8 * 1024 * 1024, manifesto: 2 * 1024 * 1024, entradas: 10_000, registros: 250_000 } as const
/** Escopo completo protege captura/publicação contra qualquer escrita concorrente de uso. */
export function tabelasDaCopia(banco: BancoLocal) { return TABELAS_COPIA.map((nome) => banco.table<unknown>(nome)) }
