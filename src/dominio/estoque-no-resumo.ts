import { diasCivisEntre } from './calendario-resumo.ts'
import { posicaoEstoque, quantidadeDoMovimento, type ProjecaoEstoque } from './estoque.ts'
import type { Dia, Id } from './ficha.ts'
import type { ParteDaVenda } from './historico-de-vendas.ts'
import type { Produto } from './produtos.ts'

type EstoqueComPromessas = { readonly estoque: ProjecaoEstoque; readonly prometido: number }
type Evento = { data: Dia; fisico: bigint; itemId?: Id; vendido: bigint; entregue: bigint }

function eventosDaDisponibilidade(estoque: ProjecaoEstoque, partes: readonly ParteDaVenda[]): Evento[] {
  const eventos: Evento[] = []
  for (const p of partes) {
    if (!p.item.id) continue
    eventos.push({ data: p.data, fisico: 0n, itemId: p.item.id, vendido: BigInt(p.quantidade), entregue: 0n })
    if (p.fim) eventos.push({ data: p.fim.data, fisico: 0n, itemId: p.item.id, vendido: -BigInt(p.quantidade), entregue: 0n })
  }
  for (const movimento of estoque.movimentosVigentes) {
    const fisico = BigInt(quantidadeDoMovimento(movimento))
    const itemId = movimento.tipo === 'entrega' || movimento.tipo === 'retorno' ? movimento.itemId : undefined
    eventos.push({ data: movimento.data, fisico, itemId, vendido: 0n, entregue: itemId ? -fisico : 0n })
  }
  return eventos.sort((a, b) => a.data.localeCompare(b.data))
}

function positivo(valor: bigint): bigint { return valor > 0n ? valor : 0n }

function inicioDaDisponibilidade(estado: EstoqueComPromessas, partes: readonly ParteDaVenda[], hoje: Dia): Dia | undefined {
  if (estado.estoque.contagensAfetadas.length || partes.some((p) => p.fim && p.fim.data < p.data)) return undefined
  const eventos = eventosDaDisponibilidade(estado.estoque, partes)
  let disponivel = 0n, desde: Dia | undefined
  const itens = new Map<Id, { vendido: bigint; entregue: bigint }>()
  for (let i = 0; i < eventos.length;) {
    const dia = eventos[i]?.data
    if (!dia || dia > hoje) break
    const antes = disponivel
    // Dia é a granularidade da anotação. Somar todos os efeitos do dia evita supor
    // horários entre aparelhos ou uma falta intermediária dentro da mesma venda.
    for (let evento = eventos[i]; evento?.data === dia; evento = eventos[++i]) {
      disponivel += evento.fisico
      if (!evento.itemId) continue
      const item = itens.get(evento.itemId) ?? { vendido: 0n, entregue: 0n }
      const promessaAnterior = positivo(item.vendido - positivo(item.entregue))
      item.vendido += evento.vendido
      item.entregue += evento.entregue
      disponivel += promessaAnterior - positivo(item.vendido - positivo(item.entregue))
      itens.set(evento.itemId, item)
    }
    if (disponivel <= 0n) desde = undefined
    else if (antes <= 0n) desde = dia
  }
  return disponivel === BigInt(estado.estoque.fisico) - BigInt(estado.prometido) ? desde : undefined
}

/** RF-22: reconcilia reposição com RF-15 e deriva idade da disponibilidade sustentada pelos fatos. */
export function projetarEstoqueDoResumo(produtos: readonly Produto[], estados: ReadonlyMap<Id, EstoqueComPromessas>,
  partes: readonly ParteDaVenda[], hoje: Dia, prazo: number) {
  const partesPorProduto = new Map<Id, ParteDaVenda[]>()
  for (const parte of partes) {
    const id = parte.item.produtoId
    if (!id) continue
    const lista = partesPorProduto.get(id) ?? []
    lista.push(parte)
    partesPorProduto.set(id, lista)
  }
  const repor = [], encalhados = [], semData = []
  const ordenados = [...produtos].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR') || a.id.localeCompare(b.id))
  for (const produto of ordenados) {
    const estado = estados.get(produto.id)
    if (!estado) throw new Error('Produto sem projeção de estoque')
    const posicao = posicaoEstoque(estado.estoque.fisico, estado.prometido, produto.estoqueMinimo)
    if (!posicao.ok) throw new Error('Posição de estoque inválida')
    const linha = { produto, ...posicao.valor, contagensAfetadas: estado.estoque.contagensAfetadas.length > 0 }
    if (linha.noMinimo) repor.push(linha)
    if (linha.disponivel === 0) continue
    const desde = inicioDaDisponibilidade(estado, partesPorProduto.get(produto.id) ?? [], hoje)
    if (!desde) { semData.push(linha); continue }
    let referencia = desde
    for (const m of estado.estoque.movimentosVigentes) {
      if (m.tipo === 'entrega' && m.quantidade > 0 && m.data <= hoje && m.data > referencia) referencia = m.data
    }
    const dias = diasCivisEntre(referencia, hoje)
    if (dias > prazo) encalhados.push({ ...linha, desde: referencia, dias })
  }
  return { prazo, repor, encalhados, semData }
}
