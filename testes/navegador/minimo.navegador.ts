import { expect, test, type Page } from '@playwright/test'
import { PALAVRAS_DO_ESTOQUE as E } from '../../src/interface/palavras-do-estoque.ts'
import { PALAVRAS_DOS_PRODUTOS as P } from '../../src/interface/palavras-dos-produtos.ts'
import { abrirApp, entrar, recarregar, sincronizar } from './apoio.ts'

async function abrirLista(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Produtos/ }).click()
  await page.getByRole('button', { name: /^No mínimo/ }).click()
  await expect(page.getByRole('heading', { name: P.noMinimo, exact: true })).toBeVisible()
}

async function reler(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Voltar', exact: true }).click()
  await page.getByRole('button', { name: /^No mínimo/ }).click()
}

test('E-27 lista offline acompanha cada operação, mínimo editado e volta do estoque após reabrir', async ({ page, context }, info) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page); await context.setOffline(true)
  await abrirLista(page)
  await expect(page.getByText(P.vazioNoMinimo, { exact: true })).toBeVisible()
  const ids = await page.evaluate(async () => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const c = await l.operacoesEstoque.cadastrarCategoria('Mínimo E-27')
    if (!c.ok) throw new Error(c.motivo)
    const p = await l.operacoesEstoque.cadastrarProduto({ nome: 'Perfume E-27', categoriaId: c.valor.id, estoqueMinimo: 2 })
    const cliente = await l.cadastrarCliente({ nome: 'Cliente fictícia E-27' })
    if (!p.ok || !cliente.ok) throw new Error('cadastro recusado')
    return { produtoId: p.valor.id, clienteId: cliente.valor.id }
  })
  const linha = page.locator(`[data-produto-minimo-id="${ids.produtoId}"]`)
  await reler(page); await expect(linha).toBeVisible()
  // A entrada parte da lista real e o retorno atravessa o estoque sem perder a origem.
  await linha.click(); await page.getByRole('button', { name: E.compra, exact: true }).click()
  await page.getByLabel(E.quantidade, { exact: true }).fill('5')
  await page.getByRole('button', { name: E.salvar, exact: true }).click()
  await expect(page.locator('[data-estoque-fisico]')).toHaveText('5')
  await page.getByRole('button', { name: 'Voltar', exact: true }).click()
  await expect(page.getByRole('heading', { name: P.noMinimo, exact: true })).toBeVisible()
  await expect(linha).toHaveCount(0)
  const venda = await page.evaluate(async ({ produtoId, clienteId }) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const grupo = await l.operacoesEstoque.lancarVenda({ clienteId, data: '2026-10-20', desconto: 0n, pagamento: 'fiado',
      parcelas: [{ vencimento: '2026-11-20', valor: 4000n }], itens: [{ produtoId, descricao: 'Perfume E-27', quantidade: 4, entregue: 1, precoUnitario: 1000n }] })
    if (!grupo.ok) throw new Error(grupo.motivo)
    const v = grupo.valor.lancamentos.find((l) => l.tipo === 'venda')
    const itemId = v?.tipo === 'venda' ? v.itens[0]?.id : undefined
    if (!v || !itemId) throw new Error('sem venda/item')
    return { vendaId: v.id, itemId }
  }, ids)
  await reler(page)
  await expect(linha).toContainText('Disponível: 1 · Estoque mínimo: 2')
  await expect(linha).toContainText('Em estoque: 4 · Prometido: 3')
  await page.screenshot({ path: info.outputPath('minimo-375.png'), fullPage: true })
  await page.evaluate(async (venda) => {
    const r = await window.laboratorio?.operacoesEstoque.entregar({ ...venda, quantidade: 2, data: '2026-10-20' })
    if (!r?.ok) throw new Error('entrega recusada')
  }, venda)
  await reler(page)
  await expect(linha).toContainText('Em estoque: 2 · Prometido: 1')
  await page.evaluate(async (venda) => {
    const r = await window.laboratorio?.operacoesEstoque.cancelarVenda(venda.vendaId, '2026-10-20', [{ itemId: venda.itemId, quantidade: 0 }])
    if (!r?.ok) throw new Error('cancelamento recusado')
  }, venda)
  await reler(page)
  await expect(linha).toContainText('Disponível: 2 · Estoque mínimo: 2')
  await expect(linha).toContainText('Prometido: 0')
  await page.evaluate(async (venda) => {
    const r = await window.laboratorio?.operacoesEstoque.registrarRetorno(venda.vendaId, '2026-10-20', [{ itemId: venda.itemId, quantidade: 1 }])
    if (!r?.ok) throw new Error('retorno recusado')
  }, venda)
  await reler(page); await expect(linha).toHaveCount(0)
  await page.evaluate(async (produtoId) => {
    const r = await window.laboratorio?.operacoesEstoque.registrarMovimento({ tipo: 'saida', motivo: 'quebra', produtoId, quantidade: 1, data: '2026-10-20' })
    if (!r?.ok) throw new Error('ajuste recusado')
  }, ids.produtoId)
  await reler(page); await linha.click()
  await page.getByRole('button', { name: E.conferir, exact: true }).click()
  await page.getByLabel(E.contado, { exact: true }).fill('0')
  await page.getByRole('button', { name: E.salvar, exact: true }).click()
  await expect(page.locator('[data-estoque-fisico]')).toHaveText('0')
  await page.getByRole('button', { name: E.cadastro, exact: true }).click()
  await page.getByLabel(P.minimo, { exact: true }).fill('')
  await page.getByRole('button', { name: P.salvar, exact: true }).click()
  await expect(page.locator('[data-estoque-fisico]')).toHaveText('0')
  await page.getByRole('button', { name: 'Voltar', exact: true }).click()
  await expect(linha).toHaveCount(0)
  await page.getByRole('button', { name: 'Voltar', exact: true }).click()
  await page.locator(`[data-produto-id="${ids.produtoId}"]`).click()
  await page.getByLabel(P.minimo, { exact: true }).fill('0')
  await page.getByRole('button', { name: P.salvar, exact: true }).click()
  await page.getByRole('button', { name: /^No mínimo/ }).click()
  await expect(linha).toContainText('Disponível: 0 · Estoque mínimo: 0')
  await recarregar(page); await abrirLista(page)
  await expect(linha).toContainText('Em estoque: 0 · Prometido: 0')
})

test('E-27 mínimo vazio/zero e limites em 400 produtos locais sem rede e sem alvos pequenos', async ({ page, context }, info) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page); await context.setOffline(true)
  await page.evaluate(async () => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const c = await l.operacoesEstoque.cadastrarCategoria('Volume local E-27')
    if (!c.ok) throw new Error(c.motivo)
    for (let i = 0; i < 400; i++) {
      const p = await l.operacoesEstoque.cadastrarProduto({ nome: `Produto ${String(i).padStart(3, '0')}`, categoriaId: c.valor.id,
        marca: 'Marca de teste', codigoCatalogo: '00123', estoqueMinimo: i % 4 === 0 ? undefined : i % 4 === 1 ? 0 : 2 })
      if (!p.ok) throw new Error(p.motivo)
      if (i % 4 >= 2) {
        const r = await l.operacoesEstoque.registrarMovimento({ tipo: 'compra', produtoId: p.valor.id, quantidade: i % 4 === 2 ? 3 : 2, data: '2026-10-20' })
        if (!r.ok) throw new Error(r.motivo)
      }
    }
  })
  const inicio = Date.now()
  await abrirLista(page)
  await expect(page.locator('[data-produto-minimo-id]')).toHaveCount(200)
  const renderizacaoMs = Date.now() - inicio
  await expect(page.locator('[data-produto-minimo-id]').first()).toContainText('Produto 001')
  await expect(page.locator('[data-produto-minimo-id]').last()).toContainText('Produto 399')
  const medidas = await page.evaluate(() => ({ largura: innerWidth, conteudo: document.documentElement.scrollWidth,
    alvosPequenos: [...document.querySelectorAll('button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44) }).length }))
  expect(medidas).toEqual({ largura: 375, conteudo: 375, alvosPequenos: 0 })
  await page.screenshot({ path: info.outputPath('400-produtos-minimo-375.png') })
  console.log('E-27 volume Chromium:', JSON.stringify({ produtos: 400, noMinimo: 200, renderizacaoMs, ...medidas }))
})

test('E-27 lista aberta relê compra e mínimo recebidos do outro contexto e reabre offline', async ({ page, browser }) => {
  const outro = await browser.newContext(), b = await outro.newPage()
  try {
    await abrirApp(page); await entrar(page); await sincronizar(page)
    const produtoId = await page.evaluate(async () => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const c = await l.operacoesEstoque.cadastrarCategoria(`Mínimo remoto ${crypto.randomUUID()}`)
      if (!c.ok) throw new Error(c.motivo)
      const p = await l.operacoesEstoque.cadastrarProduto({ nome: 'Mínimo entre aparelhos', categoriaId: c.valor.id, estoqueMinimo: 0 })
      if (!p.ok) throw new Error(p.motivo)
      return p.valor.id
    })
    await sincronizar(page); await abrirLista(page)
    const linha = page.locator(`[data-produto-minimo-id="${produtoId}"]`)
    await expect(linha).toBeVisible()
    await abrirApp(b); await entrar(b); await sincronizar(b)
    await b.evaluate(async (produtoId) => {
      const r = await window.laboratorio?.operacoesEstoque.registrarMovimento({ tipo: 'compra', produtoId, quantidade: 3, data: '2026-10-20' })
      if (!r?.ok) throw new Error('compra recusada')
    }, produtoId)
    await sincronizar(b); await sincronizar(page); await expect(linha).toHaveCount(0)
    await b.evaluate(async (produtoId) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const p = (await l.repositorioEstoque.lerEstado()).produtos.find((p) => p.id === produtoId)
      if (!p) throw new Error('sem produto')
      const r = await l.operacoesEstoque.alterarProduto({ ...p, estoqueMinimo: 3 })
      if (!r.ok) throw new Error(r.motivo)
    }, produtoId)
    await sincronizar(b); await sincronizar(page)
    await expect(linha).toContainText('Disponível: 3 · Estoque mínimo: 3')
    await outro.setOffline(true); await recarregar(b); await abrirLista(b)
    await expect(b.locator(`[data-produto-minimo-id="${produtoId}"]`)).toContainText('Em estoque: 3 · Prometido: 0')
  } finally { await outro.close() }
})
