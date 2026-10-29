import type { BancoLocal, ClienteLocal, CursorDeDownload, EncerramentoLocal, ItemDaFila, OperacaoLocal, ProdutoLocal, RelogioEstoque, VersaoEstoque } from './banco.ts'
import type { Categoria } from '../dominio/produtos.ts'
import { novoProduto } from '../dominio/produtos.ts'
import { validar, type Lancamento } from '../dominio/ficha.ts'
import { chaveDoEfeito, type MovimentoEstoque } from '../dominio/estoque.ts'
import { conteudoDoEfeito, diaValido } from '../dominio/regras-estoque.ts'
import type { GrupoEstoque } from '../dominio/vendas-estoque.ts'
import type { FatoCaixa } from '../dominio/gastos.ts'
import type { GrupoCaixa, OperacaoCaixaLocal, VersaoCaixa } from './tipos-caixa.ts'
import { LIMITE_FOTO_BYTES, LIMITE_MINIATURA_BYTES, type EnvioProdutoFoto, type EstadoFotos, type FotoLocal, type ProtecaoFotoLocal, type UsoFotoLocal } from './tipos-fotos.ts'
import { LIMITES_COPIA, TABELAS_COPIA, type DadosCopia, type EvidenciaCopia, type TabelaCopia, type VinculoConta } from './tipos-copia.ts'
import { preferenciaModelosValida } from './modelos-whatsapp.ts'
import { preferenciaIdentidadeValida } from './identidade-loja.ts'

/** Recusa de arquivo/preparação: códigos ficam na borda; a tela apresenta palavras próprias. */
export class ErroCopia extends Error {
  readonly motivo: 'arquivo' | 'limite' | 'conta' | 'vazia' | 'foto' | 'entrar' | 'estagio'
  constructor(motivo: ErroCopia['motivo']) { super(`Cópia: ${motivo}`); this.motivo = motivo }
}
/** Guarda sem coerção: falhar nunca publica um subconjunto (D-071). */
export function exigirCopia(condicao: unknown, motivo: ErroCopia['motivo'] = 'arquivo'): asserts condicao {
  if (!condicao) throw new ErroCopia(motivo)
}
/** Objeto JSON sem arrays, usado pelos validadores exatos. */
export function objetoCopia(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v) }
type Guarda = (v: unknown) => boolean
const texto: Guarda = (v) => typeof v === 'string'
const preenchido: Guarda = (v) => typeof v === 'string' && !!v.trim()
const id: Guarda = (v) => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)
const inteiro: Guarda = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const positivo: Guarda = (v) => inteiro(v) && typeof v === 'number' && v > 0
const comSinal: Guarda = (v) => typeof v === 'number' && Number.isSafeInteger(v)
const centavos: Guarda = (v) => typeof v === 'bigint' && v >= 0n
const dinheiroPositivo: Guarda = (v) => typeof v === 'bigint' && v > 0n
const booleano: Guarda = (v) => typeof v === 'boolean'
const dia: Guarda = (v) => typeof v === 'string' && diaValido(v)
const instante: Guarda = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(new Date(v).getTime())
const hash: Guarda = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const bytes = (maximo: number): Guarda => (v) => v instanceof Uint8Array && v.byteLength > 0 && v.byteLength <= maximo
const escolha = (...valores: readonly unknown[]): Guarda => (v) => valores.includes(v)
const lista = (guarda: Guarda): Guarda => (v) => Array.isArray(v) && v.every(guarda)
function campos(v: unknown, obrigatorios: Record<string, Guarda>, opcionais: Record<string, Guarda> = {}): boolean {
  return objetoCopia(v) && Object.keys(v).every((k) => Object.hasOwn(obrigatorios, k) || Object.hasOwn(opcionais, k)) &&
    Object.entries(obrigatorios).every(([k, g]) => Object.hasOwn(v, k) && g(v[k])) &&
    Object.entries(opcionais).every(([k, g]) => v[k] === undefined || g(v[k]))
}
const ref = (v: unknown) => campos(v, { id, revisao: positivo })
const problema = (v: unknown) => campos(v, { codigo: texto, mensagem: texto, em: instante }, { constraint: texto })
const parcela = (v: unknown) => campos(v, { id, vencimento: dia, valor: centavos })
// D-078 conserva o histórico sem descrição; a guarda de escrita continua no domínio.
const item = (v: unknown) => campos(v, { descricao: texto, preco: centavos },
  { id, produtoId: id, quantidade: positivo, precoUnitario: centavos }) && objetoCopia(v) &&
  (v['id'] === undefined ? v['produtoId'] === undefined && v['quantidade'] === undefined && v['precoUnitario'] === undefined
    : positivo(v['quantidade']) && centavos(v['precoUnitario']) && typeof v['preco'] === 'bigint' && typeof v['precoUnitario'] === 'bigint' &&
      typeof v['quantidade'] === 'number' && v['preco'] === v['precoUnitario'] * BigInt(v['quantidade']))

function cliente(v: unknown): v is ClienteLocal {
  // Bases F1 v1 podem ter cadastro sem carimbo até sua primeira edição; não inventar um novo.
  return campos(v, { id, nome: preenchido }, { atualizadoEm: instante, telefone: texto, apelido: texto, observacao: texto, desativadoEm: dia })
}
function formaLancamento(v: unknown): v is Lancamento {
  if (!objetoCopia(v)) return false
  const base = { id, clienteId: id, data: dia, tipo: texto }
  if (v['tipo'] === 'venda') {
    const comum = { ...base, pagamento: escolha('avista', 'fiado'), itens: lista(item), desconto: centavos }
    return (v['pagamento'] === 'fiado' ? campos(v, { ...comum, parcelas: lista(parcela) })
      : campos(v, { ...comum, forma: escolha('pix', 'dinheiro', 'outro') }))
  }
  if (v['tipo'] === 'saldo-anterior') return campos(v, { ...base, parcelas: lista(parcela) })
  if (v['tipo'] === 'estorno') return campos(v, { ...base, estornaId: id }, { motivo: texto })
  if (v['tipo'] === 'recebimento') return campos(v, { ...base, valor: dinheiroPositivo, forma: escolha('pix', 'dinheiro', 'outro') }, { observacao: texto })
  return v['tipo'] === 'desconto-quitacao' && campos(v, { ...base, valor: dinheiroPositivo }) && typeof v['valor'] === 'bigint' && v['valor'] <= 10n
}
function lancamento(v: unknown): v is Lancamento {
  return formaLancamento(v) && ((v.tipo === 'venda' || v.tipo === 'saldo-anterior') ? validar([v]).ok : true)
}
function categoria(v: unknown): v is Categoria { return campos(v, { id, nome: preenchido }) }
function produto(v: unknown): v is ProdutoLocal {
  return campos(v, { id, nome: preenchido, categoriaId: id, atualizadoEm: instante },
    { marca: texto, codigoCatalogo: texto, fotoId: id, custoManual: centavos, precoVenda: centavos, estoqueMinimo: inteiro,
      classificacao: escolha('feminino', 'masculino', 'unissex', 'nao-se-aplica'), classificacaoConhecida: escolha(true) })
}
function movimento(v: unknown): v is MovimentoEstoque {
  if (!objetoCopia(v)) return false
  const base = { id, revisao: positivo, operacaoId: id, produtoId: id, data: dia, conhecidos: lista(ref), tipo: texto }
  switch (v['tipo']) {
    case 'compra': return campos(v, { ...base, quantidade: positivo, ordemCadastro: centavos }, { custoUnitario: centavos, compraOriginalId: id })
    case 'entrega': return campos(v, { ...base, quantidade: inteiro, itemId: id }, { custoUnitario: centavos })
    case 'retorno': return campos(v, { ...base, quantidade: positivo, itemId: id })
    case 'saida': return campos(v, { ...base, quantidade: positivo, motivo: escolha('perda', 'quebra', 'uso-pessoal', 'brinde') })
    case 'anulacao': return campos(v, { ...base, alvo: ref })
    case 'contagem': return campos(v, { ...base, totalContado: inteiro, motivo: escolha('estoque-inicial', 'conferencia'), resolvidas: lista(ref),
      base: lista((e) => campos(e, { id, revisao: positivo, tipo: escolha('compra', 'entrega', 'retorno', 'saida', 'contagem', 'anulacao'), quantidade: comSinal, aplicada: booleano, conhecidos: lista(ref) })) })
    default: return false
  }
}
const camposOperacao = { id, revisao: positivo, formato: escolha(1), tipo: escolha('venda', 'entrega', 'cancelamento', 'retorno', 'correcao', 'movimento', 'troca'),
  lancamentos: lista(ref), movimentos: lista(ref), dependencias: lista(ref) }
function operacao(v: unknown): v is OperacaoLocal { return campos(v, { ...camposOperacao, versaoId: id }, { alvo: ref }) }
function grupo(v: unknown): v is GrupoEstoque {
  if (!campos(v, { operacao: (o) => campos(o, camposOperacao, { alvo: ref }), lancamentos: lista(lancamento), movimentos: lista(movimento) }) || !objetoCopia(v)) return false
  const o = v['operacao'], ls = v['lancamentos'], ms = v['movimentos']
  if (!objetoCopia(o) || !Array.isArray(ls) || !Array.isArray(ms) || !Array.isArray(o['lancamentos']) || !Array.isArray(o['movimentos'])) return false
  return conteudoDoEfeito(o['lancamentos']) === conteudoDoEfeito(ls.map((l: Lancamento) => ({ id: l.id, revisao: o['revisao'] }))) &&
    conteudoDoEfeito(o['movimentos']) === conteudoDoEfeito(ms.map((m: MovimentoEstoque) => ({ id: m.id, revisao: m.revisao }))) &&
    ms.every((m: MovimentoEstoque) => m.operacaoId === o['id'])
}
function versao(v: unknown): v is VersaoEstoque {
  return campos(v, { id, operacaoId: id, grupo }, { aceita: booleano, problema, legadoId: id, restaurada: booleano }) &&
    objetoCopia(v) && grupo(v['grupo']) && v['operacaoId'] === v['grupo'].operacao.id
}
function encerramento(v: unknown): v is EncerramentoLocal {
  return campos(v, { id, data: dia, tentativa: (t) => campos(t, { id, revisao: positivo, conteudo: texto }),
    evidencia: (e) => campos(e, { grupo, desfecho: escolha('recusada', 'resposta-perdida'), diagnostico: texto }), aceitosConhecidos: lista(grupo) }, { novaOperacao: grupo, remotoId: id })
}
function fato(v: unknown): v is FatoCaixa {
  if (!objetoCopia(v)) return false
  const base = { id, revisao: positivo, data: dia, tipo: texto }
  if (v['tipo'] === 'estorno') return campos(v, { ...base, alvo: ref })
  const mov = { ...base, valor: dinheiroPositivo, categoria: preenchido, classificacao: escolha('negocio', 'pessoal') }
  return v['tipo'] === 'receita-avulsa' ? campos(v, mov) : v['tipo'] === 'despesa' &&
    campos(v, { ...mov, mercadoria: booleano }) && (!v['mercadoria'] || v['classificacao'] === 'negocio')
}
const camposOpCaixa = { id, revisao: positivo, formato: escolha(1), tipo: escolha('registro', 'estorno', 'correcao'), fatos: lista(ref) }
function opCaixa(v: unknown): v is OperacaoCaixaLocal { return campos(v, { ...camposOpCaixa, versaoId: id }, { alvo: ref }) }
function grupoCaixa(v: unknown): v is GrupoCaixa {
  if (!campos(v, { operacao: (o) => campos(o, camposOpCaixa, { alvo: ref }), fatos: lista(fato) }) || !objetoCopia(v)) return false
  const o = v['operacao'], fs = v['fatos']
  if (!objetoCopia(o) || !Array.isArray(fs)) return false
  const estornos = fs.filter((f: FatoCaixa) => f.tipo === 'estorno')
  return conteudoDoEfeito(o['fatos']) === conteudoDoEfeito(fs.map((f: FatoCaixa) => ({ id: f.id, revisao: f.revisao }))) &&
    (o['tipo'] === 'registro' ? fs.length === 1 && estornos.length === 0 && !o['alvo']
      : fs.length === (o['tipo'] === 'correcao' ? 2 : 1) && estornos.length === 1 && ref(o['alvo']) &&
        estornos.every((f: FatoCaixa) => f.tipo === 'estorno' && conteudoDoEfeito(f.alvo) === conteudoDoEfeito(o['alvo'])))
}
function versaoCaixa(v: unknown): v is VersaoCaixa {
  return campos(v, { id, operacaoId: id, grupo: grupoCaixa }, { aceita: booleano, problema, restaurada: booleano, foraDaProjecao: (f) => campos(f, { causaId: id }) }) &&
    objetoCopia(v) && grupoCaixa(v['grupo']) && v['operacaoId'] === v['grupo'].operacao.id
}
function fila(v: unknown): v is ItemDaFila {
  return campos(v, { ordem: positivo, tabela: escolha('clientes', 'lancamentos', 'categorias', 'produtos', 'operacoes', 'encerramentos', 'fotos', 'operacoesCaixa', 'modelos', 'identidadeLoja'), registroId: id, criadoEm: instante }, { versao: inteiro, problema })
}
function cursor(v: unknown): v is CursorDeDownload {
  return campos(v, { chave: escolha('clientes', 'lancamentos', 'categorias', 'produtos', 'estoque', 'caixa', 'identidadeLoja'), valor: texto }) && objetoCopia(v) &&
    (v['chave'] === 'estoque' || v['chave'] === 'caixa' ? typeof v['valor'] === 'string' && /^\d+$/.test(v['valor']) : instante(v['valor']))
}
function relogio(v: unknown): v is RelogioEstoque { return campos(v, { chave: escolha('cadastro'), ultimo: centavos }) }
const camposFoto = { id, copiaId: id, produtoId: id, cadastroEm: instante, geracaoEnvio: id, sha256: hash,
  bytes: (v: unknown) => positivo(v) && typeof v === 'number' && v <= LIMITE_FOTO_BYTES,
  largura: (v: unknown) => positivo(v) && typeof v === 'number' && v <= 1024,
  altura: (v: unknown) => positivo(v) && typeof v === 'number' && v <= 1024, situacao: escolha('pendente', 'disponivel', 'superada') }
const caminho: Guarda = (v) => typeof v === 'string' && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpeg$/i.test(v)
function foto(v: unknown): v is FotoLocal {
  return campos(v, camposFoto, { binario: bytes(LIMITE_FOTO_BYTES), miniatura: bytes(LIMITE_MINIATURA_BYTES), caminho, registrada: booleano, geracaoReferencia: id, dispensada: booleano })
}
function protecao(v: unknown): v is ProtecaoFotoLocal {
  return campos(v, { id: preenchido, fotoId: id, copiaId: id, aparelhoId: id, geracao: id, sha256: hash,
    bytes: camposFoto.bytes, largura: camposFoto.largura, altura: camposFoto.altura, caminho, disponivel: booleano }, { liberar: booleano })
}
function envio(v: unknown): v is EnvioProdutoFoto { return campos(v, { id, produtoId: id, cadastro: produto }) }
function uso(v: unknown): v is UsoFotoLocal { return campos(v, { id, fotoId: id }) }
function estadoFoto(v: unknown): v is EstadoFotos { return campos(v, { chave: escolha('aparelho', 'leitura'), valor: id }) }
function evidencia(v: unknown): v is EvidenciaCopia {
  return campos(v, { id, tentativa: lancamento, aceita: lancamento }) && objetoCopia(v) && lancamento(v['tentativa']) &&
    lancamento(v['aceita']) && v['tentativa'].id === v['aceita'].id && v['id'] === v['aceita'].id
}
function lerLista<T>(v: unknown, guarda: (linha: unknown) => linha is T): T[] {
  exigirCopia(Array.isArray(v))
  return v.map((linha: unknown) => { exigirCopia(guarda(linha)); return linha })
}
/** Campos fechados por formato; leitores antigos não aceitam extensões de pacotes novos. */
export function dadosDaCopia(v: unknown, formato: 1 | 2 | 3 = 3): DadosCopia {
  exigirCopia(objetoCopia(v) && Object.keys(v).length === TABELAS_COPIA.length && Object.keys(v).every((k) => TABELAS_COPIA.some((t) => t === k)))
  const dados: DadosCopia = { clientes: lerLista(v['clientes'], cliente), lancamentos: lerLista(v['lancamentos'], lancamento),
    fila: lerLista(v['fila'], fila), sincronizacao: lerLista(v['sincronizacao'], cursor), categorias: lerLista(v['categorias'], categoria),
    produtos: lerLista(v['produtos'], produto), operacoes: lerLista(v['operacoes'], operacao), movimentos: lerLista(v['movimentos'], movimento),
    versoesEstoque: lerLista(v['versoesEstoque'], versao), encerramentos: lerLista(v['encerramentos'], encerramento), relogioEstoque: lerLista(v['relogioEstoque'], relogio),
    fotos: lerLista(v['fotos'], foto), protecoesFotos: lerLista(v['protecoesFotos'], protecao), enviosProdutoFoto: lerLista(v['enviosProdutoFoto'], envio),
    usosFotos: lerLista(v['usosFotos'], uso), estadoFotos: lerLista(v['estadoFotos'], estadoFoto), fatosCaixa: lerLista(v['fatosCaixa'], fato),
    operacoesCaixa: lerLista(v['operacoesCaixa'], opCaixa), versoesCaixa: lerLista(v['versoesCaixa'], versaoCaixa), evidenciasCopia: lerLista(v['evidenciasCopia'], evidencia),
    modelos: lerLista(v['modelos'], preferenciaModelosValida),
    identidadesLoja: lerLista(v['identidadesLoja'], preferenciaIdentidadeValida) }
  exigirCopia(dados.modelos.length <= 1 && dados.identidadesLoja.length <= 1)
  if (formato < 3) {
    exigirCopia(dados.identidadesLoja.length === 0 && !dados.fila.some((f) => f.tabela === 'identidadeLoja') &&
      !dados.sincronizacao.some((c) => c.chave === 'identidadeLoja'))
    for (const p of [...dados.produtos, ...dados.enviosProdutoFoto.map((e) => e.cadastro)]) {
      exigirCopia(!Object.hasOwn(p, 'classificacao') && !Object.hasOwn(p, 'classificacaoConhecida'))
    }
  }
  if (formato === 1) exigirCopia(dados.modelos.length === 0 && !dados.fila.some((f) => f.tabela === 'modelos'))
  validarVinculosCopia(dados)
  return dados
}
/** JSON legível: apenas bigint vira texto; bytes têm arquivos próprios. */
export function jsonDaCopia(v: unknown): string { return JSON.stringify(v, (_k, item: unknown) => typeof item === 'bigint' ? String(item) : item, 2) }
const CAMPOS_INTEIROS = new Set(['valor', 'preco', 'desconto', 'precoUnitario', 'custoManual', 'precoVenda', 'custoUnitario', 'ordemCadastro', 'ultimo'])
/** Recupera apenas campos inteiros conhecidos; número monetário nunca vira bigint por coerção. */
export function lerJsonDaTabela(tabela: TabelaCopia, textoJson: string): unknown {
  return JSON.parse(textoJson, (chave, v: unknown) => {
    if (tabela !== 'sincronizacao' && tabela !== 'estadoFotos' && CAMPOS_INTEIROS.has(chave) && typeof v === 'string') {
      exigirCopia(/^\d+$/.test(v)); return BigInt(v)
    }
    return v
  })
}
/** Vínculo vindo do arquivo é dado, nunca uma sessão ou autorização para outra conta. */
export function lerVinculoCopia(v: unknown): VinculoConta {
  exigirCopia(campos(v, { contaId: id, destino: preenchido }) && objetoCopia(v) && typeof v['contaId'] === 'string' && typeof v['destino'] === 'string')
  return { contaId: v['contaId'], destino: v['destino'] }
}
/** Leitura local consistente; reutilizada por captura e oráculos, sem acesso à rede. */
export async function lerDadosCopia(banco: BancoLocal): Promise<DadosCopia> {
  const pares = await Promise.all(TABELAS_COPIA.map(async (t) => [t, await banco.table<unknown>(t).toArray()]))
  return dadosDaCopia(Object.fromEntries(pares))
}
/** Valida ligações e conteúdo, sem usar saldos/totais CSV como fonte de verdade. */
export function validarVinculosCopia(d: DadosCopia): void {
  exigirCopia(Object.values(d).reduce((n, linhas) => n + linhas.length, 0) <= LIMITES_COPIA.registros, 'limite')
  for (const nome of TABELAS_COPIA) {
    const chaves = d[nome].map((linha) => 'chave' in linha ? linha.chave : 'ordem' in linha ? linha.ordem
      : nome === 'movimentos' && 'revisao' in linha ? chaveDoEfeito(linha) : 'id' in linha ? linha.id : undefined)
    exigirCopia(!chaves.includes(undefined) && new Set(chaves).size === chaves.length)
  }
  const clientes = new Set(d.clientes.map((c) => c.id)), produtos = new Set(d.produtos.map((p) => p.id))
  const financeiros = [...d.lancamentos, ...d.versoesEstoque.flatMap((v) => v.grupo.lancamentos), ...d.evidenciasCopia.flatMap((e) => [e.tentativa, e.aceita])]
  for (const l of financeiros) {
    exigirCopia(clientes.has(l.clienteId))
    if (l.tipo === 'estorno') exigirCopia(financeiros.some((a) => a.id === l.estornaId && a.tipo !== 'estorno' && a.clienteId === l.clienteId))
    if (l.tipo === 'venda') exigirCopia(l.itens.every((i) => !i.produtoId || produtos.has(i.produtoId)))
  }
  for (const p of d.produtos) exigirCopia(novoProduto(p, d.categorias).ok)
  const movimentos = [...d.movimentos, ...d.versoesEstoque.flatMap((v) => v.grupo.movimentos)]
  const referencias = new Set(movimentos.map(chaveDoEfeito))
  for (const m of movimentos) {
    exigirCopia(produtos.has(m.produtoId))
    exigirCopia(m.conhecidos.every((r) => referencias.has(chaveDoEfeito(r)) ||
      movimentos.some((a) => a.tipo === 'contagem' && a.base.some((e) => chaveDoEfeito(e) === chaveDoEfeito(r)))))
    if (m.tipo === 'anulacao') exigirCopia(movimentos.some((a) => a.produtoId === m.produtoId && chaveDoEfeito(a) === chaveDoEfeito(m.alvo)))
    if (m.tipo === 'entrega' || m.tipo === 'retorno') exigirCopia(financeiros.some((l) => l.tipo === 'venda' && l.itens.some((i) => i.id === m.itemId && i.produtoId === m.produtoId)))
  }
  for (const op of d.operacoes) {
    const v = d.versoesEstoque.find((v) => v.id === op.versaoId)
    const { versaoId: _id, ...manifesto } = op
    exigirCopia(v && conteudoDoEfeito(v.grupo.operacao) === conteudoDoEfeito(manifesto))
  }
  for (const op of d.operacoesCaixa) {
    const v = d.versoesCaixa.find((v) => v.id === op.versaoId)
    const { versaoId: _id, ...manifesto } = op
    exigirCopia(v && conteudoDoEfeito(v.grupo.operacao) === conteudoDoEfeito(manifesto))
    exigirCopia(v.grupo.fatos.every((f) => d.fatosCaixa.some((a) => conteudoDoEfeito(a) === conteudoDoEfeito(f))))
  }
  const fatos = [...d.fatosCaixa, ...d.versoesCaixa.flatMap((v) => v.grupo.fatos)]
  for (const f of fatos) if (f.tipo === 'estorno') exigirCopia(fatos.some((a) => a.id === f.alvo.id && a.revisao === f.alvo.revisao && a.tipo !== 'estorno'))
  for (const v of d.versoesCaixa) if (v.foraDaProjecao) exigirCopia(d.versoesCaixa.some((c) => c.id === v.foraDaProjecao?.causaId))
  const fotos = new Set(d.fotos.map((f) => f.id))
  exigirCopia(d.produtos.every((p) => !p.fotoId || fotos.has(p.fotoId)))
  exigirCopia(d.enviosProdutoFoto.every((e) => produtos.has(e.produtoId) && e.produtoId === e.cadastro.id && (!e.cadastro.fotoId || fotos.has(e.cadastro.fotoId))))
  exigirCopia(d.usosFotos.every((u) => fotos.has(u.fotoId)))
  exigirCopia(d.fotos.every((f) => produtos.has(f.produtoId) && (!f.binario || f.binario.byteLength === f.bytes)))
  const ponteiros = new Set<string>()
  for (const f of d.fila) {
    exigirCopia(!ponteiros.has(`${f.tabela}/${f.registroId}`)); ponteiros.add(`${f.tabela}/${f.registroId}`)
    const tabela = f.tabela === 'identidadeLoja' ? 'identidadesLoja' : f.tabela
    exigirCopia(d[tabela].some((r) => 'id' in r && r.id === f.registroId) ||
      (f.tabela === 'operacoesCaixa' && d.versoesCaixa.some((v) => v.operacaoId === f.registroId && !!v.foraDaProjecao)) ||
      (f.tabela === 'operacoes' && d.versoesEstoque.some((v) => v.operacaoId === f.registroId)))
  }
}
