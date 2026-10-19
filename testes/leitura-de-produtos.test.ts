import { describe, expect, test } from 'bun:test'
import type { CatalogoProdutos } from '../src/dados/repositorio-estoque.ts'
import { lerProdutos, rotuloDaCategoria } from '../src/interface/leitura-de-produtos.ts'
import { compra, produto } from './apoio-estoque.ts'

const catalogo: CatalogoProdutos = { produtos: [{ ...produto, fotoId: 'foto' }], categorias: [{ id: produto.categoriaId, nome: 'Perfumes' }],
  movimentos: [], miniaturas: [{ fotoId: 'foto', binario: new Uint8Array([1, 2, 3]) }] }

describe('consulta de produtos — Q46A/Q48A', () => {
  test('conserva miniatura e referência manual sem compra válida', () => {
    const [linha] = lerProdutos(catalogo)
    expect(linha).toMatchObject({ custo: 2500n, custoDaCompra: false, miniatura: new Uint8Array([1, 2, 3]) })
  })
  test('custo de compra vence, inclusive zero e desconhecido; não modifica o cadastro', () => {
    for (const custoUnitario of [0n, 4567n, undefined]) {
      const [linha] = lerProdutos({ ...catalogo, movimentos: [{ ...compra(), custoUnitario }] })
      expect(linha?.custo).toBe(custoUnitario)
      expect(linha?.custoDaCompra).toBe(true)
      expect(linha?.produto.custoManual).toBe(2500n)
    }
  })
  test('anular a compra recupera manual do cadastro vencedor e respeita data/ordem', () => {
    const c = compra(), anterior = { ...compra('antiga', 1, 100n), data: '2026-09-01', ordemCadastro: 100n }
    expect(lerProdutos({ ...catalogo, movimentos: [c, anterior] })[0]?.custo).toBe(3000n)
    const anular = { tipo: 'anulacao', id: 'a', revisao: 1, operacaoId: 'anula', produtoId: produto.id, data: '2026-10-19',
      alvo: { id: c.id, revisao: c.revisao }, conhecidos: [{ id: c.id, revisao: c.revisao }] } as const
    expect(lerProdutos({ ...catalogo, produtos: [{ ...produto, custoManual: 777n }], movimentos: [c, anular] })[0])
      .toMatchObject({ custo: 777n, custoDaCompra: false })
  })
  test('categorias concorrentes mantêm ids e vínculos com rótulos distinguíveis e estáveis', () => {
    const categorias = [{ id: 'a', nome: 'Perfumes' }, { id: 'b', nome: ' perfumes ' }]
    const produtos = categorias.map((categoria) => ({ ...produto, id: categoria.id, categoriaId: categoria.id }))
    const linhas = lerProdutos({ ...catalogo, categorias, produtos })
    expect(linhas.map((linha) => linha.categoria.id)).toEqual(['a', 'b'])
    expect(categorias.map((categoria) => rotuloDaCategoria(categoria, [...categorias].reverse()))).toEqual(['Perfumes (1)', ' perfumes  (2)'])
  })
  test('categoria ausente e movimento inválido não exibem um custo inventado', () => {
    expect(() => lerProdutos({ ...catalogo, categorias: [] })).toThrow()
    expect(() => lerProdutos({ ...catalogo, movimentos: [{ ...compra(), quantidade: -1 }] })).toThrow()
  })
})
