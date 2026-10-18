import { multiplicar, type Centavos } from './dinheiro.ts'
import { parcelas, totalDaVenda, validar, type Dia, type Ficha, type Id, type ItemVenda, type Lancamento, type VendaAVista, type VendaFiado } from './ficha.ts'
import { corrigir, corrigirCliente, estornar } from './lancamentos.ts'
import { custoDoProduto, type Produto } from './produtos.ts'
import { baseConhecida, chaveDoEfeito, corrigirMovimento, projetarEstoque, referenciaDoEfeito, registrarMovimentos,
  type AnulacaoEstoque, type EntregaEstoque, type MovimentoEstoque, type ReferenciaEfeito, type RetornoEstoque } from './estoque.ts'
import { conteudoDoEfeito, quantidadeValida, type ResultadoEstoque } from './regras-estoque.ts'

/** Identidade lógica sobrevive às ocorrências históricas; o preço legado é quantidade × unitário. */
export type ItemVendido = ItemVenda & { readonly id: Id; readonly quantidade: number; readonly precoUnitario: Centavos }
/** Venda com itens F2, inclusive avulsos; não converte itens históricos de F1. */
export type VendaEstoque = (Omit<VendaFiado, 'itens'> | Omit<VendaAVista, 'itens'>) & { readonly itens: readonly ItemVendido[] }
/** Manifesto do conjunto a gravar em E-19; valores permanecem nos registros próprios (Q37). */
export type OperacaoEstoque = ReferenciaEfeito & {
  readonly formato: 1
  readonly tipo: 'venda' | 'entrega' | 'cancelamento' | 'retorno' | 'correcao' | 'movimento'
  readonly lancamentos: readonly ReferenciaEfeito[]
  readonly movimentos: readonly ReferenciaEfeito[]
  readonly dependencias: readonly ReferenciaEfeito[]
  readonly alvo?: ReferenciaEfeito
}
/** Resultado indivisível de domínio; atomicidade durável será provada em E-19–E-21. */
export type GrupoEstoque = {
  readonly operacao: OperacaoEstoque
  readonly lancamentos: readonly Lancamento[]
  readonly movimentos: readonly MovimentoEstoque[]
}
/** Identidades/revisão geradas e lidas fora do domínio, antes de qualquer rede. */
export type IdentidadeOperacao = { readonly id: Id; readonly revisao: number; readonly dependencias: readonly ReferenciaEfeito[] }

function grupo(identidade: IdentidadeOperacao, tipo: OperacaoEstoque['tipo'], lancamentos: readonly Lancamento[], movimentos: readonly MovimentoEstoque[], alvo?: ReferenciaEfeito): ResultadoEstoque<GrupoEstoque> {
  if (!identidade.id || !quantidadeValida(identidade.revisao, 1)) return { ok: false, motivo: 'revisao-invalida' }
  if ([...identidade.dependencias, ...(alvo ? [alvo] : [])].some((ref) => !ref.id || !quantidadeValida(ref.revisao, 1))) return { ok: false, motivo: 'revisao-invalida' }
  const ids = [identidade.id, ...lancamentos.flatMap((item) => [item.id, ...('parcelas' in item ? item.parcelas.map((parcela) => parcela.id) : [])]), ...movimentos.map((item) => item.id)]
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length || movimentos.some((movimento) => movimento.operacaoId !== identidade.id)) return { ok: false, motivo: 'id-repetido' }
  return { ok: true, valor: { operacao: { ...identidade, formato: 1, tipo, alvo,
    lancamentos: lancamentos.map((item) => ({ id: item.id, revisao: identidade.revisao })), movimentos: movimentos.map(referenciaDoEfeito) }, lancamentos, movimentos } }
}

/** Edição pendente mantém o conjunto original, inclusive efeitos que não precisaram mudar (Q37). */
export function revisarGrupoPendente(anterior: GrupoEstoque, identidade: IdentidadeOperacao,
  lancamentos: readonly Lancamento[], movimentos: readonly MovimentoEstoque[]): ResultadoEstoque<GrupoEstoque> {
  if (identidade.id !== anterior.operacao.id || identidade.revisao !== anterior.operacao.revisao + 1) return { ok: false, motivo: 'revisao-invalida' }
  const financeiros = new Map(anterior.lancamentos.map((item) => [item.id, item]))
  const fisicos = new Map(anterior.movimentos.map((item) => [item.id, item]))
  for (const item of lancamentos) financeiros.set(item.id, item)
  for (const item of movimentos) {
    const atual = fisicos.get(item.id)
    if (!atual || item.revisao !== atual.revisao + 1) return { ok: false, motivo: 'revisao-invalida' }
    fisicos.set(item.id, item)
  }
  const dependencias = new Map([...anterior.operacao.dependencias, ...identidade.dependencias].map((ref) => [chaveDoEfeito(ref), ref]))
  return grupo({ ...identidade, dependencias: [...dependencias.values()] }, anterior.operacao.tipo,
    [...financeiros.values()], [...fisicos.values()], anterior.operacao.alvo)
}

/** Compras, saídas e contagens usam o mesmo manifesto, sem criar lançamento financeiro. */
export function prepararMovimentosEstoque(historico: readonly MovimentoEstoque[], identidade: IdentidadeOperacao,
  movimentos: readonly Exclude<MovimentoEstoque, EntregaEstoque | RetornoEstoque>[], alvo?: ReferenciaEfeito): ResultadoEstoque<GrupoEstoque> {
  if (!movimentos.length) return { ok: false, motivo: 'item-invalido' }
  const resultado = registrarMovimentos(historico, movimentos)
  return resultado.ok ? grupo(identidade, alvo ? 'correcao' : 'movimento', [], movimentos, alvo) : resultado
}

function fichaDaCliente(lancamentos: readonly Lancamento[], clienteId: Id): Ficha { return lancamentos.filter((item) => item.clienteId === clienteId) }
function foiEstornada(lancamentos: readonly Lancamento[], vendaId: Id): boolean { return lancamentos.some((item) => item.tipo === 'estorno' && item.estornaId === vendaId) }
function validarFichas(lancamentos: readonly Lancamento[]): ResultadoEstoque<readonly Lancamento[]> {
  for (const cliente of new Set(lancamentos.map((item) => item.clienteId))) {
    const resultado = validar(fichaDaCliente(lancamentos, cliente))
    if (!resultado.ok) return resultado
  }
  return { ok: true, valor: lancamentos }
}
function conferirVenda(venda: VendaEstoque): ResultadoEstoque<VendaEstoque> {
  const resultado = validar([venda])
  if (!resultado.ok) return resultado
  if (venda.itens.some((item) => !item.id || item.quantidade === undefined || item.precoUnitario === undefined)) return { ok: false, motivo: 'item-invalido' }
  if (totalDaVenda(venda) <= 0n) return { ok: false, motivo: 'venda-gratuita' }
  return { ok: true, valor: venda }
}

/** Preço sugerido do cadastro é editável; vazio exige valor, zero explícito continua zero. */
export function criarItemVendido(entrada: { readonly id: Id; readonly descricao: string; readonly quantidade: number; readonly precoUnitario?: Centavos; readonly produto?: Produto }): ResultadoEstoque<ItemVendido> {
  if (!entrada.id || !quantidadeValida(entrada.quantidade, 1)) return { ok: false, motivo: 'quantidade-invalida' }
  const precoUnitario = entrada.precoUnitario ?? entrada.produto?.precoVenda
  if (precoUnitario === undefined) return { ok: false, motivo: 'valor-invalido' }
  if (typeof precoUnitario !== 'bigint' || precoUnitario < 0n) return { ok: false, motivo: 'preco-negativo' }
  return { ok: true, valor: { id: entrada.id, descricao: entrada.descricao, produtoId: entrada.produto?.id,
    quantidade: entrada.quantidade, precoUnitario, preco: multiplicar(precoUnitario, entrada.quantidade) } }
}

/** Sugestão apenas; novas vendas passam disponível, entregas pendentes passam físico (D-017). */
export function sugerirEntrega(quantidade: number, disponivelOuFisico: number): number {
  if (disponivelOuFisico <= 0) return 0
  return quantidade < disponivelOuFisico ? quantidade : disponivelOuFisico
}

/** Leitura do compromisso: retorno após cancelamento não restaura promessa nem cobrança. */
export function situacaoDoItem(item: ItemVendido, historico: readonly MovimentoEstoque[], cancelado: boolean): ResultadoEstoque<{
  readonly entregue: number; readonly retornado: number; readonly pendente: number; readonly excesso: number; readonly podeRetornar: number
}> {
  if (!item.produtoId) return { ok: true, valor: { entregue: 0, retornado: 0, pendente: 0, excesso: 0, podeRetornar: 0 } }
  const projecao = projetarEstoque(historico, item.produtoId)
  if (!projecao.ok) return projecao
  let entregue = 0
  let retornado = 0
  for (const movimento of projecao.valor.movimentosVigentes) {
    if (movimento.tipo === 'entrega' && movimento.itemId === item.id) entregue += movimento.quantidade
    if (movimento.tipo === 'retorno' && movimento.itemId === item.id) retornado += movimento.quantidade
  }
  if (!quantidadeValida(entregue) || !quantidadeValida(retornado)) return { ok: false, motivo: 'quantidade-invalida' }
  if (retornado > entregue) return { ok: false, motivo: 'excede-retorno' }
  const restante = item.quantidade - entregue
  return { ok: true, valor: { entregue, retornado, pendente: cancelado || restante < 0 ? 0 : restante,
    excesso: restante < 0 ? -restante : 0, podeRetornar: entregue - retornado } }
}

/** Prometido só das ocorrências financeiras vigentes; a correção não conta o mesmo item duas vezes. */
export function prometidoDoProduto(lancamentos: readonly Lancamento[], historico: readonly MovimentoEstoque[], produtoId: Id): ResultadoEstoque<number> {
  let prometido = 0
  const vistos = new Set<Id>()
  for (const venda of lancamentos) {
    if (venda.tipo !== 'venda' || foiEstornada(lancamentos, venda.id)) continue
    for (const item of venda.itens) {
      if (item.produtoId !== produtoId || item.id === undefined || item.quantidade === undefined || item.precoUnitario === undefined) continue
      if (vistos.has(item.id)) return { ok: false, motivo: 'item-invalido' }
      vistos.add(item.id)
      const situacao = situacaoDoItem({ ...item, id: item.id, quantidade: item.quantidade, precoUnitario: item.precoUnitario }, historico, false)
      if (!situacao.ok) return situacao
      prometido += situacao.valor.pendente
    }
  }
  return quantidadeValida(prometido) ? { ok: true, valor: prometido } : { ok: false, motivo: 'quantidade-invalida' }
}

/** Venda e entregas imediatas formam um grupo; avulso não produz movimento. */
export function prepararVendaEstoque(lancamentos: readonly Lancamento[], historico: readonly MovimentoEstoque[], venda: VendaEstoque,
  identidade: IdentidadeOperacao, produtos: readonly Produto[], entregas: readonly { readonly itemId: Id; readonly quantidade: number; readonly movimentoId: Id }[]): ResultadoEstoque<GrupoEstoque> {
  const conferida = conferirVenda(venda)
  if (!conferida.ok) return conferida
  const fichas = validarFichas([...lancamentos, venda])
  if (!fichas.ok) return fichas
  if (new Set(entregas.map((item) => item.itemId)).size !== entregas.length || entregas.some((entrega) => !venda.itens.some((item) => item.id === entrega.itemId))) return { ok: false, motivo: 'item-invalido' }
  if (lancamentos.some((atual) => atual.tipo === 'venda' && atual.itens.some((item) => item.id && venda.itens.some((novo) => novo.id === item.id)))) return { ok: false, motivo: 'item-invalido' }
  const movimentos: MovimentoEstoque[] = []
  for (const item of venda.itens) {
    const entrega = entregas.find((entrada) => entrada.itemId === item.id)
    if (!item.produtoId) {
      if (entrega && entrega.quantidade !== 0) return { ok: false, motivo: 'item-invalido' }
      continue
    }
    const produto = produtos.find((produto) => produto.id === item.produtoId)
    if (!produto) return { ok: false, motivo: 'produto-inexistente' }
    const quantidade = entrega?.quantidade ?? 0
    if (!quantidadeValida(quantidade) || quantidade > item.quantidade) return { ok: false, motivo: 'excede-pendencia' }
    if (!entrega || quantidade === 0) continue
    const projecao = projetarEstoque(historico, produto.id)
    if (!projecao.ok) return projecao
    movimentos.push({ tipo: 'entrega', id: entrega.movimentoId, operacaoId: identidade.id, revisao: identidade.revisao,
      produtoId: produto.id, itemId: item.id, data: venda.data, quantidade,
      conhecidos: baseConhecida(historico, produto.id), custoUnitario: custoDoProduto(produto, projecao.valor.comprasVigentes) })
  }
  const conferidos = registrarMovimentos(historico, movimentos)
  return conferidos.ok ? grupo(identidade, 'venda', [venda], movimentos) : conferidos
}

/** Entrega posterior aceita divergência física, mas não excede a pendência conhecida (Q31). */
export function prepararEntrega(lancamentos: readonly Lancamento[], historico: readonly MovimentoEstoque[], venda: VendaEstoque,
  entrada: { readonly operacao: IdentidadeOperacao; readonly id: Id; readonly data: Dia; readonly itemId: Id; readonly quantidade: number }, produto: Produto): ResultadoEstoque<GrupoEstoque> {
  if (foiEstornada(lancamentos, venda.id) || !lancamentos.some((item) => item.id === venda.id && conteudoDoEfeito(item) === conteudoDoEfeito(venda))) return { ok: false, motivo: 'alvo-invalido' }
  const item = venda.itens.find((item) => item.id === entrada.itemId && item.produtoId === produto.id)
  if (!item) return { ok: false, motivo: 'item-invalido' }
  const situacao = situacaoDoItem(item, historico, false)
  if (!situacao.ok) return situacao
  if (!quantidadeValida(entrada.quantidade, 1) || entrada.quantidade > situacao.valor.pendente) return { ok: false, motivo: 'excede-pendencia' }
  const projecao = projetarEstoque(historico, produto.id)
  if (!projecao.ok) return projecao
  const movimento: EntregaEstoque = { tipo: 'entrega', id: entrada.id, operacaoId: entrada.operacao.id, revisao: entrada.operacao.revisao,
    produtoId: produto.id, itemId: item.id, data: entrada.data, quantidade: entrada.quantidade,
    conhecidos: baseConhecida(historico, produto.id), custoUnitario: custoDoProduto(produto, projecao.valor.comprasVigentes) }
  const resultado = registrarMovimentos(historico, [movimento])
  return resultado.ok ? grupo(entrada.operacao, 'entrega', [], [movimento]) : resultado
}

/** Informação humana de retorno real; zero é explícito e não cria movimento. */
export type RetornoInformado = { readonly itemId: Id; readonly quantidade: number; readonly movimentoId: Id }
function prepararRetornos(historico: readonly MovimentoEstoque[], venda: VendaEstoque, identidade: IdentidadeOperacao, data: Dia, retornos: readonly RetornoInformado[]): ResultadoEstoque<readonly RetornoEstoque[]> {
  if (new Set(retornos.map((item) => item.itemId)).size !== retornos.length) return { ok: false, motivo: 'item-invalido' }
  const movimentos: RetornoEstoque[] = []
  for (const retorno of retornos) {
    const item = venda.itens.find((item) => item.id === retorno.itemId && item.produtoId !== undefined)
    if (!item || !item.produtoId) return { ok: false, motivo: 'item-invalido' }
    const situacao = situacaoDoItem(item, historico, true)
    if (!situacao.ok) return situacao
    if (!quantidadeValida(retorno.quantidade) || retorno.quantidade > situacao.valor.podeRetornar) return { ok: false, motivo: 'excede-retorno' }
    if (retorno.quantidade > 0) movimentos.push({ tipo: 'retorno', id: retorno.movimentoId, operacaoId: identidade.id, revisao: identidade.revisao,
      produtoId: item.produtoId, itemId: item.id, data, quantidade: retorno.quantidade, conhecidos: baseConhecida(historico, item.produtoId) })
  }
  const resultado = registrarMovimentos(historico, movimentos)
  return resultado.ok ? { ok: true, valor: movimentos } : resultado
}

/** Estorno financeiro com retorno declarado; preserva as guardas de saldo de F1 (RN-07). */
export function prepararCancelamento(lancamentos: readonly Lancamento[], historico: readonly MovimentoEstoque[], venda: VendaEstoque,
  entrada: { readonly operacao: IdentidadeOperacao; readonly estornoId: Id; readonly data: Dia; readonly retornos: readonly RetornoInformado[]; readonly revisaoVenda: number }): ResultadoEstoque<GrupoEstoque> {
  if (!lancamentos.some((item) => item.id === venda.id && conteudoDoEfeito(item) === conteudoDoEfeito(venda))) return { ok: false, motivo: 'alvo-invalido' }
  const financeiro = estornar(fichaDaCliente(lancamentos, venda.clienteId), { id: entrada.estornoId, clienteId: venda.clienteId, data: entrada.data, estornaId: venda.id })
  if (!financeiro.ok) return financeiro
  // Q20: para toda entrega existente, a quantidade que voltou precisa estar informada, inclusive zero.
  for (const item of venda.itens) {
    const situacao = situacaoDoItem(item, historico, true)
    if (!situacao.ok) return situacao
    if (situacao.valor.podeRetornar > 0 && !entrada.retornos.some((retorno) => retorno.itemId === item.id)) return { ok: false, motivo: 'confirmacao-necessaria' }
  }
  const retornos = prepararRetornos(historico, venda, entrada.operacao, entrada.data, entrada.retornos)
  return retornos.ok ? grupo(entrada.operacao, 'cancelamento', [financeiro.valor], retornos.valor, { id: venda.id, revisao: entrada.revisaoVenda }) : retornos
}

/** Retorno após cancelamento não repete estorno, e não vale para item ainda numa substituição vigente. */
export function prepararRetorno(lancamentos: readonly Lancamento[], historico: readonly MovimentoEstoque[], venda: VendaEstoque,
  entrada: { readonly operacao: IdentidadeOperacao; readonly data: Dia; readonly retornos: readonly RetornoInformado[] }): ResultadoEstoque<GrupoEstoque> {
  if (!lancamentos.some((item) => item.id === venda.id && conteudoDoEfeito(item) === conteudoDoEfeito(venda)) ||
    !foiEstornada(lancamentos, venda.id) || lancamentos.some((outra) => outra.tipo === 'venda' && !foiEstornada(lancamentos, outra.id) &&
    outra.itens.some((item) => item.id !== undefined && venda.itens.some((original) => original.id === item.id)))) return { ok: false, motivo: 'alvo-invalido' }
  const retornos = prepararRetornos(historico, venda, entrada.operacao, entrada.data, entrada.retornos)
  return retornos.ok ? grupo(entrada.operacao, 'retorno', [], retornos.valor) : retornos
}

/** Correção explícita de uma anotação física; não equivale a devolver mercadoria. */
export type CorrecaoDeEntrega = { readonly alvo: ReferenciaEfeito; readonly substituto: EntregaEstoque; readonly anulacao?: AnulacaoEstoque }

/** Corrige financeiro preservando item lógico; alterações de anotação física exigem efeitos explícitos. */
export function prepararCorrecaoVenda(lancamentos: readonly Lancamento[], historico: readonly MovimentoEstoque[], original: VendaEstoque, nova: VendaEstoque,
  entrada: { readonly operacao: IdentidadeOperacao; readonly revisaoOriginal: number; readonly sincronizado: boolean; readonly estornoId?: Id; readonly data: Dia;
    readonly natureza: 'financeira' | 'anotacao'; readonly entregas?: readonly CorrecaoDeEntrega[]; readonly grupoPendente?: GrupoEstoque }): ResultadoEstoque<GrupoEstoque> {
  if (!lancamentos.some((item) => item.id === original.id && conteudoDoEfeito(item) === conteudoDoEfeito(original)) || foiEstornada(lancamentos, original.id)) return { ok: false, motivo: 'alvo-invalido' }
  const conferida = conferirVenda(nova)
  if (!conferida.ok) return conferida
  if (original.itens.length !== nova.itens.length || original.itens.some((item) => !nova.itens.some((novo) => novo.id === item.id))) return { ok: false, motivo: 'item-invalido' }
  const mudancaFisica = original.itens.some((item) => nova.itens.some((novo) => novo.id === item.id && (novo.produtoId !== item.produtoId || novo.quantidade !== item.quantidade)))
  if (entrada.natureza === 'financeira' && (mudancaFisica || (entrada.entregas?.length ?? 0) > 0)) return { ok: false, motivo: 'correcao-invalida' }
  const origem = fichaDaCliente(lancamentos, original.clienteId)
  const destino = fichaDaCliente(lancamentos, nova.clienteId)
  const pagos = parcelas(origem).filter((item) => item.debito.id === original.id && item.pago > 0n)
  if (original.clienteId !== nova.clienteId && pagos.length) return { ok: false, motivo: 'parcela-paga-alterada' }
  const financeiros: Lancamento[] = []
  if (!entrada.sincronizado) {
    if (!entrada.grupoPendente || !entrada.grupoPendente.operacao.lancamentos.some((ref) => ref.id === original.id && ref.revisao === entrada.revisaoOriginal) ||
      !entrada.grupoPendente.lancamentos.some((item) => conteudoDoEfeito(item) === conteudoDoEfeito(original))) return { ok: false, motivo: 'dependencia-ausente' }
    if (nova.id !== original.id) return { ok: false, motivo: 'correcao-invalida' }
    const mesmaCliente = { ...nova, clienteId: original.clienteId }
    const corrigida = corrigir(origem, mesmaCliente, { sincronizado: false })
    if (!corrigida.ok) return corrigida
    if (nova.clienteId !== original.clienteId) {
      const movida = corrigirCliente(origem.map((item) => item.id === original.id ? mesmaCliente : item), destino, original.id, nova.clienteId, { sincronizado: false })
      if (!movida.ok) return movida
    }
    financeiros.push(nova)
  } else {
    if (nova.id === original.id || !entrada.estornoId) return { ok: false, motivo: 'correcao-invalida' }
    // Parcela totalmente paga mantém valor e data; os ids da nova ocorrência são próprios.
    const novasParcelas = nova.pagamento === 'fiado' ? [...nova.parcelas] : []
    for (const paga of pagos.filter((item) => item.restante === 0n)) {
      const indice = novasParcelas.findIndex((item) => item.valor === paga.parcela.valor && item.vencimento === paga.parcela.vencimento)
      if (indice < 0) return { ok: false, motivo: 'parcela-paga-alterada' }
      novasParcelas.splice(indice, 1)
    }
    financeiros.push(nova, { tipo: 'estorno', id: entrada.estornoId, clienteId: original.clienteId, data: entrada.data, estornaId: original.id })
  }
  const resultadoFinanceiro = validarFichas([...lancamentos.filter((item) => entrada.sincronizado || item.id !== original.id), ...financeiros])
  if (!resultadoFinanceiro.ok) return resultadoFinanceiro
  let todos = historico
  const movimentos: MovimentoEstoque[] = []
  for (const correcao of entrada.entregas ?? []) {
    const entrega = historico.find((item) => chaveDoEfeito(item) === chaveDoEfeito(correcao.alvo))
    const itemNovo = nova.itens.find((item) => item.id === correcao.substituto.itemId)
    if (!entrega || entrega.tipo !== 'entrega' || entrega.itemId !== correcao.substituto.itemId || !itemNovo || itemNovo.produtoId !== correcao.substituto.produtoId) return { ok: false, motivo: 'item-invalido' }
    const resultado = corrigirMovimento(todos, correcao.alvo, correcao.substituto, { sincronizado: entrada.sincronizado, anulacao: correcao.anulacao })
    if (!resultado.ok) return resultado
    const anteriores = new Set(todos.map(chaveDoEfeito))
    movimentos.push(...resultado.valor.filter((item) => !anteriores.has(chaveDoEfeito(item))))
    todos = resultado.valor
  }
  for (const item of original.itens) {
    const novo = nova.itens.find((novo) => novo.id === item.id)
    if (!novo || item.produtoId === novo.produtoId) continue
    const antiga = situacaoDoItem(item, todos, false)
    if (!antiga.ok) return antiga
    if (antiga.valor.entregue > 0) return { ok: false, motivo: 'correcao-invalida' }
  }
  if (!entrada.sincronizado && entrada.grupoPendente) return revisarGrupoPendente(entrada.grupoPendente, entrada.operacao, financeiros, movimentos)
  return grupo(entrada.operacao, 'correcao', financeiros, movimentos, { id: original.id, revisao: entrada.revisaoOriginal })
}
