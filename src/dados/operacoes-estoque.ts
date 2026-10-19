import type { Centavos } from '../dominio/dinheiro.ts'
import type { Dia, FormaDePagamento, Id, Parcela } from '../dominio/ficha.ts'
import { baseConhecida, chaveDoEfeito, corrigirMovimento, novaContagem,
  type AnulacaoEstoque, type MovimentoEstoque, type ReferenciaEfeito, type SaidaEstoque } from '../dominio/estoque.ts'
import type { Produto } from '../dominio/produtos.ts'
import type { ResultadoEstoque } from '../dominio/regras-estoque.ts'
import { prepararTrocaVenda, type DevolucaoItem } from '../dominio/trocas-venda.ts'
import { criarItemVendido, prepararCancelamento, prepararCorrecaoVenda, prepararEntrega, prepararMovimentosEstoque,
  prepararRetorno, prepararVendaEstoque, revisarGrupoPendente, type CorrecaoDeEntrega,
  type IdentidadeOperacao, type ItemVendido, type VendaEstoque } from '../dominio/vendas-estoque.ts'
import { uuidv7 } from './identidade.ts'
import type { ParcelaNova } from './operacoes.ts'
import type { EstadoLocalEstoque, RepositorioEstoque } from './repositorio-estoque.ts'
import type { FotoPreparada } from './tipos-fotos.ts'

/** Dados físicos do fato; somente ids, revisões e causalidade são acrescentados pelo sistema. */
export type EntradaMovimentoLocal = { readonly produtoId: Id; readonly data: Dia } & (
  | { readonly tipo: 'compra'; readonly quantidade: number; readonly custoUnitario?: Centavos }
  | { readonly tipo: 'saida'; readonly quantidade: number; readonly motivo: SaidaEstoque['motivo'] }
  | { readonly tipo: 'contagem'; readonly totalContado: number; readonly motivo: 'estoque-inicial' | 'conferencia' }
)

/** A quantidade entregue foi conferida antes de confirmar; sugestão sozinha nunca vira baixa. */
export type ItemVendaLocal = { readonly id?: Id; readonly descricao: string; readonly produtoId?: Id;
  readonly quantidade: number; readonly precoUnitario?: Centavos; readonly entregue: number }

/** Parcelas novas recebem id local; a correção conserva os ids das parcelas que permaneceram. */
export type EntradaVendaLocal = { readonly clienteId: Id; readonly data: Dia; readonly desconto: Centavos;
  readonly itens: readonly ItemVendaLocal[] } & (
    | { readonly pagamento: 'fiado'; readonly parcelas: readonly (Parcela | ParcelaNova)[] }
    | { readonly pagamento: 'avista'; readonly forma: FormaDePagamento }
  )

/** Fato corrigido, sem ids técnicos: custo só é informado quando o produto anotado estava errado. */
export type CorrecaoEntregaLocal = { readonly alvo: ReferenciaEfeito; readonly produtoId: Id;
  readonly quantidade: number; readonly custoUnitario?: Centavos }

function identidade(estado: EstadoLocalEstoque, produtos: readonly Id[], adicionais: readonly ReferenciaEfeito[] = [],
  id = uuidv7(), revisao = 1): IdentidadeOperacao {
  const dependencias = new Map([...produtos.flatMap((produtoId) => baseConhecida(estado.movimentos, produtoId)), ...adicionais]
    .map((ref) => [chaveDoEfeito(ref), ref]))
  return { id, revisao, dependencias: [...dependencias.values()] }
}

function vendaAtual(estado: EstadoLocalEstoque, id: Id): ResultadoEstoque<VendaEstoque> {
  const venda = estado.lancamentos.find((item) => item.id === id)
  if (!venda || venda.tipo !== 'venda') return { ok: false, motivo: 'alvo-invalido' }
  const itens: ItemVendido[] = []
  for (const item of venda.itens) {
    if (!item.id || item.quantidade === undefined || item.precoUnitario === undefined) return { ok: false, motivo: 'item-invalido' }
    itens.push({ ...item, id: item.id, quantidade: item.quantidade, precoUnitario: item.precoUnitario })
  }
  return { ok: true, valor: { ...venda, itens } }
}

function revisaoVenda(estado: EstadoLocalEstoque, id: Id): ReferenciaEfeito {
  return estado.operacoes.flatMap((item) => item.lancamentos).find((item) => item.id === id) ?? { id, revisao: 1 }
}

function montarVenda(estado: EstadoLocalEstoque, entrada: EntradaVendaLocal, id: Id, manterItens: boolean, manterParcelas = false): ResultadoEstoque<VendaEstoque> {
  const itens: ItemVendido[] = []
  for (const item of entrada.itens) {
    const produto = estado.produtos.find((produto) => produto.id === item.produtoId)
    if (item.produtoId && !produto) return { ok: false, motivo: 'produto-inexistente' }
    const criado = criarItemVendido({ ...item, id: manterItens && item.id ? item.id : uuidv7(), produto })
    if (!criado.ok) return criado
    itens.push(criado.valor)
  }
  const base = { tipo: 'venda', id, clienteId: entrada.clienteId, data: entrada.data, desconto: entrada.desconto, itens } as const
  return { ok: true, valor: entrada.pagamento === 'fiado'
    ? { ...base, pagamento: 'fiado', parcelas: entrada.parcelas.map((item) => ({ ...item, id: manterParcelas && 'id' in item ? item.id : uuidv7() })) }
    : { ...base, pagamento: 'avista', forma: entrada.forma } }
}

function montarMovimento(estado: EstadoLocalEstoque, entrada: EntradaMovimentoLocal, operacao: IdentidadeOperacao,
  id = uuidv7(), revisao = 1): ResultadoEstoque<Exclude<MovimentoEstoque, { readonly tipo: 'entrega' | 'retorno' }>> {
  const base = { ...entrada, id, revisao, operacaoId: operacao.id, conhecidos: baseConhecida(estado.movimentos, entrada.produtoId) }
  if (entrada.tipo === 'contagem') return novaContagem(estado.movimentos, { ...base, ...entrada })
  if (entrada.tipo === 'compra') return { ok: true, valor: { ...base, ...entrada, ordemCadastro: estado.carimbo } }
  return { ok: true, valor: { ...base, ...entrada } }
}

/** Operações F2: ids locais → leitura/validação/gravação conjunta → aviso após commit (D-057). */
export function criarOperacoesEstoque(repositorio: RepositorioEstoque) {
  function registrarMovimento(entrada: EntradaMovimentoLocal) {
    return repositorio.executar((estado) => {
      const operacao = identidade(estado, [entrada.produtoId])
      const movimento = montarMovimento(estado, entrada, operacao)
      return movimento.ok ? prepararMovimentosEstoque(estado.movimentos, operacao, [movimento.valor]) : movimento
    })
  }

  function lancarVenda(entrada: EntradaVendaLocal) {
    return repositorio.executar((estado) => {
      const venda = montarVenda(estado, entrada, uuidv7(), false)
      if (!venda.ok) return venda
      const operacao = identidade(estado, venda.valor.itens.flatMap((item) => item.produtoId ? [item.produtoId] : []))
      return prepararVendaEstoque(estado.lancamentos, estado.movimentos, venda.valor, operacao, estado.produtos,
        venda.valor.itens.map((item, indice) => ({ itemId: item.id, quantidade: entrada.itens[indice]?.entregue ?? 0, movimentoId: uuidv7() })))
    })
  }

  function entregar(entrada: { readonly vendaId: Id; readonly itemId: Id; readonly quantidade: number; readonly data: Dia }) {
    return repositorio.executar((estado) => {
      const venda = vendaAtual(estado, entrada.vendaId)
      if (!venda.ok) return venda
      const item = venda.valor.itens.find((item) => item.id === entrada.itemId)
      const produto = estado.produtos.find((produto) => produto.id === item?.produtoId)
      if (!produto) return { ok: false, motivo: 'produto-inexistente' }
      return prepararEntrega(estado.lancamentos, estado.movimentos, venda.valor, { ...entrada, id: uuidv7(),
        operacao: identidade(estado, [produto.id], [revisaoVenda(estado, entrada.vendaId)]) }, produto)
    })
  }

  function retornoOuCancelamento(vendaId: Id, data: Dia, retornos: readonly { readonly itemId: Id; readonly quantidade: number }[], cancelar: boolean) {
    return repositorio.executar((estado) => {
      const venda = vendaAtual(estado, vendaId)
      if (!venda.ok) return venda
      const operacao = identidade(estado, venda.valor.itens.flatMap((item) => item.produtoId ? [item.produtoId] : []), [revisaoVenda(estado, vendaId)])
      const entrada = { operacao, data, retornos: retornos.map((item) => ({ ...item, movimentoId: uuidv7() })) }
      return cancelar ? prepararCancelamento(estado.lancamentos, estado.movimentos, venda.valor,
        { ...entrada, estornoId: uuidv7(), revisaoVenda: revisaoVenda(estado, vendaId).revisao })
        : prepararRetorno(estado.lancamentos, estado.movimentos, venda.valor, entrada)
    })
  }

  function corrigirRegistroMovimento(alvo: ReferenciaEfeito, entrada: EntradaMovimentoLocal) {
    return repositorio.executar((estado) => {
      const original = estado.movimentos.find((item) => chaveDoEfeito(item) === chaveDoEfeito(alvo))
      if (!original || original.tipo === 'entrega' || original.tipo === 'retorno' || original.tipo === 'anulacao') return { ok: false, motivo: 'alvo-invalido' }
      const pendente = estado.fila.some((item) => item.tabela === 'operacoes' && item.registroId === original.operacaoId)
      const grupo = estado.grupos.find((item) => item.operacao.id === original.operacaoId)
      if (!grupo) return { ok: false, motivo: 'dependencia-ausente' }
      const operacao = identidade(estado, [entrada.produtoId], pendente ? [] : [alvo],
        pendente ? original.operacaoId : uuidv7(), pendente ? grupo.operacao.revisao + 1 : 1)
      const substituto = montarMovimento(estado, entrada, operacao, pendente ? original.id : uuidv7(), pendente ? original.revisao + 1 : 1)
      if (!substituto.ok) return substituto
      const anulacao: AnulacaoEstoque = { tipo: 'anulacao', id: uuidv7(), revisao: 1, operacaoId: operacao.id,
        produtoId: original.produtoId, data: entrada.data, conhecidos: baseConhecida(estado.movimentos, original.produtoId), alvo }
      const corrigido = corrigirMovimento(estado.movimentos, alvo, substituto.valor, { sincronizado: !pendente, anulacao })
      if (!corrigido.ok) return corrigido
      const anteriores = new Set(estado.movimentos.map(chaveDoEfeito))
      const novos = corrigido.valor.filter((item) => !anteriores.has(chaveDoEfeito(item)))
      if (pendente) return revisarGrupoPendente(grupo, operacao, [], novos)
      return prepararMovimentosEstoque(estado.movimentos, operacao,
        novos.filter((item) => item.tipo !== 'entrega' && item.tipo !== 'retorno'), alvo)
    })
  }

  function corrigirVenda(vendaId: Id, entrada: EntradaVendaLocal, correcao: {
    readonly data: Dia; readonly natureza: 'financeira' | 'anotacao'; readonly entregas?: readonly CorrecaoEntregaLocal[]
  }) {
    return repositorio.executar((estado) => {
      const original = vendaAtual(estado, vendaId)
      if (!original.ok) return original
      const ref = revisaoVenda(estado, vendaId)
      const grupo = estado.grupos.find((item) => item.operacao.lancamentos.some((item) => item.id === vendaId))
      // Um fato posterior de troca, ou uma entrega de outro grupo, não é reescrito como parte da venda original.
      const pendente = grupo && grupo.operacao.tipo !== 'troca' &&
        (correcao.entregas ?? []).every((m) => grupo.movimentos.some((anterior) => anterior.id === m.alvo.id)) &&
        estado.fila.some((item) => item.tabela === 'operacoes' && item.registroId === grupo.operacao.id)
      const nova = montarVenda(estado, entrada, pendente ? vendaId : uuidv7(), true, !!pendente)
      if (!nova.ok) return nova
      const operacao = identidade(estado, [], pendente ? [] : [ref], pendente ? grupo.operacao.id : uuidv7(), pendente ? grupo.operacao.revisao + 1 : 1)
      const entregas: CorrecaoDeEntrega[] = []
      for (const mudanca of correcao.entregas ?? []) {
        const anterior = estado.movimentos.find((item) => chaveDoEfeito(item) === chaveDoEfeito(mudanca.alvo))
        if (!anterior || anterior.tipo !== 'entrega') return { ok: false, motivo: 'alvo-invalido' }
        entregas.push({ alvo: mudanca.alvo,
          substituto: { ...anterior, id: pendente ? anterior.id : uuidv7(), operacaoId: operacao.id,
            revisao: pendente ? anterior.revisao + 1 : 1, produtoId: mudanca.produtoId, quantidade: mudanca.quantidade,
            custoUnitario: mudanca.produtoId === anterior.produtoId ? anterior.custoUnitario : mudanca.custoUnitario,
            conhecidos: baseConhecida(estado.movimentos, mudanca.produtoId) },
          anulacao: pendente ? undefined : { tipo: 'anulacao', id: uuidv7(), revisao: 1, operacaoId: operacao.id,
            produtoId: anterior.produtoId, data: correcao.data, alvo: mudanca.alvo, conhecidos: baseConhecida(estado.movimentos, anterior.produtoId) } })
      }
      return prepararCorrecaoVenda(estado.lancamentos, estado.movimentos, original.valor, nova.valor, { ...correcao,
        entregas, operacao, revisaoOriginal: ref.revisao, sincronizado: !pendente, estornoId: uuidv7(), grupoPendente: pendente ? grupo : undefined })
    })
  }

  function trocarDevolver(vendaId: Id, data: Dia, devolucoes: readonly DevolucaoItem[], novos: readonly ItemVendaLocal[] = []) {
    return repositorio.executar((estado) => {
      const original = vendaAtual(estado, vendaId)
      if (!original.ok) return original
      const referencia = revisaoVenda(estado, vendaId)
      const itens: { item: ItemVendido; entregue: number; movimentoId: Id }[] = []
      for (const entrada of novos) {
        const produto = estado.produtos.find((p) => p.id === entrada.produtoId)
        if (entrada.produtoId && !produto) return { ok: false, motivo: 'produto-inexistente' }
        const item = criarItemVendido({ ...entrada, id: uuidv7(), produto })
        if (!item.ok) return item
        itens.push({ item: item.valor, entregue: entrada.entregue, movimentoId: uuidv7() })
      }
      return prepararTrocaVenda(estado.lancamentos, estado.movimentos, original.valor, estado.produtos, {
        operacao: identidade(estado, [...original.valor.itens, ...itens.map((i) => i.item)].flatMap((i) => i.produtoId ? [i.produtoId] : []), [referencia]),
        data, revisaoVenda: referencia.revisao, estornoId: uuidv7(), vendaId: uuidv7(),
        parcelaIds: original.valor.pagamento === 'fiado' ? original.valor.parcelas.map(() => uuidv7()) : [],
        devolucoes: devolucoes.map((d) => ({ ...d, movimentoId: uuidv7() })), novos: itens })
    })
  }

  return { cadastrarCategoria: repositorio.cadastrarCategoria,
    cadastrarProduto: (entrada: Omit<Produto, 'id'>, foto?: FotoPreparada) => repositorio.salvarProduto({ ...entrada, id: uuidv7() }, foto),
    alterarProduto: repositorio.salvarProduto, registrarMovimento, lancarVenda, entregar, corrigirRegistroMovimento, corrigirVenda, trocarDevolver,
    cancelarVenda: (vendaId: Id, data: Dia, retornos: readonly { readonly itemId: Id; readonly quantidade: number }[]) => retornoOuCancelamento(vendaId, data, retornos, true),
    registrarRetorno: (vendaId: Id, data: Dia, retornos: readonly { readonly itemId: Id; readonly quantidade: number }[]) => retornoOuCancelamento(vendaId, data, retornos, false) }
}
