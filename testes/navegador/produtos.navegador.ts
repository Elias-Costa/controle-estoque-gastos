import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { abrirApp, entrar, esperarIndicador, recarregar, sincronizar } from './apoio.ts'
import { PALAVRAS_DOS_PRODUTOS as P } from '../../src/interface/palavras-dos-produtos.ts'

const foto = fileURLToPath(new URL('../arquivos/foto-teste.jpeg', import.meta.url))

async function produtos(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Produtos/ }).click()
  await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
}

async function categoria(page: Page, nome: string): Promise<void> {
  await page.getByRole('button', { name: P.novaCategoria, exact: true }).click()
  await page.getByLabel(P.nomeCategoria, { exact: true }).fill(nome)
  await page.getByRole('button', { name: P.criarCategoria, exact: true }).click()
  await expect(page.getByLabel(P.nomeCategoria, { exact: true })).toHaveCount(0)
}

test('E-23 formulário completo — opcionais, foto, edição, aviso e reabertura offline', async ({ page, context }, info) => {
  const erros: string[] = []
  page.on('pageerror', (erro) => erros.push(erro.message))
  await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page); await context.setOffline(true); await produtos(page)
  await page.getByRole('button', { name: P.novo, exact: true }).click()
  await page.getByLabel(P.nome, { exact: true }).fill('Perfume de teste E-23')
  await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeDisabled()
  await expect(page.getByText('Escolha uma categoria ou crie uma nova.', { exact: true })).toBeVisible()
  await categoria(page, 'Perfumes E-23')
  await page.getByLabel(P.escolherFoto, { exact: true }).setInputFiles({ name: 'foto-invalida.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('arquivo inválido') })
  await expect(page.getByText(P.falhaFoto, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeEnabled()
  await page.getByRole('button', { name: P.salvar, exact: true }).click()
  await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
  const inicial = await page.evaluate(async () => (await window.laboratorio?.repositorioEstoque.listarProdutos())?.[0])
  expect(inicial).toMatchObject({ nome: 'Perfume de teste E-23' })
  expect(inicial?.precoVenda).toBeUndefined(); expect(inicial?.custoManual).toBeUndefined()
  expect(inicial?.estoqueMinimo).toBeUndefined(); expect(inicial?.fotoId).toBeUndefined()
  if (!inicial) throw new Error('cadastro não gravou')

  await page.locator(`[data-produto-id="${inicial.id}"]`).click()
  await categoria(page, ' perfumes e-23 ')
  expect(await page.evaluate(async () => window.laboratorio?.banco.categorias.count())).toBe(1)
  await page.getByLabel(P.marca, { exact: true }).fill('Marca teste')
  await page.getByLabel(P.classificacao, { exact: true }).selectOption('masculino')
  await page.getByLabel(P.codigo, { exact: true }).fill('0012-AB')
  await page.getByLabel(P.custo, { exact: true }).fill('0')
  await expect(page.getByLabel(P.custo, { exact: true })).toHaveValue('0,00')
  await page.getByLabel(P.preco, { exact: true }).fill('25')
  await expect(page.getByLabel(P.preco, { exact: true })).toHaveValue('0,25')
  await page.getByLabel(P.minimo, { exact: true }).fill('0')
  await page.getByLabel(P.escolherFoto, { exact: true }).setInputFiles(foto)
  await expect(page.getByRole('img', { name: inicial.nome })).toBeVisible()
  await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeEnabled()
  expect(await page.evaluate(() => ({ largura: innerWidth, conteudo: document.documentElement.scrollWidth,
    alvosPequenos: [...document.querySelectorAll('button, select, input:not([hidden])')].filter((elemento) => {
      const r = elemento.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44)
    }).length }))).toEqual({ largura: 375, conteudo: 375, alvosPequenos: 0 })
  await page.screenshot({ path: info.outputPath('cadastro-produto-375.png'), fullPage: true })
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  expect(await page.getByLabel(P.minimo, { exact: true }).evaluate((campo) => {
    const rodape = document.querySelector('.rodape-acao')
    return !!rodape && campo.getBoundingClientRect().bottom <= rodape.getBoundingClientRect().top
  })).toBe(true)
  await page.screenshot({ path: info.outputPath('cadastro-produto-final-375.png') })
  await page.getByRole('button', { name: P.salvar, exact: true }).click()
  await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
  const completo = await page.evaluate(async (id) => {
    const p = await window.laboratorio?.banco.produtos.get(id)
    return { ...p, custoManual: String(p?.custoManual), precoVenda: String(p?.precoVenda),
      bytes: p?.fotoId ? (await window.laboratorio?.banco.fotos.get(p.fotoId))?.binario?.length : 0 }
  }, inicial.id)
  expect(completo).toMatchObject({ custoManual: '0', precoVenda: '25', estoqueMinimo: 0, codigoCatalogo: '0012-AB', classificacao: 'masculino' })
  expect(completo.bytes).toBeGreaterThan(0)
  await recarregar(page); await produtos(page)
  await expect(page.locator(`[data-produto-id="${inicial.id}"] img`)).toBeVisible()
  expect(await page.locator(`[data-produto-id="${inicial.id}"] img`).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  await page.locator(`[data-produto-id="${inicial.id}"]`).click()
  await expect(page.getByLabel(P.classificacao, { exact: true })).toHaveValue('masculino')
  await expect.poll(() => page.evaluate(async () => window.laboratorio?.banco.usosFotos.count())).toBe(1)
  await page.getByLabel(P.nome, { exact: true }).fill('Perfume alterado E-23')
  await page.getByLabel(P.preco, { exact: true }).fill('0')
  await expect(page.getByText(P.zero, { exact: true })).toBeVisible()
  await page.getByLabel(P.preco, { exact: true }).press('Backspace')
  await expect(page.getByLabel(P.preco, { exact: true })).toHaveValue('')
  await page.getByLabel(P.preco, { exact: true }).fill('0')
  await page.getByRole('button', { name: P.salvar, exact: true }).click()
  await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(async () => window.laboratorio?.banco.usosFotos.count())).toBe(0)
  expect(await page.evaluate(async (id) => (await window.laboratorio?.banco.produtos.get(id))?.fotoId, inicial.id)).toBe(completo.fotoId)

  // A mesma carga percorre o formulário de novo; estado anterior não pode vazar para o novo.
  await page.getByRole('button', { name: P.novo, exact: true }).click()
  await expect(page.getByLabel(P.nome, { exact: true })).toHaveValue('')
  await page.getByLabel(P.nome, { exact: true }).fill('Outro produto E-23')
  await page.getByLabel(P.categoria, { exact: true }).selectOption(inicial.categoriaId)
  await page.getByLabel(P.marca, { exact: true }).fill(' marca TESTE ')
  await page.getByLabel(P.codigo, { exact: true }).fill(' 0012-ab ')
  await expect(page.getByText(P.parecido, { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: P.parecido }).getByRole('img')).toBeVisible()
  await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeEnabled()
  await page.getByRole('button', { name: P.salvar, exact: true }).click()
  await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
  expect(await page.evaluate(async () => window.laboratorio?.banco.produtos.count())).toBe(2)
  await page.locator(`[data-produto-id="${inicial.id}"]`).click()
  await page.getByLabel(P.preco, { exact: true }).fill('')
  await page.getByLabel(P.custo, { exact: true }).fill('')
  await page.getByLabel(P.minimo, { exact: true }).fill('')
  await page.getByLabel(P.classificacao, { exact: true }).selectOption('')
  await page.getByRole('button', { name: P.salvar, exact: true }).click()
  await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
  expect(await page.evaluate(async (id) => {
    const p = await window.laboratorio?.banco.produtos.get(id)
    return { custo: p?.custoManual === undefined, preco: p?.precoVenda === undefined, minimo: p?.estoqueMinimo === undefined, classificacao: p?.classificacao === undefined }
  }, inicial.id)).toEqual({ custo: true, preco: true, minimo: true, classificacao: true })
  expect(erros).toEqual([])
})

test('E-23 categorias criadas offline em dois aparelhos — vínculos, custo e consulta sincronizada', async ({ page, context, browser }, info) => {
  const outro = await browser.newContext({ viewport: { width: 375, height: 812 } }), b = await outro.newPage()
  const nome = `Categoria E-23 ${crypto.randomUUID()}`
  try {
    await abrirApp(page); await entrar(page); await sincronizar(page)
    await abrirApp(b); await entrar(b); await sincronizar(b)
    await context.setOffline(true); await outro.setOffline(true)
    const ids: { id: string; categoriaId: string }[] = []
    for (const [tela, sufixo] of [[page, 'A'], [b, 'B']] as const) {
      await produtos(tela); await tela.getByRole('button', { name: P.novo, exact: true }).click()
      await tela.getByLabel(P.nome, { exact: true }).fill(`Produto ${sufixo} ${nome}`)
      await categoria(tela, sufixo === 'A' ? nome : ` ${nome.toUpperCase()} `)
      if (sufixo === 'A') {
        await tela.getByLabel(P.escolherFoto, { exact: true }).setInputFiles(foto)
        await expect(tela.getByRole('img')).toBeVisible()
        await expect(tela.getByRole('button', { name: P.salvar, exact: true })).toBeEnabled()
      }
      await tela.getByRole('button', { name: P.salvar, exact: true }).click()
      await expect(tela.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
      const produto = await tela.evaluate(async (nome) => (await window.laboratorio?.repositorioEstoque.listarProdutos())?.find((p) => p.nome === nome), `Produto ${sufixo} ${nome}`)
      if (!produto) throw new Error('produto não gravou')
      ids.push({ id: produto.id, categoriaId: produto.categoriaId })
    }
    expect(ids[0]?.categoriaId).not.toBe(ids[1]?.categoriaId)
    await context.setOffline(false); await sincronizar(page)
    await outro.setOffline(false); await sincronizar(b); await sincronizar(page)
    await esperarIndicador(page, { pendentes: 0, comProblema: 0 }); await esperarIndicador(b, { pendentes: 0, comProblema: 0 })
    await expect(page.getByText(P.categoriasIguais, { exact: true })).toBeVisible()
    for (const produto of ids) {
      await page.locator(`[data-produto-id="${produto.id}"]`).click()
      await expect(page.getByLabel(P.categoria, { exact: true })).toHaveValue(produto.categoriaId)
      await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    }
    const primeiro = ids[0]; if (!primeiro) throw new Error('sem produto')
    await expect(b.locator(`[data-produto-id="${primeiro.id}"] img`)).toBeVisible()
    await outro.setOffline(true); await recarregar(b); await produtos(b)
    await expect.poll(() => b.locator(`[data-produto-id="${primeiro.id}"] img`).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await outro.setOffline(false)
    await page.evaluate(async (produtoId) => {
      const resultado = await window.laboratorio?.operacoesEstoque.registrarMovimento({ tipo: 'compra', produtoId, data: '2026-10-19', quantidade: 2, custoUnitario: 4321n })
      if (!resultado?.ok) throw new Error('compra não gravou')
    }, primeiro.id)
    await sincronizar(page); await sincronizar(b)
    await context.setOffline(true); await recarregar(page); await produtos(page)
    await page.locator(`[data-produto-id="${primeiro.id}"]`).click()
    await expect(page.getByRole('region', { name: P.custoCompra })).toContainText('R$ 43,21')
    await expect(page.getByLabel(P.custo, { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: P.salvar, exact: true }).click()
    await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
    expect(await page.evaluate(async (id) => (await window.laboratorio?.banco.produtos.get(id))?.custoManual, primeiro.id)).toBeUndefined()
    await page.screenshot({ path: info.outputPath('categorias-concorrentes.png') })
  } finally { await outro.close() }
})

test('E-23 renderização de 400 produtos com miniaturas locais e alvos de toque', async ({ page, context }, info) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page); await context.setOffline(true)
  const volume = await page.evaluate(async () => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const categoria = await l.operacoesEstoque.cadastrarCategoria('Volume local E-23')
    if (!categoria.ok) throw new Error(categoria.motivo)
    const tela = document.createElement('canvas'); tela.width = 320; tela.height = 320
    const desenho = tela.getContext('2d'); if (!desenho) throw new Error('sem canvas')
    desenho.fillStyle = '#27764c'; desenho.fillRect(0, 0, 320, 320)
    const blob = await new Promise<Blob>((resolver, rejeitar) => tela.toBlob((blob) => blob ? resolver(blob) : rejeitar(new Error('sem JPEG')), 'image/jpeg'))
    const foto = await l.prepararFoto(blob)
    for (let i = 0; i < 400; i++) {
      const p = await l.operacoesEstoque.cadastrarProduto({ nome: `Produto ${String(i).padStart(3, '0')}`, categoriaId: categoria.valor.id, precoVenda: BigInt(i) }, foto)
      if (!p.ok) throw new Error(p.motivo)
    }
    const inicio = performance.now(), catalogo = await l.repositorioEstoque.lerCatalogo()
    return { consultaMs: performance.now() - inicio, produtos: catalogo.produtos.length, miniaturas: catalogo.miniaturas.length }
  })
  const inicio = Date.now()
  await produtos(page)
  await expect(page.locator('[data-produto-id]')).toHaveCount(400)
  await expect(page.locator('[data-produto-id] img')).toHaveCount(400)
  const renderizacaoMs = Date.now() - inicio
  const medidas = await page.evaluate(() => ({ largura: innerWidth, conteudo: document.documentElement.scrollWidth,
    alvosPequenos: [...document.querySelectorAll('button, select, input:not([hidden])')].filter((elemento) => {
      const r = elemento.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44)
    }).length }))
  expect(medidas).toEqual({ largura: 375, conteudo: 375, alvosPequenos: 0 })
  await page.screenshot({ path: info.outputPath('400-produtos-375.png') })
  console.log('E-23 volume Chromium:', JSON.stringify({ ...volume, renderizacaoMs, ...medidas }))
})
