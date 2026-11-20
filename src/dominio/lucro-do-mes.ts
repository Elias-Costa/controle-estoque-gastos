import type { Centavos } from './dinheiro.ts'
import type { Dia, Id, Lancamento } from './ficha.ts'
import type { EntregaEstoque, MovimentoEstoque, RetornoEstoque } from './estoque.ts'
import type { FatoCaixa } from './gastos.ts'
import { valorDasUnidades, type ParteDaVenda } from './historico-de-vendas.ts'

type BaixasDoItem = { entregas: EntregaEstoque[]; retornos: RetornoEstoque[] }

function chaveDoItem(itemId: Id, produtoId: Id): string { return JSON.stringify([itemId, produtoId]) }

function porData(a: { data: Dia; id: Id }, b: { data: Dia; id: Id }): number {
  return a.data.localeCompare(b.data) || a.id.localeCompare(b.id)
}

function baixasPorItem(movimentos: readonly MovimentoEstoque[], hoje: Dia): Map<string, BaixasDoItem> {
  const itens = new Map<string, BaixasDoItem>()
  for (const m of movimentos) {
    if ((m.tipo !== 'entrega' && m.tipo !== 'retorno') || m.quantidade === 0 || m.data > hoje) continue
    const chave = chaveDoItem(m.itemId, m.produtoId)
    const baixas = itens.get(chave) ?? { entregas: [], retornos: [] }
    if (m.tipo === 'entrega') baixas.entregas.push(m)
    else baixas.retornos.push(m)
    itens.set(chave, baixas)
  }
  return itens
}

const CUSTOS_DIFERENTES = Symbol('custos diferentes sem identificação das unidades')
type CustoPossivel = Centavos | undefined | typeof CUSTOS_DIFERENTES

function custosDosRetornos(entregas: readonly EntregaEstoque[], retornos: readonly RetornoEstoque[]) {
  let disponiveis = new Map<CustoPossivel, number>()
  let proxima = 0, quantidade = 0
  // Só se conhece o custo de um subconjunto se todos os candidatos tiverem o mesmo custo.
  // Se o subconjunto é o lote inteiro, somar as baixas é suficiente mesmo com custos distintos.
  return [...retornos].sort(porData).map((retorno) => {
    for (let entrega = entregas[proxima]; entrega && entrega.data <= retorno.data; entrega = entregas[++proxima]) {
      disponiveis.set(entrega.custoUnitario, (disponiveis.get(entrega.custoUnitario) ?? 0) + entrega.quantidade)
      quantidade += entrega.quantidade
    }
    if (retorno.quantidade > quantidade) return { retorno, custo: 0n, apuraveis: 0, incompleto: true }
    const faltamCustos = disponiveis.has(undefined)
    let custo = 0n, apuraveis = 0, incompleto = false
    if (retorno.quantidade === quantidade) {
      for (const [unitario, qtd] of disponiveis) {
        if (typeof unitario === 'bigint') custo += unitario * BigInt(qtd)
        else incompleto = true
        if (unitario !== undefined) apuraveis += qtd
      }
      disponiveis = new Map()
    } else {
      const unico = disponiveis.size === 1
      const unitario = unico ? disponiveis.keys().next().value : faltamCustos ? undefined : CUSTOS_DIFERENTES
      if (typeof unitario === 'bigint') custo = unitario * BigInt(retorno.quantidade)
      else incompleto = true
      if (unitario !== undefined) apuraveis = retorno.quantidade
      disponiveis = new Map([[unitario, quantidade - retorno.quantidade]])
    }
    quantidade -= retorno.quantidade
    return { retorno, custo, apuraveis, incompleto }
  })
}

/** RF-20/RN-11/15: valores apuráveis e limites encontrados nas anotações do período. */
export function projetarLucro(partes: readonly ParteDaVenda[], movimentos: readonly MovimentoEstoque[],
  fatos: readonly FatoCaixa[], lancamentos: readonly Lancamento[], hoje: Dia, mes: string) {
  const noMes = (dia: Dia) => dia.startsWith(`${mes}-`) && dia <= hoje
  let vendasApuraveis = 0n, devolucoesApuraveis = 0n, custoDasEntregas = 0n, custoDosRetornos = 0n
  let avulsos = 0n, aEntregar = 0n, canceladosSemEntrega = 0n, semCusto = 0n, despesas = 0n, descontosQuitacao = 0n
  const itens = new Map<string, { id: Id; partes: ParteDaVenda[] }>()
  const entregasAConferir = new Set<Id>(), itensSemCusto = new Set<Id>(), retornosSemCusto: Id[] = []
  const baixas = baixasPorItem(movimentos, hoje)
  for (const parte of partes) {
    if (!parte.item.produtoId || !parte.item.id) {
      if (noMes(parte.data)) avulsos += parte.valor
      if (parte.fim && noMes(parte.fim.data)) avulsos -= parte.fim.valor
      continue
    }
    const chave = chaveDoItem(parte.item.id, parte.item.produtoId)
    const item = itens.get(chave) ?? { id: parte.item.id, partes: [] }
    item.partes.push(parte)
    itens.set(chave, item)
  }
  for (const [chave, { id, partes: lista }] of itens) {
    const { entregas, retornos } = baixas.get(chave) ?? { entregas: [], retornos: [] }
    entregas.sort(porData)
    const vendidas = lista.reduce((total, parte) => total + parte.quantidade, 0)
    const entregues = entregas.reduce((total, entrega) => total + entrega.quantidade, 0)
    const trocadas = lista.filter((parte) => parte.fim?.tipo === 'troca')
      .sort((a, b) => (a.fim?.data ?? '').localeCompare(b.fim?.data ?? ''))
    const partesEmOrdem = [...trocadas, ...lista.filter((parte) => parte.fim?.tipo !== 'troca')]
    // D-090: manter as baixas no estoque e deixar a margem do item em conferência.
    if (entregues > vendidas) {
      if (lista.some((p) => noMes(p.data) || (p.fim && noMes(p.fim.data))) || retornos.some((m) => noMes(m.data))) entregasAConferir.add(id)
      continue
    }
    const custosRetornados = custosDosRetornos(entregas, retornos)
    const retornosPorOperacao = new Map(custosRetornados.map((r) => [r.retorno.operacaoId, r]))
    let lote = 0, consumidasNoLote = 0
    for (const parte of partesEmOrdem) {
      let entreguesNaParte = 0, apuraveis = 0
      let entrega = entregas[lote]
      while (entrega && entreguesNaParte < parte.quantidade) {
        const restanteDaParte = parte.quantidade - entreguesNaParte
        const restanteDoLote = entrega.quantidade - consumidasNoLote
        const quantidade = restanteDaParte < restanteDoLote ? restanteDaParte : restanteDoLote
        const inicio = valorDasUnidades(parte.valor, parte.quantidade, entreguesNaParte)
        entreguesNaParte += quantidade
        const valor = valorDasUnidades(parte.valor, parte.quantidade, entreguesNaParte) - inicio
        if (entrega.custoUnitario === undefined) {
          if (noMes(parte.data)) {
            semCusto += valor
            itensSemCusto.add(id)
          }
        } else {
          apuraveis += quantidade
          if (noMes(parte.data)) {
            vendasApuraveis += valor
            custoDasEntregas += entrega.custoUnitario * BigInt(quantidade)
          }
        }
        consumidasNoLote += quantidade
        if (consumidasNoLote === entrega.quantidade) {
          entrega = entregas[++lote]
          consumidasNoLote = 0
        }
      }
      if (noMes(parte.data)) {
        const pendente = parte.valor - valorDasUnidades(parte.valor, parte.quantidade, entreguesNaParte)
        if (parte.fim?.tipo === 'cancelamento' && parte.fim.data <= hoje) canceladosSemEntrega += pendente
        else aEntregar += pendente
      }
      if (parte.fim && noMes(parte.fim.data)) {
        const retorno = retornosPorOperacao.get(parte.fim.operacaoId)
        const foiTroca = parte.fim.tipo === 'troca'
        const devolvido = valorDasUnidades(parte.fim.valor, parte.quantidade, foiTroca ? retorno?.apuraveis ?? 0 : apuraveis)
        const entregue = foiTroca ? parte.fim.valor : valorDasUnidades(parte.fim.valor, parte.quantidade, entreguesNaParte)
        devolucoesApuraveis += devolvido
        semCusto -= entregue - devolvido
        canceladosSemEntrega -= parte.fim.valor - entregue
        if (entregue !== devolvido || (foiTroca ? retorno && retorno.apuraveis < parte.quantidade : entreguesNaParte > apuraveis)) itensSemCusto.add(id)
      }
    }
    for (const { retorno, custo, incompleto } of custosRetornados) {
      if (!noMes(retorno.data)) continue
      if (incompleto) retornosSemCusto.push(retorno.id)
      custoDosRetornos += custo
    }
  }
  // Estornos reexpressam o período do fato de origem (D-065/066), inclusive fora do mês consultado.
  const despesasEstornadas = new Set(fatos.flatMap((f) => f.tipo === 'estorno' ? [f.alvo.id] : []))
  for (const fato of fatos) if (fato.tipo === 'despesa' && fato.classificacao === 'negocio' && !fato.mercadoria &&
    !despesasEstornadas.has(fato.id) && noMes(fato.data)) despesas += fato.valor
  const lancamentosEstornados = new Set(lancamentos.flatMap((l) => l.tipo === 'estorno' ? [l.estornaId] : []))
  for (const l of lancamentos) if (l.tipo === 'desconto-quitacao' && !lancamentosEstornados.has(l.id) && noMes(l.data)) descontosQuitacao += l.valor
  return { mes, vendasApuraveis, devolucoesApuraveis, custoDasEntregas, custoDosRetornos, avulsos, aEntregar, canceladosSemEntrega, semCusto,
    entregasAConferir: [...entregasAConferir], itensSemCusto: [...itensSemCusto], retornosSemCusto, despesas, descontosQuitacao,
    resultado: vendasApuraveis - devolucoesApuraveis - custoDasEntregas + custoDosRetornos - despesas - descontosQuitacao }
}
