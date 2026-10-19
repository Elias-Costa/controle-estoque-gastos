import type { ProdutoLocal } from '../dados/banco.ts'
import type { EvidenciaBase, MovimentoEstoque, ReferenciaEfeito } from '../dominio/estoque.ts'
import type { Categoria, Produto } from '../dominio/produtos.ts'
import type { EncerramentoTentativa } from '../dominio/recuperacao-estoque.ts'
import type { GrupoEstoque } from '../dominio/vendas-estoque.ts'
import { lancamentoDaNuvem, normalizarCarimbo } from './borda.ts'

/** Documento JSON da RPC: centavos/carimbo lógico são texto, quantidades são inteiros seguros. */
export type DocumentoEstoque = Readonly<Record<string, unknown>>
/** Uma posição completa na ordem de commit por conta (Q38). */
export type RecepcaoEstoque = { readonly recepcao: string } & (
  | { readonly tipo: 'operacao'; readonly grupo: GrupoEstoque; readonly evidencias: readonly MovimentoEstoque[]; readonly encerramentoId?: string }
  | { readonly tipo: 'encerramento'; readonly encerramento: EncerramentoTentativa }
)

function erro(campo: string): never { throw new Error(`estoque da nuvem malformado: ${campo}`) }
function objeto(valor: unknown): DocumentoEstoque {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return erro('objeto')
  return { ...valor }
}
function texto(valor: unknown): string { return typeof valor === 'string' ? valor : erro('texto') }
function inteiro(valor: unknown, minimo = 0): number {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= minimo ? valor : erro('inteiro')
}
function digitos(valor: unknown): string { return typeof valor === 'string' && /^\d+$/.test(valor) ? valor : erro('dígitos') }
function lista<T>(valor: unknown, ler: (item: unknown) => T): T[] {
  return Array.isArray(valor) ? valor.map(ler) : erro('lista')
}
function opcional<T>(campo: string, valor: unknown, ler: (item: unknown) => T): { [chave: string]: T } {
  return valor === undefined || valor === null ? {} : { [campo]: ler(valor) }
}
function escolha<T extends string>(valor: unknown, opcoes: readonly T[]): T {
  return opcoes.find((opcao) => opcao === valor) ?? erro('tipo')
}
function referencia(valor: unknown): ReferenciaEfeito {
  const c = objeto(valor)
  return { id: texto(c['id']), revisao: inteiro(c['revisao'], 1) }
}

/** Serializa o contrato do domínio sem arredondar bigint nem enviar campos undefined. */
export function documentoEstoque(valor: object): DocumentoEstoque {
  return objeto(JSON.parse(JSON.stringify(valor, (_chave, item: unknown) => typeof item === 'bigint' ? String(item) : item)))
}

/** Categoria conserva a identidade mesmo quando outra tem o mesmo nome (Q46A). */
export function categoriaDaNuvem(valor: unknown): Categoria {
  const c = objeto(valor)
  return { id: texto(c['id']), nome: texto(c['nome']) }
}

/** Cadastro inteiro, sem misturar campos de versões LWW e sem confundir zero com ausência. */
export function produtoDaNuvem(valor: unknown): ProdutoLocal {
  const c = objeto(valor)
  return { id: texto(c['id']), nome: texto(c['nome']), categoriaId: texto(c['categoria_id']),
    ...opcional('marca', c['marca'], texto), ...opcional('codigoCatalogo', c['codigo_catalogo'], texto),
    ...opcional('fotoId', c['foto_id'], texto),
    ...opcional('custoManual', c['custo_manual'], (v) => BigInt(digitos(v))),
    ...opcional('precoVenda', c['preco_venda'], (v) => BigInt(digitos(v))),
    ...opcional('estoqueMinimo', c['estoque_minimo'], (v) => inteiro(v)),
    atualizadoEm: normalizarCarimbo('produto.atualizado_em', c['atualizado_em']) }
}

/** Movimento completo e suas evidências causais; ordemCadastro nunca passa por number. */
export function movimentoDaNuvem(valor: unknown): MovimentoEstoque {
  const c = objeto(valor)
  const base = { ...referencia(c), operacaoId: texto(c['operacaoId']), produtoId: texto(c['produtoId']),
    data: texto(c['data']), conhecidos: lista(c['conhecidos'], referencia) }
  const custo = opcional('custoUnitario', c['custoUnitario'], (v) => BigInt(digitos(v)))
  switch (c['tipo']) {
    case 'compra': return { ...base, tipo: 'compra', quantidade: inteiro(c['quantidade'], 1), ...custo,
      ordemCadastro: BigInt(digitos(c['ordemCadastro'])), ...opcional('compraOriginalId', c['compraOriginalId'], texto) }
    case 'entrega': return { ...base, tipo: 'entrega', quantidade: inteiro(c['quantidade']), itemId: texto(c['itemId']), ...custo }
    case 'retorno': return { ...base, tipo: 'retorno', quantidade: inteiro(c['quantidade'], 1), itemId: texto(c['itemId']) }
    case 'saida': return { ...base, tipo: 'saida', quantidade: inteiro(c['quantidade'], 1),
      motivo: escolha(c['motivo'], ['perda', 'quebra', 'uso-pessoal', 'brinde']) }
    case 'anulacao': return { ...base, tipo: 'anulacao', alvo: referencia(c['alvo']) }
    case 'contagem': return { ...base, tipo: 'contagem', totalContado: inteiro(c['totalContado']),
      motivo: escolha(c['motivo'], ['estoque-inicial', 'conferencia']), resolvidas: lista(c['resolvidas'], referencia),
      base: lista(c['base'], (v): EvidenciaBase => {
        const e = objeto(v)
        if (typeof e['aplicada'] !== 'boolean') return erro('base.aplicada')
        return { ...referencia(e), tipo: escolha(e['tipo'], ['compra', 'entrega', 'retorno', 'saida', 'anulacao', 'contagem']),
          quantidade: inteiro(e['quantidade'], -Number.MAX_SAFE_INTEGER), aplicada: e['aplicada'], conhecidos: lista(e['conhecidos'], referencia) }
      }) }
    default: return erro('movimento.tipo')
  }
}

/** Confere o manifesto antes de expor qualquer efeito ao IndexedDB (Q37). */
export function grupoDaNuvem(valor: unknown): GrupoEstoque {
  const g = objeto(valor), op = objeto(g['operacao'])
  if (op['formato'] !== 1) return erro('formato')
  const grupo: GrupoEstoque = {
    operacao: { ...referencia(op), formato: 1, tipo: escolha(op['tipo'], ['venda', 'entrega', 'cancelamento', 'retorno', 'correcao', 'movimento', 'troca']),
      lancamentos: lista(op['lancamentos'], referencia), movimentos: lista(op['movimentos'], referencia),
      dependencias: lista(op['dependencias'], referencia), ...opcional('alvo', op['alvo'], referencia) },
    lancamentos: lista(g['lancamentos'], (v) => {
      const l = objeto(v)
      return lancamentoDaNuvem({ ...l, cliente_id: l['clienteId'], estorna_id: l['estornaId'] })
    }), movimentos: lista(g['movimentos'], movimentoDaNuvem) }
  const o = grupo.operacao
  if (o.lancamentos.length !== grupo.lancamentos.length || o.movimentos.length !== grupo.movimentos.length ||
    new Set(o.lancamentos.map((r) => r.id)).size !== o.lancamentos.length || new Set(o.movimentos.map((r) => r.id)).size !== o.movimentos.length ||
    o.lancamentos.some((r) => r.revisao !== o.revisao || !grupo.lancamentos.some((l) => l.id === r.id)) ||
    o.movimentos.some((r) => !grupo.movimentos.some((m) => m.id === r.id && m.revisao === r.revisao && m.operacaoId === o.id))) return erro('grupo incompleto')
  return grupo
}

/** Evidência textual da tentativa permanece idêntica; seus grupos voltam com bigint. */
export function encerramentoDaNuvem(valor: unknown): EncerramentoTentativa {
  const c = objeto(valor), t = objeto(c['tentativa']), e = objeto(c['evidencia'])
  if (e['desfecho'] !== 'recusada') return erro('desfecho')
  const grupo = grupoDaNuvem(e['grupo'])
  const tentativa = { ...referencia(t), conteudo: texto(t['conteudo']) }
  if (tentativa.id !== grupo.operacao.id || tentativa.revisao !== grupo.operacao.revisao) return erro('identidade da tentativa')
  return { id: texto(c['id']), data: texto(c['data']), tentativa,
    evidencia: { grupo, desfecho: 'recusada', diagnostico: texto(e['diagnostico']) },
    aceitosConhecidos: lista(c['aceitosConhecidos'], grupoDaNuvem), ...opcional('novaOperacao', c['novaOperacao'], grupoDaNuvem) }
}

/** Decodifica uma posição sem interpretar seu contador como dinheiro ou relógio. */
export function recepcaoDaNuvem(valor: unknown): RecepcaoEstoque {
  const c = objeto(valor), recepcao = digitos(c['recepcao'])
  if (c['tipo'] === 'operacao') return { recepcao, tipo: 'operacao', grupo: grupoDaNuvem(c['grupo']),
    evidencias: lista(c['evidencias'], movimentoDaNuvem), ...opcional('encerramentoId', c['encerramentoId'], texto) }
  if (c['tipo'] === 'encerramento') return { recepcao, tipo: 'encerramento', encerramento: encerramentoDaNuvem(c['encerramento']) }
  return erro('recepção.tipo')
}

/** Colunas completas do cadastro, incluindo os opcionais que uma edição pode remover. */
export const COLUNAS_PRODUTO = 'id, nome, categoria_id, marca, codigo_catalogo, foto_id, custo_manual::text, preco_venda::text, estoque_minimo, atualizado_em, recebido_em'
/** Categoria não é unida por nome ao ser recebida. */
export const COLUNAS_CATEGORIA = 'id, nome'

/** Forma física de produto, útil para conferir ida/volta de todas as colunas. */
export function produtoParaLinha(produto: Produto): DocumentoEstoque {
  return { id: produto.id, nome: produto.nome, categoria_id: produto.categoriaId, marca: produto.marca ?? null,
    codigo_catalogo: produto.codigoCatalogo ?? null, foto_id: produto.fotoId ?? null,
    custo_manual: produto.custoManual === undefined ? null : String(produto.custoManual),
    preco_venda: produto.precoVenda === undefined ? null : String(produto.precoVenda), estoque_minimo: produto.estoqueMinimo ?? null }
}
