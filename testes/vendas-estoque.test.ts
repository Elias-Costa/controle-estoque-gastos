import { describe, expect, test } from 'bun:test'
import { multiplicar } from '../src/dominio/dinheiro.ts'
import { parcelas, saldo, totalDaVenda, validar, type Lancamento, type VendaAVista } from '../src/dominio/ficha.ts'
import { baseConhecida, projetarEstoque, type EntregaEstoque, type MovimentoEstoque } from '../src/dominio/estoque.ts'
import { criarItemVendido, prepararCancelamento, prepararCorrecaoVenda, prepararEntrega, prepararRetorno, prepararVendaEstoque,
  prometidoDoProduto, situacaoDoItem, sugerirEntrega, type ItemVendido, type VendaEstoque } from '../src/dominio/vendas-estoque.ts'
import { compra, item, ok, operacao, produto, venda } from './apoio-estoque.ts'

function posicao(historico: readonly MovimentoEstoque[]) { return ok(projetarEstoque(historico, produto.id)).fisico }
function grupoVenda(v: VendaEstoque, historico: readonly MovimentoEstoque[], quantidade: number) {
  return ok(prepararVendaEstoque([], historico, v, operacao('op-venda'), [produto], [{ itemId: 'item', quantidade, movimentoId: 'entrega' }]))
}
function cancelar(v: VendaEstoque, historico: readonly MovimentoEstoque[], quantidade: number) {
  return ok(prepararCancelamento([v], historico, v, { operacao: operacao('op-cancelamento'), estornoId: 'estorno', revisaoVenda: 1,
    data: '2026-10-03', retornos: [{ itemId: 'item', quantidade, movimentoId: 'retorno' }] }))
}
function precoCorrigido(original: VendaEstoque, novoId: string, clienteId = original.clienteId): VendaEstoque {
  return { ...venda(novoId, original.itens.map((entrada) => ({ ...entrada, precoUnitario: 6000n, preco: multiplicar(6000n, entrada.quantidade) }))), clienteId }
}

describe('preço e compatibilidade financeira — EL-02/03', () => {
  test('3 unidades de 3.000 conservam total 9.000 que F1 soma, à vista e fiado', () => {
    const i = item('item', 3, 3000n)
    const v = venda('fiado', [i])
    const avista: VendaAVista = { tipo: 'venda', pagamento: 'avista', forma: 'pix', id: 'avista', clienteId: 'cliente', data: v.data, itens: [i], desconto: 0n }
    const antiga = { ...v, itens: v.itens.map(({ descricao, preco }) => ({ descricao, preco })) }
    expect(i.preco).toBe(9000n)
    expect(totalDaVenda(antiga)).toBe(totalDaVenda(v))
    expect(totalDaVenda(avista)).toBe(9000n)
    expect(saldo([v])).toBe(9000n)
    expect(saldo([avista])).toBe(0n)
    expect(parcelas([v]).reduce((soma, p) => soma + p.restante, 0n)).toBe(9000n)
    expect(validar([v]).ok).toBe(true)
    expect(validar([avista]).ok).toBe(true)
  })
  test('quantidade × preço/custo acima de 2^53 continua exata, sem perda de centavo', () => {
    const valor = 9007199254740993n
    const i = item('item', 3, valor)
    const p = { ...compra(), custoUnitario: valor }
    const grupo = grupoVenda(venda('v', [i]), [p], 3)
    expect(i.preco).toBe(27021597764222979n)
    const entrega = grupo.movimentos[0]
    if (entrega?.tipo !== 'entrega' || entrega.custoUnitario === undefined) throw new Error('entrega ausente')
    expect(multiplicar(entrega.custoUnitario, entrega.quantidade)).toBe(27021597764222979n)
    expect(saldo(grupo.lancamentos)).toBe(i.preco)
  })
  test('avulso não baixa; preço ausente pede valor; zero explícito só integra venda positiva', () => {
    const avulso = ok(criarItemVendido({ id: 'avulso', descricao: 'Produto avulso', quantidade: 2, precoUnitario: 700n }))
    const gratis = item('item', 1, 0n)
    const misturada = venda('mista', [avulso, gratis])
    const grupo = grupoVenda(misturada, [], 1)
    expect(grupo.movimentos).toHaveLength(1)
    expect(grupo.movimentos[0]).toMatchObject({ itemId: 'item', quantidade: 1 })
    expect(prepararVendaEstoque([], [], venda('gratis', [gratis]), operacao('gratis'), [produto], [])).toEqual({ ok: false, motivo: 'venda-gratuita' })
    expect(criarItemVendido({ id: 'vazio', descricao: 'Sem preço', quantidade: 1, produto: { ...produto, precoVenda: undefined } }).ok).toBe(false)
    expect(ok(criarItemVendido({ id: 'zero', descricao: 'Zero', quantidade: 1, precoUnitario: 0n, produto })).preco).toBe(0n)
    expect(ok(criarItemVendido({ id: 'sugestao', descricao: 'Preço do cadastro', quantidade: 1, produto })).preco).toBe(5000n)
    // Compatibilidade: não reescrever nem invalidar uma ocorrência gratuita legada.
    expect(validar([{ tipo: 'venda', pagamento: 'avista', forma: 'pix', id: 'antiga', clienteId: 'cliente', data: '2026-01-01', itens: [{ descricao: 'Legado', preco: 0n }], desconto: 0n }]).ok).toBe(true)
  })
  test('F2 incoerente não altera regra dos itens legados; parcelas ainda precisam fechar', () => {
    const v = venda()
    expect(validar([{ ...v, itens: [{ ...item(), preco: 1n }] }]).ok).toBe(false)
    expect(validar([{ ...v, itens: [item(), item()] }]).ok).toBe(false)
    const parcelasErradas: VendaEstoque = { ...v, pagamento: 'fiado', parcelas: [{ id: 'errada', vencimento: '2026-11-01', valor: 1n }] }
    expect(prepararVendaEstoque([], [], parcelasErradas, operacao('op'), [produto], []).ok).toBe(false)
    expect(prepararVendaEstoque([], [], v, operacao('op'), [], []).ok).toBe(false)
  })
})

describe('venda, promessa, entrega e retorno — RT-11 puro', () => {
  test('físico 3, vender/entregar 2: físico 1, promessa 0, mesmo grupo', () => {
    const v = venda('v', [item('item', 2)])
    const p = compra('p', 3)
    const grupo = grupoVenda(v, [p], 2)
    expect(posicao([p, ...grupo.movimentos])).toBe(1)
    expect(ok(prometidoDoProduto([v], [p, ...grupo.movimentos], produto.id))).toBe(0)
    expect(grupo.operacao.lancamentos).toEqual([{ id: 'v', revisao: 1 }])
    expect(grupo.operacao.movimentos).toEqual([{ id: 'entrega', revisao: 1 }])
  })
  test('físico 1, vender 3: sugestão 1; confirmar 0 ou 1 muda só o entregue', () => {
    const v = venda()
    const p = compra('p', 1)
    expect(sugerirEntrega(3, 1)).toBe(1)
    expect(sugerirEntrega(3, 2)).toBe(2)
    for (const entregue of [0, 1]) {
      const grupo = grupoVenda(v, [p], entregue)
      const historico = [p, ...grupo.movimentos]
      expect(posicao(historico)).toBe(1 - entregue)
      expect(ok(prometidoDoProduto([v], historico, produto.id))).toBe(3 - entregue)
    }
    expect(posicao([p])).toBe(1)
  })
  test('cada entrega copia seu custo: compra posterior/cadastro não reescreve baixa antiga', () => {
    const v = venda()
    const p = compra('p', 1)
    const inicial = grupoVenda(v, [p], 1)
    const novaCompra = { ...compra('nova', 2, 3500n), data: '2026-10-03' }
    const historico = [p, ...inicial.movimentos, novaCompra]
    const segunda = ok(prepararEntrega([v], historico, v, { operacao: operacao('op-segunda'), id: 'segunda', data: '2026-10-04', itemId: 'item', quantidade: 2 }, { ...produto, custoManual: 9999n }))
    expect(inicial.movimentos[0]).toMatchObject({ quantidade: 1, custoUnitario: 3000n })
    expect(segunda.movimentos[0]).toMatchObject({ quantidade: 2, custoUnitario: 3500n })
    expect(posicao([...historico, ...segunda.movimentos])).toBe(0)
    expect(ok(prometidoDoProduto([v], [...historico, ...segunda.movimentos], produto.id))).toBe(0)
  })
  test('entregar acima do físico é permitido; acima da pendência conhecida é recusado', () => {
    const v = venda('v', [item('item', 2)])
    const p = compra('p', 1)
    const entrada = { operacao: operacao('op-entrega'), id: 'e', data: '2026-10-03', itemId: 'item', quantidade: 2 }
    const entrega = ok(prepararEntrega([v], [p], v, entrada, produto))
    expect(posicao([p, ...entrega.movimentos])).toBe(-1)
    expect(sugerirEntrega(2, -1)).toBe(0)
    expect(prepararEntrega([v], [p], v, { ...entrada, quantidade: 3 }, produto)).toEqual({ ok: false, motivo: 'excede-pendencia' })
  })
  test('entregas independentes concorrentes são preservadas e expõem excesso, sem dívida nova', () => {
    const i = item('item', 1)
    const v = venda('v', [i])
    const p = compra('p', 1)
    const entregas = ['a', 'b'].flatMap((id) => ok(prepararEntrega([v], [p], v, { operacao: operacao(`op-${id}`), id, data: '2026-10-03', itemId: 'item', quantidade: 1 }, produto)).movimentos)
    expect(posicao([p, ...entregas])).toBe(-1)
    expect(ok(situacaoDoItem(i, [p, ...entregas], false))).toMatchObject({ entregue: 2, excesso: 1, pendente: 0 })
    expect(saldo([v])).toBe(5000n)
  })
  test('cancelar 1 entregue + 2 prometidos elimina promessa e repõe só 0 ou 1 informado', () => {
    const v = venda()
    const p = compra('p', 3)
    const historico = [p, ...grupoVenda(v, [p], 1).movimentos]
    for (const retorno of [0, 1]) {
      const grupo = cancelar(v, historico, retorno)
      const financeiro = [v, ...grupo.lancamentos]
      expect(posicao([...historico, ...grupo.movimentos])).toBe(2 + retorno)
      expect(ok(prometidoDoProduto(financeiro, [...historico, ...grupo.movimentos], produto.id))).toBe(0)
      expect(saldo(financeiro)).toBe(0n)
      expect(grupo.movimentos).toHaveLength(retorno)
    }
    expect(prepararCancelamento([v], historico, v, { operacao: operacao('c'), estornoId: 'e', data: '2026-10-03', revisaoVenda: 1, retornos: [] }))
      .toEqual({ ok: false, motivo: 'confirmacao-necessaria' })
  })
  test('retorno posterior não repete financeiro e respeita entregue menos já retornado', () => {
    const i = item('item', 2)
    const v = venda('v', [i])
    const p = compra('p', 2)
    const historico = [p, ...grupoVenda(v, [p], 2).movimentos]
    const cancelamento = cancelar(v, historico, 0)
    const financeiro = [v, ...cancelamento.lancamentos]
    const entrada = { operacao: operacao('op-depois'), data: '2026-10-04', retornos: [{ itemId: 'item', quantidade: 1, movimentoId: 'depois' }] }
    const retorno = ok(prepararRetorno(financeiro, historico, v, entrada))
    expect(retorno.lancamentos).toEqual([])
    expect(posicao([...historico, ...retorno.movimentos])).toBe(1)
    expect(ok(situacaoDoItem(i, [...historico, ...retorno.movimentos], true)).podeRetornar).toBe(1)
    expect(prepararRetorno(financeiro, [...historico, ...retorno.movimentos], v,
      { ...entrada, retornos: [{ itemId: 'item', quantidade: 2, movimentoId: 'excesso' }] }).ok).toBe(false)
    expect(prepararRetorno([v], historico, v, entrada).ok).toBe(false)
    expect(saldo(financeiro)).toBe(0n)
  })
})

describe('correção de venda e guardas F1 — RF-08/RN-07/08', () => {
  test('valor/cliente corrigidos conservam identidade, custo, físico e promessa; histórico mantém original', () => {
    const original = venda()
    const p = compra('p', 3)
    const historico = [p, ...grupoVenda(original, [p], 1).movimentos]
    for (const cliente of ['cliente', 'outra']) {
      const nova = precoCorrigido(original, `nova-${cliente}`, cliente)
      const correcao = ok(prepararCorrecaoVenda([original], historico, original, nova, { operacao: operacao(`op-${cliente}`), revisaoOriginal: 1,
        sincronizado: true, estornoId: `estorno-${cliente}`, data: '2026-10-03', natureza: 'financeira' }))
      expect(correcao.movimentos).toEqual([])
      expect(posicao(historico)).toBe(2)
      expect(historico[1]).toMatchObject({ itemId: 'item', custoUnitario: 3000n })
      expect(ok(prometidoDoProduto([original, ...correcao.lancamentos], historico, produto.id))).toBe(2)
      expect(saldo([original, ...correcao.lancamentos].filter((l) => l.clienteId === cliente))).toBe(18000n)
      expect(prepararRetorno([original, ...correcao.lancamentos], historico, original,
        { operacao: operacao('retorno-invalido'), data: '2026-10-04', retornos: [{ itemId: 'item', quantidade: 1, movimentoId: 'r' }] }).ok).toBe(false)
    }
  })
  test('correção local conserva id/revisão e pode reordenar itens sem novas baixas', () => {
    const original = venda('v', [item(), item('segundo', 1)])
    const grupoPendente = grupoVenda(original, [], 0)
    const nova = { ...precoCorrigido(original, original.id), itens: [...precoCorrigido(original, original.id).itens].reverse() }
    const grupo = ok(prepararCorrecaoVenda([original], [], original, nova, { operacao: operacao('op-venda', 2), revisaoOriginal: 1,
      sincronizado: false, data: '2026-10-03', natureza: 'financeira', grupoPendente }))
    expect(grupo.movimentos).toEqual([])
    expect(grupo.operacao.lancamentos).toEqual([{ id: 'v', revisao: 2 }])
    expect(grupo.lancamentos).toEqual([nova])
    expect(ok(prometidoDoProduto(grupo.lancamentos, [], produto.id))).toBe(4)
  })
  test('correção pendente preserva entrega e manifesto inteiro, sem exigir alvo nunca enviado', () => {
    const original = venda()
    const grupoPendente = grupoVenda(original, [], 1)
    const nova = precoCorrigido(original, original.id)
    const revisado = ok(prepararCorrecaoVenda([original], grupoPendente.movimentos, original, nova,
      { operacao: operacao('op-venda', 2), revisaoOriginal: 1, sincronizado: false, data: '2026-10-03', natureza: 'financeira', grupoPendente }))
    expect(revisado.operacao).toMatchObject({ id: 'op-venda', revisao: 2, tipo: 'venda', alvo: undefined })
    expect(revisado.movimentos).toEqual(grupoPendente.movimentos)
    expect(revisado.operacao.movimentos).toEqual(grupoPendente.operacao.movimentos)
    expect(revisado.lancamentos).toEqual([nova])
    expect(prepararCorrecaoVenda([original], grupoPendente.movimentos, original, nova,
      { operacao: operacao('op-venda', 2), revisaoOriginal: 1, sincronizado: false, data: '2026-10-03', natureza: 'financeira' }).ok).toBe(false)
  })
  test('cancelar venda paga e mover parte paga seguem recusas financeiras existentes', () => {
    const original = venda('v', [item('item', 1)])
    const recebido: Lancamento = { tipo: 'recebimento', forma: 'pix', id: 'recebido', clienteId: 'cliente', data: '2026-10-03', valor: 5000n }
    expect(prepararCancelamento([original, recebido], [], original,
      { operacao: operacao('c'), estornoId: 'estorno', data: '2026-10-04', revisaoVenda: 1, retornos: [] })).toEqual({ ok: false, motivo: 'ficha-ficaria-negativa' })
    for (const sincronizado of [false, true]) {
      expect(prepararCorrecaoVenda([original, recebido], [], original, precoCorrigido(original, sincronizado ? 'nova' : 'v', 'outra'),
        { operacao: operacao('c'), revisaoOriginal: 1, sincronizado, estornoId: 'estorno', data: '2026-10-04', natureza: 'financeira' })).toEqual({ ok: false, motivo: 'parcela-paga-alterada' })
      expect(prepararCorrecaoVenda([original, recebido], [], original, precoCorrigido(original, sincronizado ? 'nova' : 'v'),
        { operacao: operacao('c'), revisaoOriginal: 1, sincronizado, estornoId: 'estorno', data: '2026-10-04', natureza: 'financeira' }).ok).toBe(false)
    }
  })
  test('corrigir produto errado exige corrigir a entrega; custo desconhecido não copia cadastro atual', () => {
    const original = venda('v', [item('item', 1)])
    const inicial = grupoVenda(original, [], 1)
    const entrega = inicial.movimentos[0]
    if (entrega?.tipo !== 'entrega') throw new Error('entrega ausente')
    const novoItem: ItemVendido = { ...item('item', 1), produtoId: 'outro' }
    const nova = venda('nova', [novoItem])
    const entrada = { operacao: operacao('correcao'), revisaoOriginal: 1, sincronizado: true, estornoId: 'estorno', data: '2026-10-03', natureza: 'anotacao' as const }
    expect(prepararCorrecaoVenda([original], inicial.movimentos, original, nova, entrada).ok).toBe(false)
    const substituto: EntregaEstoque = { ...entrega, id: 'entrega-corrigida', operacaoId: 'correcao', produtoId: 'outro', custoUnitario: undefined,
      conhecidos: baseConhecida(inicial.movimentos, produto.id) }
    const corrigida = ok(prepararCorrecaoVenda([original], inicial.movimentos, original, nova, { ...entrada, entregas: [{ alvo: entrega, substituto,
      anulacao: { tipo: 'anulacao', id: 'inverso', operacaoId: 'correcao', revisao: 1, produtoId: produto.id, data: entrada.data, conhecidos: [entrega], alvo: entrega } }] }))
    expect(posicao([...inicial.movimentos, ...corrigida.movimentos])).toBe(0)
    expect(ok(projetarEstoque([...inicial.movimentos, ...corrigida.movimentos], 'outro')).fisico).toBe(-1)
    expect(corrigida.movimentos.find((m) => m.tipo === 'entrega')).toMatchObject({ custoUnitario: undefined })
    expect(inicial.movimentos[0]).toMatchObject({ custoUnitario: 2500n })
  })
  test('corrigir entrega anotada 2 para 1 ou 0 é correção, sem inventar retorno físico', () => {
    const original = venda('v', [item('item', 2)])
    const inicial = grupoVenda(original, [], 2)
    const entrega = inicial.movimentos[0]
    if (entrega?.tipo !== 'entrega') throw new Error('entrega ausente')
    for (const quantidade of [0, 1]) {
      const nova = venda('v', [item('item', 1)])
      const corrigida = ok(prepararCorrecaoVenda([original], inicial.movimentos, original, nova,
        { operacao: operacao('op-venda', 2), revisaoOriginal: 1, sincronizado: false, grupoPendente: inicial,
          data: '2026-10-03', natureza: 'anotacao', entregas: [{ alvo: entrega, substituto: { ...entrega, revisao: 2, quantidade, custoUnitario: 9999n } }] }))
      expect(posicao([...inicial.movimentos, ...corrigida.movimentos])).toBe(0 - quantidade)
      expect(corrigida.movimentos[0]).toMatchObject({ quantidade, custoUnitario: 2500n })
      expect(corrigida.movimentos.some((m) => m.tipo === 'retorno')).toBe(false)
      expect(ok(prometidoDoProduto(corrigida.lancamentos, [...inicial.movimentos, ...corrigida.movimentos], produto.id))).toBe(1 - quantidade)
      expect(saldo(corrigida.lancamentos)).toBe(5000n)
    }
  })
})
