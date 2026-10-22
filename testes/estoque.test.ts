import { describe, expect, test } from 'bun:test'
import { baseConhecida, corrigirMovimento, novaContagem, posicaoEstoque, projetarEstoque, referenciaDoEfeito, registrarMovimentos,
  type AnulacaoEstoque, type EntregaEstoque, type MovimentoEstoque, type SaidaEstoque } from '../src/dominio/estoque.ts'
import { custoDoProduto } from '../src/dominio/produtos.ts'
import { compra, contagem, ok, produto } from './apoio-estoque.ts'

function posicao(historico: readonly MovimentoEstoque[]) { return ok(projetarEstoque(historico, produto.id)) }
function saida(historico: readonly MovimentoEstoque[], id = 'saida', quantidade = 1): SaidaEstoque {
  return { tipo: 'saida', id, operacaoId: `op-${id}`, revisao: 1, produtoId: produto.id, data: '2026-10-03',
    conhecidos: baseConhecida(historico, produto.id), quantidade, motivo: 'perda' }
}
function anular(alvo: MovimentoEstoque, id = 'anulacao'): AnulacaoEstoque {
  return { tipo: 'anulacao', id, operacaoId: `op-${id}`, revisao: 1, produtoId: alvo.produtoId, data: '2026-10-04',
    conhecidos: [referenciaDoEfeito(alvo)], alvo: referenciaDoEfeito(alvo) }
}

describe('movimentos e posição derivada — RF-12/14/15', () => {
  test('carga inicial registra total contado sem compra ou custo; cada motivo dá saída', () => {
    const inicial = ok(novaContagem([], { id: 'inicial', operacaoId: 'op-inicial', revisao: 1, produtoId: produto.id,
      data: '2026-10-01', totalContado: 10, motivo: 'estoque-inicial' }))
    expect(posicao([inicial]).fisico).toBe(10)
    expect(posicao([inicial]).comprasVigentes).toEqual([])
    for (const motivo of ['perda', 'quebra', 'uso-pessoal', 'brinde'] as const) {
      expect(posicao([inicial, { ...saida([inicial], motivo, 2), motivo }]).fisico).toBe(8)
    }
    expect(contagem([inicial], 'conferencia', 7).base[0]?.quantidade).toBe(10)
    expect(posicao([inicial, contagem([inicial], 'conferencia', 7)]).fisico).toBe(7)
  })
  test('compras exigem quantidade inteira positiva; total contado pode ser zero', () => {
    for (const quantidade of [-1, 0, 0.5, Infinity, NaN, 9007199254740992]) {
      expect(registrarMovimentos([], [compra('p', quantidade)]).ok).toBe(false)
    }
    expect(registrarMovimentos([], [{ ...compra(), custoUnitario: -1n }]).ok).toBe(false)
    expect(registrarMovimentos([], [{ ...compra(), data: '2026-13-01' }]).ok).toBe(false)
    expect(posicao([contagem([], 'zero', 0)]).fisico).toBe(0)
    expect(registrarMovimentos([], [compra('p', 9007199254740991), compra('q', 1)]).ok).toBe(false)
  })
  test('reenvio idêntico não soma; mesmo id/revisão com conteúdo diverso não sobrescreve', () => {
    const p = compra()
    expect(ok(registrarMovimentos([p], [{ ...p }]))).toEqual([p])
    expect(posicao([p, p]).fisico).toBe(10)
    expect(registrarMovimentos([p], [{ ...p, quantidade: 8 }])).toEqual({ ok: false, motivo: 'conteudo-divergente' })
    expect(registrarMovimentos([p], [saida([p]), compra('invalida', -1)]).ok).toBe(false)
    expect(p.quantidade).toBe(10)
  })
  test('dependência ausente ou cíclica não vira projeção completa', () => {
    expect(projetarEstoque([saida([compra()])], produto.id)).toEqual({ ok: false, motivo: 'dependencia-ausente' })
    const a = { ...compra('a'), conhecidos: [{ id: 'b', revisao: 1 }] }
    const b = { ...compra('b'), conhecidos: [{ id: 'a', revisao: 1 }] }
    expect(projetarEstoque([a, b], produto.id).ok).toBe(false)
  })
  test('posição distingue físico, prometido, falta e mínimo opcional inclusive zero', () => {
    expect(ok(posicaoEstoque(3, 2, 2))).toEqual({ fisico: 3, prometido: 2, disponivel: 1, falta: 0, noMinimo: true, divergenciaFisica: false })
    expect(ok(posicaoEstoque(1, 3, 0))).toMatchObject({ disponivel: 0, falta: 2, noMinimo: true })
    expect(ok(posicaoEstoque(0, 0))).toMatchObject({ noMinimo: false })
    expect(ok(posicaoEstoque(0, 0, 0))).toMatchObject({ noMinimo: true })
    expect(ok(posicaoEstoque(-1, 2))).toMatchObject({ falta: 3, divergenciaFisica: true })
    expect(posicaoEstoque(1, -1).ok).toBe(false)
  })
  test('correção preserva ordem original; anular a compra recente recupera anterior/manual', () => {
    const anterior = { ...compra('antiga'), data: '2026-09-30' }
    const recente = compra('recente', 2, 3500n)
    const inverso = anular(recente)
    const substituto = { ...recente, id: 'substituta', operacaoId: inverso.operacaoId, ordemCadastro: 999n, custoUnitario: 3600n }
    const corrigido = ok(corrigirMovimento([anterior, recente], recente, substituto, { sincronizado: true, anulacao: inverso }))
    expect(posicao(corrigido).fisico).toBe(12)
    expect(posicao(corrigido).comprasVigentes).toContainEqual({ id: 'recente', produtoId: produto.id, data: recente.data, ordemCadastro: 1n, custoUnitario: 3600n })
    expect(custoDoProduto(produto, posicao([anterior, recente, inverso]).comprasVigentes)).toBe(3000n)
    expect(custoDoProduto({ ...produto, custoManual: 3500n }, posicao([recente, inverso]).comprasVigentes)).toBe(3500n)
    expect(registrarMovimentos([recente, inverso], [anular(recente, 'outra')])).toEqual({ ok: false, motivo: 'ja-anulado' })
    const local = ok(corrigirMovimento([recente], recente, { ...recente, revisao: 2, quantidade: 4, ordemCadastro: 999n }, { sincronizado: false }))
    expect(local).toHaveLength(2)
    expect(posicao(local).fisico).toBe(4)
    expect(posicao(local).comprasVigentes[0]?.ordemCadastro).toBe(1n)
  })
  test('corrigir quantidade de entrega preserva custo; produto errado exige custo explícito ou desconhecido', () => {
    const entrega: EntregaEstoque = { ...saida([], 'entrega', 2), tipo: 'entrega', itemId: 'item', custoUnitario: 3000n }
    const corrigida = ok(corrigirMovimento([entrega], entrega, { ...entrega, revisao: 2, quantidade: 1, custoUnitario: 9900n }, { sincronizado: false }))
    expect(posicao(corrigida).movimentosVigentes[0]).toMatchObject({ quantidade: 1, custoUnitario: 3000n })
    const outroProduto = ok(corrigirMovimento([entrega], entrega, { ...entrega, revisao: 2, produtoId: 'outro', custoUnitario: undefined }, { sincronizado: false }))
    expect(posicao(outroProduto).fisico).toBe(0)
    expect(baseConhecida(outroProduto, produto.id)).toEqual([])
    expect(ok(projetarEstoque(outroProduto, 'outro')).movimentosVigentes[0]).toMatchObject({ custoUnitario: undefined })
    expect(entrega.custoUnitario).toBe(3000n)
  })
})

describe('contagens causais — D-054/Q39 e RT-11', () => {
  test('corrigir total de uma contagem conserva base; depois do envio guarda inverso e substituto', () => {
    const p = compra()
    const c = contagem([p], 'c', 7)
    const local = ok(corrigirMovimento([p, c], c, { ...c, revisao: 2, totalContado: 8 }, { sincronizado: false }))
    expect(posicao(local).fisico).toBe(8)
    const inverso = anular(c)
    const enviado = ok(corrigirMovimento([p, c], c, { ...c, id: 'substituta', operacaoId: inverso.operacaoId, totalContado: 8 }, { sincronizado: true, anulacao: inverso }))
    expect(posicao(enviado).fisico).toBe(8)
    expect(enviado).toHaveLength(4)
    expect(enviado).toContain(c)
  })
  test('10 → duas contagens de 7 → provisório 10 → conferência 7, independente da chegada', () => {
    const p = compra()
    const a = contagem([p], 'a', 7)
    const b = contagem([p], 'b', 7)
    for (const historico of [[p, a, b], [b, p, a], [a, b, p]]) {
      expect(posicao(historico).fisico).toBe(10)
      expect(posicao(historico).contagensAfetadas).toHaveLength(2)
      const c = contagem(historico, 'c', 7)
      expect(c.resolvidas).toHaveLength(2)
      expect(posicao([...historico, c, c]).fisico).toBe(7)
      expect(posicao([...historico, c]).contagensAfetadas).toEqual([])
    }
  })
  test('movimento desconhecido invalida contagem e terceira dependente; conhecido posterior não', () => {
    const p = compra()
    const a = contagem([p], 'a', 7)
    const c = contagem([p, a], 'c', 6)
    const concorrente = saida([p], 'concorrente', 2)
    const afetado = posicao([p, a, c, concorrente])
    expect(afetado.fisico).toBe(8)
    expect(afetado.contagensAfetadas.map((ref) => ref.id).sort()).toEqual(['a', 'c'])
    const posterior = saida([p, a], 'posterior', 2)
    expect(posicao([posterior, a, p]).fisico).toBe(5)
    expect(posicao([posterior, a, p]).contagensAfetadas).toEqual([])
    const terceira = contagem([p, a, posterior], 'terceira', 4)
    expect(posicao([terceira, posterior, a, p]).fisico).toBe(4)
  })
  test('P/r1=10 → C=7 → P/r2=8 não dá 5, mesmo sem r1 no histórico recebido', () => {
    const p = compra()
    const c = contagem([p], 'c', 7)
    const revisoes = ok(corrigirMovimento([p, c], p, { ...p, revisao: 2, quantidade: 8 }, { sincronizado: false }))
    for (const historico of [revisoes, revisoes.filter((item) => item.id !== p.id || item.revisao === 2)]) {
      expect(posicao(historico).fisico).toBe(8)
      expect(posicao(historico).contagensAfetadas).toEqual([{ id: 'c', revisao: 1 }])
      const nova = contagem(historico, 'nova', 7)
      expect(posicao([...historico, nova]).fisico).toBe(7)
    }
    expect(c.base[0]).toMatchObject({ id: p.id, revisao: 1, quantidade: 10 })
  })
  test('duas resoluções concorrentes também pedem conferência, sem eleger pelo relógio', () => {
    const p = compra()
    const base = [p, contagem([p], 'a', 7), contagem([p], 'b', 7)]
    const r1 = contagem(base, 'r1', 7)
    const r2 = contagem(base, 'r2', 8)
    for (const historico of [[...base, r1, r2], [r2, r1, ...base]]) {
      expect(posicao(historico).fisico).toBe(10)
      expect(posicao(historico).contagensAfetadas.map((ref) => ref.id).sort()).toEqual(['r1', 'r2'])
      expect(posicao([...historico, contagem(historico, 'final', 7)]).fisico).toBe(7)
    }
  })
  test('evidência adulterada e anulação da base não mantêm ajuste aparentemente válido', () => {
    const p = compra()
    const c = contagem([p], 'c', 7)
    expect(projetarEstoque([p, { ...c, base: c.base.map((ref) => ({ ...ref, quantidade: 11 })) }], produto.id).ok).toBe(false)
    expect(posicao([p, c, anular(p)]).fisico).toBe(0)
    expect(posicao([p, c, anular(p)]).contagensAfetadas).toEqual([{ id: 'c', revisao: 1 }])
  })
})
