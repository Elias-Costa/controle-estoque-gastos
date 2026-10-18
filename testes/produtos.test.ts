import { describe, expect, test } from 'bun:test'
import { alterarCustoManual, categoriasComMesmoNome, custoDoProduto, novaCategoria, novoProduto, proximoCarimboDeCadastro } from '../src/dominio/produtos.ts'
import { compra, ok, produto } from './apoio-estoque.ts'

describe('cadastro e referência de custo — D-018/058', () => {
  const categoria = { id: 'perfumaria', nome: 'Perfumes' }
  test('nome e categoria existente bastam; preço, mínimo, foto e custo são opcionais', () => {
    expect(ok(novoProduto({ id: 'p', nome: '  Perfume  ', categoriaId: categoria.id }, [categoria])))
      .toEqual({ id: 'p', nome: 'Perfume', categoriaId: categoria.id })
    expect(novoProduto({ ...produto, nome: '  ' }, [categoria]).ok).toBe(false)
    expect(novoProduto({ ...produto, categoriaId: '' }, [categoria])).toEqual({ ok: false, motivo: 'categoria-obrigatoria' })
    expect(novoProduto(produto, []).ok).toBe(false)
  })
  test('categoria ignora caixa e espaços nas pontas; mantém sinônimos e acentos distintos', () => {
    expect(ok(novaCategoria({ id: 'novo', nome: ' perfumes ' }, [categoria]))).toBe(categoria)
    expect(ok(novaCategoria({ id: 'outro', nome: 'Fragrâncias' }, [categoria])).id).toBe('outro')
    expect(ok(novaCategoria({ id: 'acento', nome: 'Perfumés' }, [categoria])).id).toBe('acento')
    expect(novaCategoria({ id: 'vazio', nome: ' ' }, []).ok).toBe(false)
    const concorrente = { id: 'offline', nome: 'PERFUMES' }
    expect(categoriasComMesmoNome(categoria, [categoria, concorrente])).toEqual([concorrente])
    expect(ok(novoProduto({ ...produto, categoriaId: concorrente.id }, [categoria, concorrente])).categoriaId).toBe('offline')
  })
  test('zero explícito não é ausência; mínimo é inteiro e dinheiro não admite negativo', () => {
    expect(ok(novoProduto({ ...produto, precoVenda: 0n, custoManual: 0n, estoqueMinimo: 0 }, [categoria])).estoqueMinimo).toBe(0)
    for (const estoqueMinimo of [-1, 0.5, Infinity, NaN, 9007199254740992]) expect(novoProduto({ ...produto, estoqueMinimo }, [categoria]).ok).toBe(false)
    expect(novoProduto({ ...produto, precoVenda: -1n }, [categoria]).ok).toBe(false)
    expect(novoProduto({ ...produto, custoManual: -1n }, [categoria]).ok).toBe(false)
  })
  test('data vence digitação tardia; desempata por carimbo e id originais', () => {
    const antiga = { ...compra('antiga'), data: '2026-09-30', ordemCadastro: 999n }
    const recente = { ...compra('recente', 2, 3500n), ordemCadastro: 2n }
    for (const compras of [[antiga, recente], [recente, antiga]]) expect(custoDoProduto(produto, compras)).toBe(3500n)
    expect(custoDoProduto(produto, [compra('a'), { ...compra('z', 1, 3700n) }])).toBe(3700n)
    expect(custoDoProduto(produto, [compra('z'), { ...compra('a', 1, 3800n), ordemCadastro: 2n }])).toBe(3800n)
  })
  test('compra vencedora sem custo não cai no manual nem na anterior; zero é conhecido', () => {
    const desconhecida = { ...compra('nova'), custoUnitario: undefined, ordemCadastro: 2n }
    expect(custoDoProduto(produto, [compra(), desconhecida])).toBeUndefined()
    expect(custoDoProduto(produto, [{ ...desconhecida, custoUnitario: 0n }])).toBe(0n)
    expect(custoDoProduto({ ...produto, custoManual: undefined }, [])).toBeUndefined()
    expect(custoDoProduto({ ...produto, custoManual: 3500n }, [])).toBe(3500n)
    expect(alterarCustoManual(produto, 4500n, [desconhecida])).toEqual({ ok: false, motivo: 'custo-definido-por-compra' })
    expect(ok(alterarCustoManual(produto, 3500n, [])).custoManual).toBe(3500n)
    expect(produto.custoManual).toBe(2500n)
  })
  test('carimbo lógico cresce com relógio empatado ou recuado, sem converter para float', () => {
    expect(proximoCarimboDeCadastro(100n, 99n)).toBe(100n)
    expect(proximoCarimboDeCadastro(100n, 100n)).toBe(101n)
    expect(proximoCarimboDeCadastro(1n, 9007199254740993n)).toBe(9007199254740994n)
  })
})
