import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { abrirApp, entrar, esperarIndicador, recarregar, sincronizar } from './apoio.ts'
import { PALAVRAS_DOS_PRODUTOS as P } from '../../src/interface/palavras-dos-produtos.ts'

test('E-28B classificação pelo formulário offline, foto preservada, outro aparelho e restauração', async ({ page, context, browser }, info) => {
  const outro = await browser.newContext({ viewport: { width: 375, height: 812 } }), b = await outro.newPage()
  try {
    await page.setViewportSize({ width: 375, height: 812 })
    await abrirApp(page); await entrar(page); await sincronizar(page); await context.setOffline(true)
    const categoriaId = await page.evaluate(async () => {
      const r = await window.laboratorio?.operacoesEstoque.cadastrarCategoria(`Perfumes E-28B ${crypto.randomUUID()}`)
      if (!r?.ok) throw new Error('categoria não gravou'); return r.valor.id
    })
    await page.getByRole('button', { name: /^Produtos/ }).click()
    await page.getByRole('button', { name: P.novo, exact: true }).click()
    await page.getByLabel(P.nome, { exact: true }).fill('Perfume E-28B')
    await page.getByLabel(P.categoria, { exact: true }).selectOption(categoriaId)
    await page.getByLabel(P.classificacao, { exact: true }).selectOption('feminino')
    await page.getByLabel(P.preco, { exact: true }).fill('9007199254740993')
    await page.getByLabel(P.escolherFoto, { exact: true }).setInputFiles(fileURLToPath(new URL('../arquivos/foto-teste.jpeg', import.meta.url)))
    await expect(page.getByRole('img', { name: 'Perfume E-28B' })).toBeVisible()
    await page.getByRole('button', { name: P.salvar, exact: true }).click()
    await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
    const produto = await page.evaluate(async (categoriaId) => (await window.laboratorio?.banco.produtos.where('categoriaId').equals(categoriaId).toArray())?.[0], categoriaId)
    if (!produto?.fotoId) throw new Error('sem produto/foto')
    for (const classificacao of ['unissex', 'nao-se-aplica', 'masculino', '']) {
      await page.locator(`[data-produto-id="${produto.id}"]`).click()
      const campo = page.getByLabel(P.classificacao, { exact: true })
      await campo.selectOption(classificacao)
      await campo.focus(); await expect(campo).toBeFocused()
      const tamanho = await campo.boundingBox()
      expect(tamanho?.height).toBeGreaterThanOrEqual(44)
      if (classificacao === 'unissex') await page.screenshot({ path: info.outputPath('classificacao-375.png'), fullPage: true })
      await page.getByRole('button', { name: P.salvar, exact: true }).click()
      await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
      await recarregar(page)
      await page.getByRole('button', { name: /^Produtos/ }).click()
      await page.locator(`[data-produto-id="${produto.id}"]`).click()
      await expect(page.getByLabel(P.classificacao, { exact: true })).toHaveValue(classificacao)
      expect(await page.evaluate(async (id) => {
        const p = await window.laboratorio?.banco.produtos.get(id)
        return { fotoId: p?.fotoId, preco: String(p?.precoVenda) }
      }, produto.id)).toEqual({ fotoId: produto.fotoId, preco: '9007199254740993' })
      await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    }
    await page.locator(`[data-produto-id="${produto.id}"]`).click()
    await page.getByLabel(P.classificacao, { exact: true }).selectOption('unissex')
    await page.getByRole('button', { name: P.salvar, exact: true }).click()
    await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
    await context.setOffline(false); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    await abrirApp(b); await entrar(b); await sincronizar(b); await esperarIndicador(b, { pendentes: 0, comProblema: 0 })
    expect(await b.evaluate(async (id) => (await window.laboratorio?.banco.produtos.get(id))?.classificacao, produto.id)).toBe('unissex')
    await outro.setOffline(true)
    await b.getByRole('button', { name: /^Produtos/ }).click()
    await b.locator(`[data-produto-id="${produto.id}"]`).click()
    await expect(b.getByLabel(P.classificacao, { exact: true })).toHaveValue('unissex')
    await expect(b.getByRole('img', { name: 'Perfume E-28B' })).toBeVisible()
    expect(await b.evaluate(async (id) => (await window.laboratorio?.banco.movimentos.where('produtoId').equals(id).count()), produto.id)).toBe(0)
  } finally { await outro.close() }
})
