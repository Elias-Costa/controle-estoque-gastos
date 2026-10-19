import { expect, test, type Page } from '@playwright/test'
import { abrirApp, entrar, esperarIndicador, recarregar, sincronizar } from './apoio.ts'
import { PALAVRAS_DO_ESTOQUE as P } from '../../src/interface/palavras-do-estoque.ts'

async function preparar(page: Page) {
  return page.evaluate(async () => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const c = await l.operacoesEstoque.cadastrarCategoria(`Entradas ${crypto.randomUUID()}`); if (!c.ok) throw new Error(c.motivo)
    const p = await l.operacoesEstoque.cadastrarProduto({ nome: `Perfume E-24 ${crypto.randomUUID()}`, categoriaId: c.valor.id, custoManual: 2500n })
    if (!p.ok) throw new Error(p.motivo)
    return { produtoId: p.valor.id, nome: p.valor.nome }
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
}

async function retrato(page: Page, produtoId: string) {
  return page.evaluate(async (id) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const estado = await l.repositorioEstoque.lerEstado(), produto = estado.produtos.find((p) => p.id === id)
    const projecao = l.projetarEstoque(estado.movimentos, id)
    if (!produto || !projecao.ok) throw new Error('estoque incompleto')
    const movimentos = estado.movimentos.filter((m) => m.produtoId === id).sort((a, b) => a.id.localeCompare(b.id) || a.revisao - b.revisao)
    return { fisico: projecao.valor.fisico, custo: String(l.custoDoProduto(produto, projecao.valor.comprasVigentes)),
      quantidade: movimentos.length, conteudo: l.conteudoDoEfeito(movimentos) }
  }, produtoId)
}

test('E-24 compra e estoque inicial pelo formulário — centavos, datas, correção e reabertura offline', async ({ page, context }, info) => {
  const erros: string[] = []; page.on('pageerror', (erro) => erros.push(erro.message))
  await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page); await context.setOffline(true)
  const { produtoId } = await preparar(page)
  await abrirEstoque(page, produtoId)
  await expect(page.locator('[data-estoque-fisico]')).toHaveText('0')
  await page.getByRole('button', { name: P.inicial, exact: true }).click()
  await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeDisabled()
  await page.getByLabel(P.contado, { exact: true }).fill('7')
  await expect(page.getByText(/O custo inicial.*R\$ 25,00/)).toBeVisible()
  await salvar(page, 7)
  const inicial = await page.evaluate(async (id) => (await window.laboratorio?.repositorioEstoque.lerEstado())?.movimentos.find((m) => m.produtoId === id && m.tipo === 'contagem'), produtoId)
  if (!inicial) throw new Error('sem contagem inicial')
  await page.locator(`[data-movimento-id="${inicial.id}"]`).getByRole('button', { name: P.corrigir }).click()
  await page.getByLabel(P.contado, { exact: true }).fill('8')
  await salvar(page, 8)
  expect(await page.evaluate(async () => window.laboratorio?.banco.lancamentos.count())).toBe(0)
  await page.getByRole('button', { name: P.compra, exact: true }).click()
  await page.getByLabel(P.quantidade, { exact: true }).fill('1.5')
  await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeDisabled()
  await page.getByLabel(P.quantidade, { exact: true }).fill('3')
  await page.getByLabel(P.custo, { exact: true }).fill('3335')
  await expect(page.getByText('Total da compra: R$ 100,05', { exact: true })).toBeVisible()
  await page.getByLabel(P.data, { exact: true }).fill('2099-01-01')
  await expect(page.getByRole('button', { name: P.salvar, exact: true })).toBeDisabled()
  await page.getByLabel(P.data, { exact: true }).fill('2026-10-18')
  expect(await page.evaluate(() => ({ largura: innerWidth, conteudo: document.documentElement.scrollWidth,
    pequenos: [...document.querySelectorAll('button, input, select')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44) }).length }))).toEqual({ largura: 375, conteudo: 375, pequenos: 0 })
  await page.screenshot({ path: info.outputPath('entrada-375.png'), fullPage: true })
  await salvar(page, 11)
  const compra = await page.evaluate(async (id) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const cliente = await l.cadastrarCliente({ nome: 'Cliente fictícia E-24' }); if (!cliente.ok) throw new Error(cliente.motivo)
    const venda = await l.operacoesEstoque.lancarVenda({ clienteId: cliente.valor.id, data: '2026-10-18', desconto: 0n, pagamento: 'avista', forma: 'dinheiro',
      itens: [{ descricao: 'Perfume', produtoId: id, quantidade: 1, precoUnitario: 5000n, entregue: 1 }] })
    if (!venda.ok) throw new Error(venda.motivo)
    const movimentos = (await l.repositorioEstoque.lerEstado()).movimentos
    return { compraId: movimentos.find((m) => m.produtoId === id && m.tipo === 'compra')?.id,
      entregaId: venda.valor.movimentos[0]?.id }
  }, produtoId)
  await page.getByRole('button', { name: P.compra, exact: true }).click()
  await page.getByLabel(P.quantidade, { exact: true }).fill('2')
  await page.getByLabel(P.custo, { exact: true }).fill('4000')
  await page.getByLabel(P.data, { exact: true }).fill('2026-09-30')
  await salvar(page, 12)
  await expect(page.getByText('Custo de referência: R$ 33,35', { exact: true })).toBeVisible()
  await page.locator(`[data-movimento-id="${compra.compraId}"]`).getByRole('button', { name: P.corrigir }).click()
  await expect(page.getByLabel(P.custo, { exact: true })).toHaveValue('33,35')
  await page.getByLabel(P.quantidade, { exact: true }).fill('4')
  await page.getByLabel(P.custo, { exact: true }).fill('3500')
  await salvar(page, 13)
  expect(await page.evaluate(async (id) => {
    const movimento = (await window.laboratorio?.repositorioEstoque.lerEstado())?.movimentos.find((m) => m.id === id)
    return movimento?.tipo === 'entrega' ? String(movimento.custoUnitario) : 'sem entrega'
  }, compra.entregaId)).toBe('3335')
  await recarregar(page); await abrirEstoque(page, produtoId)
  await expect(page.locator('[data-estoque-fisico]')).toHaveText('13')
  await page.getByRole('button', { name: P.compra, exact: true }).click()
  await page.getByLabel(P.quantidade, { exact: true }).fill('1')
  await expect(page.getByLabel(P.custo, { exact: true })).toHaveValue('')
  await salvar(page, 14)
  expect((await retrato(page, produtoId)).custo).toBe('undefined')
  await page.getByRole('button', { name: P.compra, exact: true }).click()
  await page.getByLabel(P.quantidade, { exact: true }).fill('2')
  await page.getByLabel(P.custo, { exact: true }).fill('0')
  await expect(page.getByLabel(P.custo, { exact: true })).toHaveValue('0,00')
  await salvar(page, 16)
  expect((await retrato(page, produtoId)).custo).toBe('0')
  await page.screenshot({ path: info.outputPath('historico-375.png'), fullPage: true })
  await recarregar(page); await abrirEstoque(page, produtoId)
  await expect(page.locator('[data-estoque-fisico]')).toHaveText('16')
  expect(erros).toEqual([])
})

test('E-24 entrada enviada — correção compartilhada, reenvio idempotente e consulta offline em outro contexto', async ({ page, context, browser }) => {
  const outro = await browser.newContext(), b = await outro.newPage()
  try {
    await abrirApp(page); await entrar(page); await sincronizar(page)
    const { produtoId } = await preparar(page)
    await sincronizar(page); await context.setOffline(true)
    await abrirEstoque(page, produtoId)
    await page.getByRole('button', { name: P.compra, exact: true }).click()
    await page.getByLabel(P.quantidade, { exact: true }).fill('3')
    await page.getByLabel(P.custo, { exact: true }).fill('3335')
    await salvar(page, 3)
    await recarregar(page); await abrirEstoque(page, produtoId)
    const antes = await retrato(page, produtoId)
    await context.setOffline(false); await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    await abrirApp(b); await entrar(b); await sincronizar(b)
    expect(await retrato(b, produtoId)).toEqual(antes)
    const linha = page.locator('[data-movimento-id]').filter({ has: page.getByRole('button', { name: P.corrigir, exact: true }) })
    await linha.getByRole('button', { name: P.corrigir, exact: true }).click()
    await page.getByLabel(P.quantidade, { exact: true }).fill('2')
    await page.getByLabel(P.custo, { exact: true }).fill('4444')
    await salvar(page, 2)
    await expect(page.getByText(P.anulada, { exact: true })).toBeVisible()
    await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    const depois = await retrato(page, produtoId)
    expect(depois).toMatchObject({ fisico: 2, custo: '4444', quantidade: 3 })
    await page.evaluate(async (id) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      for (const op of await l.banco.operacoes.toArray()) if (op.movimentos.some((ref) => ref.id === id)) {
        await l.banco.fila.add({ tabela: 'operacoes', registroId: op.id, versao: op.revisao, criadoEm: new Date().toISOString() })
      }
    }, await page.locator('[data-movimento-id]').filter({ has: page.getByRole('button', { name: P.corrigir, exact: true }) }).getAttribute('data-movimento-id'))
    await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    expect(await retrato(page, produtoId)).toEqual(depois)
    await sincronizar(b); expect(await retrato(b, produtoId)).toEqual(depois)
    await outro.setOffline(true); await recarregar(b); await abrirEstoque(b, produtoId)
    await expect(b.locator('[data-estoque-fisico]')).toHaveText('2')
    await expect(b.getByText(P.anulada, { exact: true })).toBeVisible()
  } finally { await outro.close() }
})
