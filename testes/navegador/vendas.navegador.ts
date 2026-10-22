import { expect, test, type Page } from '@playwright/test'
import { abrirApp, apagarBase, entrar, esperarIndicador, recarregar, sincronizar } from './apoio.ts'

async function preparar(page: Page, quantidade = 1) {
  return page.evaluate(async (q) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const nome = `Cliente E-25 ${crypto.randomUUID()}`
    const cliente = await l.cadastrarCliente({ nome }); if (!cliente.ok) throw new Error(cliente.motivo)
    const categoria = await l.operacoesEstoque.cadastrarCategoria(`E-25 ${crypto.randomUUID()}`); if (!categoria.ok) throw new Error(categoria.motivo)
    const produtos: { id: string; nome: string }[] = []
    for (const [nome, precoVenda] of [['Perfume E-25', 10000n], ['Creme E-25', 5000n], ['Novo E-25', 12000n]] as const) {
      const p = await l.operacoesEstoque.cadastrarProduto({ nome, categoriaId: categoria.valor.id, precoVenda, custoManual: 2500n })
      if (!p.ok) throw new Error(p.motivo)
      const e = await l.operacoesEstoque.registrarMovimento({ tipo: 'compra', produtoId: p.valor.id, quantidade: q, custoUnitario: 3000n, data: '2026-10-19' })
      if (!e.ok) throw new Error(e.motivo)
      produtos.push({ id: p.valor.id, nome })
    }
    return { clienteId: cliente.valor.id, nome, produtos }
  }, quantidade)
}
async function abrirFicha(page: Page, nome: string) { await page.getByRole('button', { name: new RegExp(nome) }).click() }
async function escolher(page: Page, posicao: number, id: string) {
  await page.locator(`[data-item-venda="${posicao}"]`).getByRole('button', { name: 'Escolher produto', exact: true }).click()
  await page.locator(`[data-escolher-produto="${id}"]`).click()
}
async function abrirVenda(page: Page) {
  await page.locator('li > button').filter({ hasText: 'Perfume E-25' }).first().click()
  await expect(page.getByRole('heading', { name: 'Entregas e devoluções' })).toBeVisible()
}
async function retrato(page: Page, clienteId: string) {
  return page.evaluate(async (id) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const e = await l.repositorioEstoque.lerEstado()
    const ficha = e.lancamentos.filter((l) => l.clienteId === id).sort((a, b) => a.id.localeCompare(b.id))
    return { saldo: String(l.saldo(ficha)), ficha: l.conteudoDoEfeito(ficha), movimentos: l.conteudoDoEfeito([...e.movimentos].sort((a, b) => a.id.localeCompare(b.id) || a.revisao - b.revisao)) }
  }, clienteId)
}

test('E-25 tela offline — venda mista, quantidade/preço, parcelas, correção, entrega acima do físico e retorno real', async ({ page, context }, info) => {
  const erros: string[] = []; page.on('pageerror', (e) => erros.push(e.message))
  await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page); await context.setOffline(true)
  const a = await preparar(page), perfume = a.produtos[0]
  if (!perfume) throw new Error('sem perfume')
  await recarregar(page); await abrirFicha(page, a.nome)
  await page.getByRole('button', { name: 'Vender fiado', exact: true }).click()
  await escolher(page, 0, perfume.id)
  await page.getByLabel('Quantidade 1', { exact: true }).fill('3')
  await page.getByLabel('Preço unitário 1', { exact: true }).fill('3335')
  await expect(page.getByLabel('Entregue agora 1', { exact: true })).toHaveValue('1')
  await expect(page.getByText('Disponível: 1 · A entregar: 2', { exact: true })).toBeVisible()
  await page.getByLabel('Item 2', { exact: true }).fill('Avulso E-25')
  await page.getByLabel('Preço unitário 2', { exact: true }).fill('1000')
  await page.getByRole('button', { name: 'Dar desconto', exact: true }).click()
  await page.getByLabel('Desconto', { exact: true }).fill('505')
  await page.getByRole('button', { name: '3×', exact: true }).click()
  expect(await page.evaluate(() => ({ largura: innerWidth, conteudo: document.documentElement.scrollWidth,
    pequenos: [...document.querySelectorAll('button, input, select')].filter((e) => {
      const alvo = e.matches('input[type="radio"]') ? e.closest('label') ?? e : e
      const r = alvo.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44)
    }).length }))).toEqual({ largura: 375, conteudo: 375, pequenos: 0 })
  await page.screenshot({ path: info.outputPath('venda-mista-375.png'), fullPage: true })
  await page.getByRole('button', { name: 'Pronto', exact: true }).click()
  await page.getByRole('button', { name: 'Ver a fichinha', exact: true }).click()
  expect((await retrato(page, a.clienteId)).saldo).toBe('10500')
  await abrirVenda(page)
  await expect(page.getByText('Entregue: 1 · Voltou: 0 · A entregar: 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Corrigir anotação', exact: true }).click()
  await expect(page.getByLabel('Preço unitário 1', { exact: true })).toHaveValue('33,35')
  await page.getByLabel('Preço unitário 1', { exact: true }).fill('2000')
  await page.getByRole('button', { name: 'Pronto', exact: true }).click()
  expect((await retrato(page, a.clienteId)).saldo).toBe('6495')
  await recarregar(page)
  await page.getByRole('button', { name: /^Produtos/ }).click()
  await page.locator(`[data-produto-id="${perfume.id}"]`).click()
  await page.getByRole('button', { name: 'Ver estoque ›', exact: true }).click()
  await expect(page.locator('[data-estoque-fisico]')).toHaveText('0')
  await expect(page.locator('[data-estoque-prometido]')).toHaveText('2')
  await page.getByRole('button', { name: `Ver venda de ${a.nome}`, exact: true }).click()
  await page.getByRole('button', { name: 'Entregar Perfume E-25', exact: true }).click()
  await expect(page.getByLabel('Entregue agora', { exact: true })).toHaveValue('0')
  await page.getByLabel('Entregue agora', { exact: true }).fill('3')
  await expect(page.getByRole('button', { name: 'Confirmar entrega', exact: true })).toBeDisabled()
  await page.getByLabel('Entregue agora', { exact: true }).fill('2')
  await expect(page.getByText(/Essa entrega deixa o estoque registrado negativo/)).toBeVisible()
  await page.getByRole('button', { name: 'Confirmar entrega', exact: true }).click()
  await expect(page.locator('[data-estoque-fisico]')).toHaveText('-2')
  await expect(page.locator('[data-estoque-prometido]')).toHaveText('0')
  await recarregar(page); await abrirFicha(page, a.nome)
  await abrirVenda(page)
  await expect(page.getByText('Entregue: 3 · Voltou: 0 · A entregar: 0', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Desfazer esta venda', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Confirmar cancelamento', exact: true })).toBeDisabled()
  await page.getByLabel('Voltou Perfume E-25', { exact: true }).fill('0')
  await page.getByRole('button', { name: 'Confirmar cancelamento', exact: true }).click()
  expect((await retrato(page, a.clienteId)).saldo).toBe('0')
  await page.getByRole('button', { name: /Ver o que foi desfeito/ }).click()
  await abrirVenda(page)
  await page.getByRole('button', { name: 'Voltou mercadoria depois', exact: true }).click()
  await page.getByLabel('Voltou Perfume E-25', { exact: true }).fill('1')
  await page.getByRole('button', { name: 'Confirmar retorno', exact: true }).click()
  const antes = await retrato(page, a.clienteId)
  await recarregar(page); await abrirFicha(page, a.nome)
  expect(await retrato(page, a.clienteId)).toEqual(antes)
  expect(await page.evaluate(async (id) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const e = await l.repositorioEstoque.lerEstado(), p = l.projetarEstoque(e.movimentos, id)
    return p.ok ? p.valor.fisico : null
  }, perfume.id)).toBe(-1)
  expect(erros).toEqual([])
})

test('E-25 troca parcial pela tela — só itens devolvidos voltam; envio, dois contextos e restauração offline', async ({ page, context, browser }, info) => {
  const outro = await browser.newContext(), b = await outro.newPage()
  try {
    await abrirApp(page); await entrar(page); await sincronizar(page)
    const a = await preparar(page, 3)
    await sincronizar(page); await recarregar(page); await abrirFicha(page, a.nome)
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Vender fiado', exact: true }).click()
    for (const i of [0, 1]) { const p = a.produtos[i]; if (!p) throw new Error('sem produto'); await escolher(page, i, p.id) }
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await page.getByRole('button', { name: 'Ver a fichinha', exact: true }).click()
    await context.setOffline(false); expect(await sincronizar(page)).toMatchObject({ pendentes: 0, comProblema: 0 })
    await abrirVenda(page)
    await page.getByRole('button', { name: 'Corrigir anotação', exact: true }).click()
    await page.getByLabel('Preço unitário 1', { exact: true }).fill('9000')
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    expect(await sincronizar(page)).toMatchObject({ pendentes: 0, comProblema: 0 })
    expect((await retrato(page, a.clienteId)).saldo).toBe('14000')
    await abrirVenda(page)
    await page.getByRole('button', { name: 'Devolução ou troca', exact: true }).click()
    await page.getByLabel('Voltou Perfume E-25', { exact: true }).fill('1')
    await page.getByRole('button', { name: '+ Mais um', exact: true }).click()
    if (!a.produtos[2]) throw new Error('sem novo produto')
    await escolher(page, 0, a.produtos[2].id)
    await expect(page.getByText('Total que fica na venda: R$ 170,00', { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('troca-parcial.png'), fullPage: true })
    await page.getByRole('button', { name: 'Confirmar devolução ou troca', exact: true }).click()
    expect(await sincronizar(page)).toMatchObject({ pendentes: 0, comProblema: 0 })
    expect((await retrato(page, a.clienteId)).saldo).toBe('17000')
    const antes = await retrato(page, a.clienteId)
    await abrirApp(b); await entrar(b); await sincronizar(b)
    expect(await retrato(b, a.clienteId)).toEqual(antes)
    await apagarBase(page); await recarregar(page); await sincronizar(page)
    expect(await retrato(page, a.clienteId)).toEqual(antes)
    await context.setOffline(true); await recarregar(page); await abrirFicha(page, a.nome)
    expect(await retrato(page, a.clienteId)).toEqual(antes)
    const ativos = await page.evaluate(async (id) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const e = await l.repositorioEstoque.lerEstado()
      return e.lancamentos.filter((v) => v.clienteId === id && v.tipo === 'venda' && !e.lancamentos.some((s) => s.tipo === 'estorno' && s.estornaId === v.id)).length
    }, a.clienteId)
    expect(ativos).toBe(1)
    await page.getByRole('button', { name: 'Mudar dados', exact: true }).click()
    await page.getByRole('button', { name: 'Desativar a fichinha', exact: true }).click()
    await page.getByRole('button', { name: 'Sim, desativar', exact: true }).click()
    await page.getByRole('button', { name: /Ver as fichinhas desativadas/ }).click()
    await abrirFicha(page, a.nome)
    await expect(page.getByText('Fichinha desativada', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Vender fiado', exact: true })).toHaveCount(0)
    await expect(page.locator('li > button')).toHaveCount(0)
  } finally { await outro.close() }
})

test('E-25 Q47 pela tela — outro aparelho já cancelou; só retorno real é reconfirmado offline, evidência restaurável', async ({ page, context, browser }) => {
  const outro = await browser.newContext(), b = await outro.newPage()
  try {
    await abrirApp(page); await entrar(page); await sincronizar(page)
    const a = await preparar(page, 3), perfume = a.produtos[0]
    if (!perfume) throw new Error('sem perfume')
    const alvo = await page.evaluate(async ({ clienteId, produtoId }) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const g = await l.operacoesEstoque.lancarVenda({ clienteId, data: '2026-10-19', desconto: 0n, pagamento: 'fiado',
        itens: [{ descricao: 'Perfume E-25', produtoId, quantidade: 3, precoUnitario: 5000n, entregue: 1 }], parcelas: [{ vencimento: '2026-11-19', valor: 15000n }] })
      if (!g.ok) throw new Error(g.motivo)
      const v = g.valor.lancamentos[0]; if (v?.tipo !== 'venda' || !v.itens[0]?.id) throw new Error('sem venda')
      return { vendaId: v.id, itemId: v.itens[0].id }
    }, { clienteId: a.clienteId, produtoId: perfume.id })
    await sincronizar(page)
    await page.evaluate(async ({ vendaId, clienteId }) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const id = crypto.randomUUID()
      await l.banco.transaction('rw', l.banco.lancamentos, l.banco.fila, async () => {
        await l.banco.lancamentos.put({ id, clienteId, data: '2026-10-19', tipo: 'estorno', estornaId: vendaId })
        await l.banco.fila.add({ tabela: 'lancamentos', registroId: id, criadoEm: new Date().toISOString() })
      })
    }, { vendaId: alvo.vendaId, clienteId: a.clienteId })
    await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 1 })
    await abrirApp(b); await entrar(b); await sincronizar(b)
    await b.evaluate(async ({ vendaId, itemId }) => {
      const r = await window.laboratorio?.operacoesEstoque.cancelarVenda(vendaId, '2026-10-19', [{ itemId, quantidade: 0 }])
      if (!r?.ok) throw new Error('cancelamento não gravou')
    }, alvo)
    await sincronizar(b); await sincronizar(page); await recarregar(page)
    await page.getByRole('button', { name: 'Conferir anotações (1)', exact: true }).click()
    await page.getByRole('button', { name: /^Conferir anotação de venda/ }).click()
    await expect(page.getByText(/A venda já foi desfeita/)).toBeVisible()
    await page.getByLabel('Ainda preciso anotar o que aconteceu', { exact: true }).check()
    await page.getByLabel('Voltou de verdade: Perfume E-25', { exact: true }).fill('1')
    await page.getByLabel('Conferi os valores e o que aconteceu', { exact: true }).check()
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Confirmar conferência', exact: true }).click()
    await expect(page.getByText('Nenhuma anotação para conferir.', { exact: true })).toBeVisible()
    const resolucao = await page.evaluate(async (vendaId) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const e = (await l.banco.encerramentos.toArray()).find((e) => e.evidencia.grupo.lancamentos.some((l) => l.tipo === 'estorno' && l.estornaId === vendaId))
      return { id: e?.id, diagnostico: !!e?.evidencia.diagnostico, novos: e?.novaOperacao?.lancamentos.length }
    }, alvo.vendaId)
    expect(resolucao.diagnostico).toBe(true); expect(resolucao.novos).toBe(0)
    await recarregar(page)
    expect((await retrato(page, a.clienteId)).saldo).toBe('0')
    await context.setOffline(false); await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    const final = await retrato(page, a.clienteId)
    await apagarBase(page); await recarregar(page); await sincronizar(page)
    expect(await retrato(page, a.clienteId)).toEqual(final)
    expect(await page.evaluate(async (id) => !!(id && await window.laboratorio?.banco.encerramentos.get(id)), resolucao.id)).toBe(true)
  } finally { await outro.close() }
})
