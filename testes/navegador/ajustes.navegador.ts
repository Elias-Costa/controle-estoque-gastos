import { expect, test, type Page } from '@playwright/test'
import { abrirApp, entrar, esperarIndicador, recarregar, sincronizar } from './apoio.ts'
import { MOTIVOS_DO_AJUSTE, PALAVRAS_DO_ESTOQUE as P } from '../../src/interface/palavras-do-estoque.ts'

async function preparar(page: Page) {
  return page.evaluate(async () => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const c = await l.operacoesEstoque.cadastrarCategoria(`Ajustes ${crypto.randomUUID()}`); if (!c.ok) throw new Error(c.motivo)
    const p = await l.operacoesEstoque.cadastrarProduto({ nome: `Perfume E-26 ${crypto.randomUUID()}`, categoriaId: c.valor.id, custoManual: 3335n })
    const cliente = await l.cadastrarCliente({ nome: `Cliente fictícia E-26 ${crypto.randomUUID()}` })
    if (!p.ok || !cliente.ok) throw new Error('cadastro recusado')
    const compra = await l.operacoesEstoque.registrarMovimento({ tipo: 'compra', produtoId: p.valor.id, data: '2026-10-18', quantidade: 20, custoUnitario: 3335n })
    if (!compra.ok) throw new Error(compra.motivo)
    const venda = await l.operacoesEstoque.lancarVenda({ clienteId: cliente.valor.id, data: '2026-10-18', desconto: 0n, pagamento: 'fiado',
      parcelas: [{ vencimento: '2026-11-19', valor: 5000n }], itens: [{ descricao: p.valor.nome, produtoId: p.valor.id, quantidade: 5, precoUnitario: 1000n, entregue: 2 }] })
    if (!venda.ok) throw new Error(venda.motivo)
    return { produtoId: p.valor.id, clienteId: cliente.valor.id }
  })
}

async function abrirEstoque(page: Page, produtoId: string): Promise<void> {
  await page.getByRole('button', { name: /^Produtos/ }).click()
  await page.locator(`[data-produto-id="${produtoId}"]`).click()
  await page.getByRole('button', { name: P.ver, exact: true }).click()
  await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
}

async function salvar(page: Page, fisico: number): Promise<void> {
  await page.getByRole('button', { name: P.salvar, exact: true }).click()
  await expect(page.locator('[data-estoque-fisico]')).toHaveText(String(fisico))
  await expect(page.locator('[data-estoque-prometido]')).toHaveText('3')
}

async function retrato(page: Page, produtoId: string, clienteId: string) {
  return page.evaluate(async ({ produtoId, clienteId }) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const estado = await l.repositorioEstoque.lerEstado(), projecao = l.projetarEstoque(estado.movimentos, produtoId)
    if (!projecao.ok) throw new Error(projecao.motivo)
    const ficha = estado.lancamentos.filter((item) => item.clienteId === clienteId)
    const movimentos = estado.movimentos.filter((m) => m.produtoId === produtoId).sort((a, b) => a.id.localeCompare(b.id) || a.revisao - b.revisao)
    return { fisico: projecao.valor.fisico, afetadas: projecao.valor.contagensAfetadas.length,
      financeiro: l.conteudoDoEfeito(ficha), saldo: String(l.saldo(ficha)), movimentos: l.conteudoDoEfeito(movimentos) }
  }, { produtoId, clienteId })
}

async function movimento(page: Page, produtoId: string, tipo: 'saida' | 'contagem') {
  return page.evaluate(async ({ produtoId, tipo }) => {
    const estado = await window.laboratorio?.repositorioEstoque.lerEstado()
    const m = estado?.movimentos.filter((m) => m.produtoId === produtoId && m.tipo === tipo).sort((a, b) => b.id.localeCompare(a.id) || b.revisao - a.revisao)[0]
    if (!m) throw new Error('sem movimento')
    return { id: m.id, revisao: m.revisao }
  }, { produtoId, tipo })
}

async function corrigir(page: Page, alvo: { id: string; revisao: number }): Promise<void> {
  await page.locator(`[data-movimento-id="${alvo.id}"][data-revisao="${alvo.revisao}"]`).getByRole('button', { name: P.corrigir, exact: true }).click()
  await expect(page.getByRole('heading', { name: P.corrigirAjuste, exact: true })).toBeVisible()
}

test('E-26 motivos, contagens nos dois sentidos e correção local pela tela sobrevivem à reabertura offline sem mudar ficha', async ({ page, context }, info) => {
  const erros: string[] = []; page.on('pageerror', (erro) => erros.push(erro.message))
  await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page); await context.setOffline(true)
  const { produtoId, clienteId } = await preparar(page)
  const antes = await retrato(page, produtoId, clienteId)
  await abrirEstoque(page, produtoId)
  let fisico = 18
  for (const motivo of MOTIVOS_DO_AJUSTE.filter((m) => m.valor !== 'conferencia')) {
    await page.getByRole('button', { name: P.ajuste, exact: true }).click()
    await page.getByLabel(P.quantidade, { exact: true }).fill('2')
    await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeDisabled()
    await expect(page.getByText('Escolha o motivo do ajuste.', { exact: true })).toBeVisible()
    await page.getByLabel(P.motivo, { exact: true }).selectOption(motivo.valor)
    await page.getByLabel(P.quantidade, { exact: true }).fill('0')
    await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeDisabled()
    await page.getByLabel(P.quantidade, { exact: true }).fill('1,5')
    await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeDisabled()
    await page.getByLabel(P.quantidade, { exact: true }).fill('2')
    await page.getByLabel(P.data, { exact: true }).fill('2099-01-01')
    await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeDisabled()
    await page.getByLabel(P.data, { exact: true }).fill('2026-10-18')
    await expect(page.getByText(`${P.efeito}: −2`, { exact: true })).toBeVisible()
    if (motivo.valor === 'perda') await page.screenshot({ path: info.outputPath('ajuste-375.png'), fullPage: true })
    await salvar(page, fisico -= 2)
    await expect(page.getByText(`${motivo.rotulo} · 18/10/2026`, { exact: true })).toBeVisible()
  }
  const perda = await page.evaluate(async (id) => (await window.laboratorio?.repositorioEstoque.lerEstado())?.movimentos.find((m) => m.produtoId === id && m.tipo === 'saida' && m.motivo === 'perda'), produtoId)
  if (!perda) throw new Error('sem perda')
  await corrigir(page, perda)
  await expect(page.getByLabel(P.motivo, { exact: true })).toHaveValue('perda')
  await page.getByLabel(P.quantidade, { exact: true }).fill('1')
  await salvar(page, 11)
  await expect(page.locator(`[data-movimento-id="${perda.id}"][data-revisao="1"]`).getByText(P.corrigida, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: P.ajuste, exact: true }).click()
  await page.getByLabel(P.motivo, { exact: true }).selectOption('conferencia')
  await page.getByLabel(P.contado, { exact: true }).fill('7')
  await expect(page.getByText(`${P.efeito}: −4`, { exact: true })).toBeVisible()
  await salvar(page, 7)
  await corrigir(page, await movimento(page, produtoId, 'contagem'))
  await expect(page.getByText(P.corrigirContagemExplicacao, { exact: true })).toBeVisible()
  await page.getByLabel(P.contado, { exact: true }).fill('8')
  await expect(page.getByText(`${P.efeitoCorrigido}: −3`, { exact: true })).toBeVisible()
  await salvar(page, 8)
  await page.getByRole('button', { name: P.conferir, exact: true }).click()
  await page.getByLabel(P.contado, { exact: true }).fill('12')
  await expect(page.getByText(`${P.efeito}: +4`, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => ({ largura: innerWidth, conteudo: document.documentElement.scrollWidth,
    pequenos: [...document.querySelectorAll('button, input, select')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44) }).length }))).toEqual({ largura: 375, conteudo: 375, pequenos: 0 })
  await page.screenshot({ path: info.outputPath('contagem-375.png'), fullPage: true })
  await salvar(page, 12)
  await recarregar(page); await abrirEstoque(page, produtoId)
  await expect(page.locator('[data-estoque-fisico]')).toHaveText('12')
  await page.getByRole('button', { name: P.conferir, exact: true }).click()
  await page.getByLabel(P.contado, { exact: true }).fill('0')
  await salvar(page, 0)
  const depois = await retrato(page, produtoId, clienteId)
  expect(depois.financeiro).toBe(antes.financeiro); expect(depois.saldo).toBe('5000')
  await recarregar(page); await abrirEstoque(page, produtoId)
  await expect(page.locator('[data-estoque-fisico]')).toHaveText('0')
  expect(await retrato(page, produtoId, clienteId)).toEqual(depois)
  expect(erros).toEqual([])
})

test('E-26 ajuste corrigido antes e depois de enviar, contagem enviada, reenvio e restauração em outro contexto', async ({ page, context, browser }) => {
  const outro = await browser.newContext(), b = await outro.newPage()
  try {
    await abrirApp(page); await entrar(page); await sincronizar(page)
    const { produtoId, clienteId } = await preparar(page)
    await sincronizar(page); await context.setOffline(true); await abrirEstoque(page, produtoId)
    const antes = await retrato(page, produtoId, clienteId)
    await page.getByRole('button', { name: P.ajuste, exact: true }).click()
    await page.getByLabel(P.motivo, { exact: true }).selectOption('perda')
    await page.getByLabel(P.quantidade, { exact: true }).fill('2')
    await salvar(page, 16)
    await corrigir(page, await movimento(page, produtoId, 'saida'))
    await page.getByLabel(P.quantidade, { exact: true }).fill('3')
    await salvar(page, 15)
    const alvo = await movimento(page, produtoId, 'saida')
    expect(alvo.revisao).toBe(2)
    await context.setOffline(false); await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    await abrirApp(b); await entrar(b); await sincronizar(b)
    expect(await retrato(b, produtoId, clienteId)).toEqual(await retrato(page, produtoId, clienteId))
    await context.setOffline(true)
    await corrigir(page, alvo)
    await page.getByLabel(P.quantidade, { exact: true }).fill('1')
    await salvar(page, 17)
    await expect(page.getByText(P.anulada, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: P.conferir, exact: true }).click()
    await page.getByLabel(P.contado, { exact: true }).fill('7')
    await salvar(page, 7)
    await context.setOffline(false); await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    await context.setOffline(true)
    await corrigir(page, await movimento(page, produtoId, 'contagem'))
    await page.getByLabel(P.contado, { exact: true }).fill('8')
    await salvar(page, 8)
    const depois = await retrato(page, produtoId, clienteId)
    expect(depois.financeiro).toBe(antes.financeiro); expect(depois.saldo).toBe('5000')
    await context.setOffline(false); await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    await page.evaluate(async (id) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const estado = await l.repositorioEstoque.lerEstado()
      for (const op of estado.operacoes.filter((op) => op.movimentos.some((ref) => estado.movimentos.some((m) => m.id === ref.id && m.produtoId === id)))) {
        await l.banco.fila.add({ tabela: 'operacoes', registroId: op.id, versao: op.revisao, criadoEm: new Date().toISOString() })
      }
    }, produtoId)
    await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    expect(await retrato(page, produtoId, clienteId)).toEqual(depois)
    await sincronizar(b); expect(await retrato(b, produtoId, clienteId)).toEqual(depois)
    await b.evaluate(async () => { const l = window.laboratorio; if (!l) throw new Error('sem laboratório'); await l.banco.delete() })
    await recarregar(b); await sincronizar(b)
    expect(await retrato(b, produtoId, clienteId)).toEqual(depois)
    await outro.setOffline(true); await recarregar(b); await abrirEstoque(b, produtoId)
    await expect(b.locator('[data-estoque-fisico]')).toHaveText('8')
    await expect(b.getByText(P.anulada, { exact: true })).toHaveCount(2)
  } finally { await outro.close() }
})

test('E-26 duas contagens offline pedem nova conferência pela tela e preservam ambas no histórico', async ({ page, context, browser }, info) => {
  const outro = await browser.newContext({ viewport: { width: 375, height: 812 } }), b = await outro.newPage()
  try {
    await abrirApp(page); await entrar(page); await sincronizar(page)
    const { produtoId, clienteId } = await preparar(page)
    await sincronizar(page); await abrirApp(b); await entrar(b); await sincronizar(b)
    const antes = await retrato(page, produtoId, clienteId)
    await context.setOffline(true); await outro.setOffline(true)
    for (const aparelho of [page, b]) {
      await abrirEstoque(aparelho, produtoId)
      await aparelho.getByRole('button', { name: P.conferir, exact: true }).click()
      await aparelho.getByLabel(P.contado, { exact: true }).fill('7')
      await salvar(aparelho, 7)
    }
    await context.setOffline(false); await sincronizar(page)
    await outro.setOffline(false); await sincronizar(b); await sincronizar(page)
    for (const aparelho of [page, b]) {
      await expect(aparelho.locator('[data-estoque-fisico]')).toHaveText('18')
      await expect(aparelho.getByText(P.afetada, { exact: true })).toBeVisible()
    }
    await outro.setOffline(true)
    await b.getByRole('button', { name: P.conferir, exact: true }).click()
    await b.getByLabel(P.contado, { exact: true }).fill('6')
    await salvar(b, 6)
    await expect(b.getByText(P.resolvida, { exact: true })).toHaveCount(2)
    await expect(b.getByText(P.anulada, { exact: true })).toHaveCount(0)
    await b.screenshot({ path: info.outputPath('conferencia-resolvida-375.png'), fullPage: true })
    await outro.setOffline(false); await sincronizar(b); await sincronizar(page)
    const depois = await retrato(page, produtoId, clienteId)
    expect(depois).toMatchObject({ fisico: 6, afetadas: 0, financeiro: antes.financeiro, saldo: '5000' })
    expect(await retrato(b, produtoId, clienteId)).toEqual(depois)
  } finally { await outro.close() }
})
