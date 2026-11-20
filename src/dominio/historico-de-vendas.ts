import type { Centavos } from './dinheiro.ts'
import type { Dia, Id, ItemVenda, Lancamento, Venda } from './ficha.ts'
import type { OperacaoEstoque } from './vendas-estoque.ts'

/** Uma parte da venda com valor de origem e eventual cancelamento ou devolução identificada. */
export type ParteDaVenda = {
  readonly item: ItemVenda
  readonly quantidade: number
  readonly data: Dia
  readonly valor: Centavos
  readonly fim?: { readonly tipo: 'troca' | 'cancelamento'; readonly operacaoId: Id; readonly data: Dia; readonly valor: Centavos }
}

type ParteAtiva = ParteDaVenda & { readonly liquidoVigente: Centavos }

/** Rateio proporcional em centavos com maiores restos e desempate pela ordem (D-087). */
export function ratearValor(total: Centavos, pesos: readonly Centavos[]): Centavos[] {
  const bruto = pesos.reduce((soma, peso) => soma + peso, 0n)
  if (bruto === 0n) return pesos.map(() => 0n)
  const cotas = pesos.map((peso, indice) => {
    const produto = total * peso
    return { indice, valor: produto / bruto, resto: produto % bruto }
  })
  const valores = cotas.map((cota) => cota.valor)
  let sobra = total - valores.reduce((soma, valor) => soma + valor, 0n)
  cotas.sort((a, b) => a.resto === b.resto ? a.indice - b.indice : a.resto > b.resto ? -1 : 1)
  for (const cota of cotas) {
    if (sobra === 0n) break
    valores[cota.indice] = cota.valor + 1n
    sobra--
  }
  return valores
}

/** Valor das primeiras unidades na divisão inteira, com o resto distribuído em ordem. */
export function valorDasUnidades(valor: Centavos, quantidade: number, unidades: number): Centavos {
  const qtd = BigInt(quantidade)
  const usadas = BigInt(unidades)
  const resto = valor % qtd
  const absoluto = resto < 0n ? -resto : resto
  const centavosAParte = usadas < absoluto ? usadas : absoluto
  return (valor / qtd) * usadas + (resto < 0n ? -centavosAParte : centavosAParte)
}

function partesDaVenda(venda: Venda, data: Dia, recebeDesconto: (item: ItemVenda) => boolean): ParteAtiva[] {
  const descontos = ratearValor(venda.desconto, venda.itens.map((item) => recebeDesconto(item) ? item.preco : 0n))
  return venda.itens.map((item, i) => {
    const liquido = item.preco - (descontos[i] ?? 0n)
    return { item, quantidade: item.quantidade ?? 1, data, valor: liquido, liquidoVigente: liquido }
  })
}

function porItem(partes: readonly ParteAtiva[]): Map<Id, ParteAtiva> {
  return new Map(partes.flatMap((parte) => parte.item.id === undefined ? [] : [[parte.item.id, parte]]))
}

function aplicarTroca(guardadas: ParteDaVenda[], partes: readonly ParteAtiva[], venda: Venda, nova: Venda | undefined, data: Dia, operacaoId: Id): ParteAtiva[] {
  const anteriores = porItem(partes)
  const novas = nova ? partesDaVenda(nova, data, (item) => item.id !== undefined && anteriores.has(item.id)) : []
  const restantes = porItem(novas)
  const removidas = partes.flatMap((parte) => {
    const mantida = parte.item.id === undefined ? undefined : restantes.get(parte.item.id)
    const mantidaQtd = mantida?.quantidade ?? 0
    const quantidade = parte.quantidade - mantidaQtd
    if (quantidade === 0) return []
    const valor = parte.valor - valorDasUnidades(parte.valor, parte.quantidade, mantidaQtd)
    return [{ parte, quantidade, valor, bruto: parte.item.preco - (mantida?.item.preco ?? 0n) }]
  })
  // D-059 já gravou o desconto retido. A diferença inteira pertence às devoluções.
  const desconto = ratearValor(venda.desconto - (nova?.desconto ?? 0n), removidas.map((removida) => removida.bruto))
  removidas.forEach(({ parte, quantidade, valor, bruto }, i) => guardadas.push({ ...parte, quantidade, valor,
    fim: { tipo: 'troca', operacaoId, data, valor: bruto - (desconto[i] ?? 0n) } }))
  return novas.map((parte) => {
    const anterior = parte.item.id === undefined ? undefined : anteriores.get(parte.item.id)
    if (!anterior) return parte
    return { ...parte, data: anterior.data, valor: valorDasUnidades(anterior.valor, anterior.quantidade, parte.quantidade) }
  })
}

function corrigirPartes(partes: readonly ParteAtiva[], anterior: Venda, nova: Venda, houveTroca: boolean): ParteAtiva[] {
  if (!houveTroca) return partesDaVenda(nova, nova.data, () => true)
  const anteriores = porItem(partes)
  const mexeuEmValores = anterior.desconto !== nova.desconto || nova.itens.some((item) => {
    const antes = anterior.itens.find((outro) => item.id === outro.id)
    return item.preco !== antes?.preco || item.quantidade !== antes.quantidade
  })
  return partesDaVenda(nova, nova.data, () => true).map((parte) => {
    const antes = parte.item.id === undefined ? undefined : anteriores.get(parte.item.id)
    if (!antes) return parte
    const liquidoVigente = mexeuEmValores ? parte.liquidoVigente : antes.liquidoVigente
    return { ...parte, data: antes.data, liquidoVigente, valor: antes.valor + liquidoVigente - antes.liquidoVigente }
  })
}

/** Reconstrói as datas de origem e os efeitos posteriores pelos manifestos correntes (D-059/087/088/090). */
export function reconstruirVendas(lancamentos: readonly Lancamento[], operacoes: readonly OperacaoEstoque[]): ParteDaVenda[] {
  const vendas = new Map(lancamentos.flatMap((l) => l.tipo === 'venda' ? [[l.id, l]] : []))
  const estornos = new Map(lancamentos.flatMap((l) => l.tipo === 'estorno' ? [[l.estornaId, l]] : []))
  const porEstorno = new Map<Id, OperacaoEstoque>()
  const substitutas = new Set<Id>()
  for (const op of operacoes) {
    if (!op.alvo || (op.tipo !== 'troca' && op.tipo !== 'correcao' && op.tipo !== 'cancelamento')) continue
    const estorno = estornos.get(op.alvo.id)
    if (!estorno || !op.lancamentos.some((ref) => ref.id === estorno.id)) continue
    porEstorno.set(estorno.id, op)
    for (const ref of op.lancamentos) if (vendas.has(ref.id)) substitutas.add(ref.id)
  }
  const guardadas: ParteDaVenda[] = []
  for (const inicial of vendas.values()) {
    if (substitutas.has(inicial.id)) continue
    let venda = inicial
    let partes = partesDaVenda(venda, venda.data, () => true)
    let houveTroca = false
    const visitadas = new Set<Id>()
    while (true) {
      const estorno = estornos.get(venda.id)
      if (!estorno) { guardadas.push(...partes); break }
      const op = porEstorno.get(estorno.id)
      if (!op) break // D-088: estorno legado retira a anotação original.
      if (visitadas.has(venda.id)) throw new Error('Ciclo no histórico de vendas')
      visitadas.add(venda.id)
      const refNova = op.lancamentos.find((ref) => vendas.has(ref.id))
      const nova = refNova && vendas.get(refNova.id)
      if (op.tipo === 'cancelamento') {
        for (const parte of partes) guardadas.push({ ...parte,
          fim: { tipo: 'cancelamento', operacaoId: op.id, data: estorno.data, valor: parte.liquidoVigente } })
        break
      }
      if (op.tipo === 'troca') {
        partes = aplicarTroca(guardadas, partes, venda, nova, estorno.data, op.id)
        houveTroca = true
      } else if (nova) partes = corrigirPartes(partes, venda, nova, houveTroca)
      if (!nova) break
      venda = nova
    }
  }
  return guardadas
}
