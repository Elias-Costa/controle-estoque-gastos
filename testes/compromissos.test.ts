import { expect, test } from 'bun:test'
import { projetarEstoque, projetarEstoques, type MovimentoEstoque } from '../src/dominio/estoque.ts'
import { projetarCompromissos, prometidoDoProduto } from '../src/dominio/vendas-estoque.ts'
import type { Lancamento } from '../src/dominio/ficha.ts'
import { compra, contagem, item, ok, produto, venda } from './apoio-estoque.ts'

const a = compra('ca', 10), b = { ...compra('cb', 5), produtoId: 'b' }
const vendida = venda('v', [item('ia', 3), { ...item('ib', 2), produtoId: 'b' }])
const entrega: MovimentoEstoque = { id: 'e', revisao: 1, operacaoId: 'oe', produtoId: produto.id, conhecidos: [],
  data: '2026-10-31', tipo: 'entrega', quantidade: 1, itemId: 'ia', custoUnitario: 3000n }
const retorno: MovimentoEstoque = { id: 'r', revisao: 1, operacaoId: 'or', produtoId: produto.id, conhecidos: [],
  data: '2026-10-31', tipo: 'retorno', quantidade: 1, itemId: 'ia' }
const estorno: Lancamento = { id: 'estorno', clienteId: 'cliente', tipo: 'estorno', data: '2026-10-31', estornaId: 'v' }

test('lote conserva físico e promessa de cada produto em entrega, retorno e cancelamento', () => {
  const parcial = ok(projetarCompromissos([vendida], [a, b, entrega], [produto.id, 'b']))
  expect(parcial.get(produto.id)?.estoque.fisico).toBe(9)
  expect(parcial.get(produto.id)?.prometido).toBe(2)
  expect(parcial.get('b')?.estoque.fisico).toBe(5)
  expect(parcial.get('b')?.prometido).toBe(2)
  const devolvida = ok(projetarCompromissos([vendida], [a, b, entrega, retorno], [produto.id, 'b']))
  expect(devolvida.get(produto.id)?.estoque.fisico).toBe(10)
  expect(devolvida.get(produto.id)?.prometido).toBe(3)
  const cancelada = ok(projetarCompromissos([vendida, estorno], [a, b, entrega], [produto.id, 'b']))
  expect(cancelada.get(produto.id)?.estoque.fisico).toBe(9)
  expect(cancelada.get(produto.id)?.prometido).toBe(0)
  expect(cancelada.get('b')?.prometido).toBe(0)
})
test('oráculos unitários e resultados do lote concordam em revisões, contagens disputadas e estornos', () => {
  const historicos = [[a, b], [a, b, entrega], [a, b, entrega, retorno], [a, b, { ...a, revisao: 2, quantidade: 12 }],
    [a, b, contagem([a], 'c1', 7), contagem([a], 'c2', 8)]]
  for (const historico of historicos) for (const financeiro of [[vendida], [vendida, estorno]]) {
    const lote = ok(projetarCompromissos(financeiro, historico, [produto.id, 'b']))
    for (const id of [produto.id, 'b']) {
      expect(lote.get(id)?.estoque).toEqual(ok(projetarEstoque(historico, id)))
      expect(lote.get(id)?.prometido).toBe(ok(prometidoDoProduto(financeiro, historico, id)))
    }
  }
  const disputa = ok(projetarCompromissos([vendida], historicos[4] ?? [], [produto.id, 'b']))
  expect(disputa.get(produto.id)?.estoque.fisico).toBe(10)
  expect(disputa.get(produto.id)?.estoque.contagensAfetadas).toHaveLength(2)
})
test('validação global continua detectando evidência que aponta para outro produto', () => {
  const outra = { ...b, quantidade: 10 }, c = contagem([a], 'c', 7)
  const invalida = { ...c, base: c.base.map((e) => ({ ...e, id: outra.id })), conhecidos: [{ id: outra.id, revisao: 1 }] }
  expect(projetarEstoque([a, outra, invalida], produto.id)).toEqual({ ok: false, motivo: 'base-invalida' })
  expect(projetarEstoques([a, outra, invalida], [produto.id])).toEqual({ ok: false, motivo: 'base-invalida' })
  expect(projetarCompromissos([vendida], [a, outra, invalida], [produto.id])).toEqual({ ok: false, motivo: 'base-invalida' })
})
test('duplicidade de item e retorno excessivo continuam recusados, sem meio lote', () => {
  expect(projetarCompromissos([vendida, venda('outra', [item('ia', 2)])], [a, b], [produto.id, 'b']))
    .toEqual({ ok: false, motivo: 'item-invalido' })
  expect(projetarCompromissos([vendida], [a, b, entrega, { ...retorno, quantidade: 2 }], [produto.id, 'b']))
    .toEqual({ ok: false, motivo: 'excede-retorno' })
})
