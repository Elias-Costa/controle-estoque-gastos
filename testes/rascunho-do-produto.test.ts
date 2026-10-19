import { describe, expect, test } from 'bun:test'
import { conferirProduto, produtosParecidos, rascunhoDoProduto } from '../src/interface/rascunho-do-produto.ts'
import { aplicarMascara } from '../src/interface/mascara-de-dinheiro.ts'
import { fraseDaGuardaDoProduto } from '../src/interface/palavras-dos-produtos.ts'
import { ok } from './apoio-estoque.ts'
import type { Produto } from '../src/dominio/produtos.ts'

const categorias = [{ id: 'cat', nome: 'Perfumes' }]
const minimo = { ...rascunhoDoProduto(), nome: 'Perfume', categoriaId: 'cat' }

describe('formulário de produto — RF-11, D-051/055/058', () => {
  test('nome sem categoria não salva; com ambos dispensa todo opcional', () => {
    expect(conferirProduto({ ...minimo, categoriaId: '' }, categorias)).toEqual({ ok: false, motivo: 'categoria-obrigatoria' })
    expect(conferirProduto({ ...minimo, nome: '  ' }, categorias)).toEqual({ ok: false, motivo: 'nome-obrigatorio' })
    expect(conferirProduto({ ...minimo, categoriaId: 'ausente' }, categorias)).toEqual({ ok: false, motivo: 'categoria-inexistente' })
    expect(ok(conferirProduto(minimo, categorias))).toEqual({ id: 'novo', nome: 'Perfume', categoriaId: 'cat' })
  })
  test('zero explícito é conhecido; limpar remove o campo em vez de conservar um zero', () => {
    expect(aplicarMascara('', true)).toBe('')
    const produto = ok(conferirProduto({ ...minimo, custoTexto: aplicarMascara('0', true), precoTexto: aplicarMascara('000', true), minimoTexto: '0' }, categorias))
    expect(produto).toMatchObject({ custoManual: 0n, precoVenda: 0n, estoqueMinimo: 0 })
    expect(ok(conferirProduto(minimo, categorias, produto))).toEqual({ id: produto.id, nome: 'Perfume', categoriaId: 'cat' })
    expect(rascunhoDoProduto(produto)).toMatchObject({ custoTexto: '0,00', precoTexto: '0,00', minimoTexto: '0' })
  })
  test('máscara e ida/volta conservam centavos acima do inteiro seguro de number', () => {
    const texto = aplicarMascara('900719925474099312345')
    const produto = ok(conferirProduto({ ...minimo, custoTexto: texto, precoTexto: aplicarMascara('25') }, categorias))
    expect(produto.custoManual).toBe(900719925474099312345n)
    expect(produto.precoVenda).toBe(25n)
    expect(ok(conferirProduto(rascunhoDoProduto(produto), categorias, produto))).toEqual(produto)
  })
  test('trim só de pontas conserva código com zeros, pontuação e espaços internos', () => {
    expect(ok(conferirProduto({ ...minimo, nome: '  Óleo  corporal ', marca: ' Natura ', codigoCatalogo: ' 00 AB-01 ' }, categorias)))
      .toMatchObject({ nome: 'Óleo  corporal', marca: 'Natura', codigoCatalogo: '00 AB-01' })
  })
  for (const texto of ['-1', '1.5', '1,5', 'NaN', '9007199254740992', '1e2']) {
    test(`mínimo inválido ${texto} tem guarda visível`, () => {
      expect(conferirProduto({ ...minimo, minimoTexto: texto }, categorias)).toEqual({ ok: false, motivo: 'quantidade-invalida' })
      expect(fraseDaGuardaDoProduto('quantidade-invalida')).toContain('inteiro')
    })
  }
  test('compra conhecida conserva referência manual; não lê custo exibido como manual', () => {
    const original: Produto = { id: 'p', nome: 'Perfume', categoriaId: 'cat', custoManual: 1234n, fotoId: 'foto' }
    expect(ok(conferirProduto({ ...minimo, custoTexto: '999,00' }, categorias, original, true)))
      .toMatchObject({ custoManual: 1234n, fotoId: 'foto', id: 'p' })
    expect(ok(conferirProduto(minimo, categorias, { ...original, custoManual: undefined }, true)).custoManual).toBeUndefined()
  })
})

describe('aviso sem bloquear — emenda D-055 aprovada em E-23', () => {
  const produto: Produto = { id: 'p', nome: 'Óleo  corporal', marca: 'Natura', codigoCatalogo: 'AB-0012', categoriaId: 'cat' }
  test('nome OU marca+código bastam; edição exclui o próprio id', () => {
    expect(produtosParecidos({ nome: ' óleo  CORPORAL ' }, [produto])).toEqual([produto])
    expect(produtosParecidos({ nome: 'Outro', marca: ' natura ', codigoCatalogo: ' ab-0012 ' }, [produto])).toEqual([produto])
    expect(produtosParecidos(produto, [produto])).toEqual([])
    expect(conferirProduto({ ...minimo, nome: produto.nome }, categorias).ok).toBe(true)
  })
  test('não equipara acentos, espaços internos, pontuação ou zeros', () => {
    for (const nome of ['Oleo  corporal', 'Óleo corporal']) expect(produtosParecidos({ nome }, [produto])).toEqual([])
    for (const codigoCatalogo of ['AB0012', 'AB-12', 'AB -0012']) {
      expect(produtosParecidos({ nome: 'Outro', marca: 'Natura', codigoCatalogo }, [produto])).toEqual([])
    }
  })
  test('ausência de marca/código não equivale a par preenchido; nem dois vazios avisam', () => {
    for (const entrada of [{ nome: 'Outro', marca: 'Natura' }, { nome: 'Outro', codigoCatalogo: 'AB-0012' }, { nome: '' }]) {
      expect(produtosParecidos(entrada, [produto, { id: 'vazio', nome: '', categoriaId: 'cat' }])).toEqual([])
    }
  })
})
