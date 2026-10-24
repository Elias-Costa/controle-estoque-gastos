import { expect, test, type Page } from '@playwright/test'
import { abrirApp, entrar, esperarIndicador, recarregar, sincronizar } from './apoio.ts'
import { PALAVRAS_DO_CAIXA as P } from '../../src/interface/palavras-do-caixa.ts'

async function abrirCaixa(page: Page, mes: string): Promise<void> {
  await page.getByRole('button', { name: P.titulo, exact: true }).click()
  await page.getByLabel(P.mes, { exact: true }).fill(mes)
  await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
}

async function anotar(page: Page, tipo: 'despesa' | 'receita-avulsa', categoria: string, valor: string, data: string, pessoal = false, mercadoria = false): Promise<string> {
  await page.getByRole('button', { name: tipo === 'despesa' ? P.despesa : P.receita, exact: true }).click()
  await page.getByLabel(P.valor, { exact: true }).fill(valor)
  await page.getByLabel(P.data, { exact: true }).fill(data)
  await page.getByLabel(P.categoria, { exact: true }).fill(categoria)
  await page.getByRole('radio', { name: pessoal ? P.pessoal : P.negocio, exact: true }).check()
  if (mercadoria) await page.getByRole('radio', { name: P.sim, exact: true }).check()
  await page.getByRole('button', { name: P.salvar, exact: true }).click()
  const linha = page.locator('[data-caixa-id]').filter({ has: page.getByText(categoria, { exact: true }) })
  await expect(linha).toBeVisible()
  const id = await linha.getAttribute('data-caixa-id')
  if (!id) throw new Error('anotação sem identidade')
  return id
}

async function corrigir(page: Page, id: string, valor: string): Promise<void> {
  const linha = page.locator(`[data-caixa-id="${id}"]`)
  await linha.locator('summary').click()
  await linha.getByRole('button', { name: P.corrigir, exact: true }).click()
  await page.getByLabel(P.valor, { exact: true }).fill(valor)
  await page.getByRole('button', { name: P.salvar, exact: true }).click()
  await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
}

async function desfazer(page: Page, id: string): Promise<void> {
  const linha = page.locator(`[data-caixa-id="${id}"]`)
  await linha.locator('summary').click()
  await linha.getByRole('button', { name: P.desfazer, exact: true }).click()
  await expect(linha).toBeVisible()
  await linha.getByRole('button', { name: P.confirmarDesfazer, exact: true }).click()
  await expect(linha).toHaveCount(0)
}

async function totais(page: Page, entrou: string, saiu: string, diferenca: string): Promise<void> {
  await expect(page.locator('[data-caixa-total="entrou"]')).toHaveText(entrou)
  await expect(page.locator('[data-caixa-total="saiu"]')).toHaveText(saiu)
  await expect(page.locator('[data-caixa-total="diferenca"]')).toHaveText(diferenca)
}

async function retratoFichasEstoque(page: Page) {
  return page.evaluate(async () => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const estado = await l.repositorioEstoque.lerEstado()
    return l.conteudoDoEfeito({ clientes: await l.repositorio.listarClientes(), lancamentos: estado.lancamentos, movimentos: estado.movimentos, produtos: estado.produtos })
  })
}

test('E-34 caixa offline: fontes, cortes, centavos, correção/estorno e mês negativo sobrevivem à reabertura sem mudar ficha/estoque', async ({ page, context }, info) => {
  const erros: string[] = []; page.on('pageerror', (e) => erros.push(e.message))
  await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page); await context.setOffline(true)
  await page.evaluate(async () => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const c = await l.cadastrarCliente({ nome: 'Ficha fictícia caixa' }); if (!c.ok) throw new Error(c.motivo)
    const categoria = await l.operacoesEstoque.cadastrarCategoria('Categoria fictícia'); if (!categoria.ok) throw new Error(categoria.motivo)
    const p = await l.operacoesEstoque.cadastrarProduto({ nome: 'Produto fictício caixa', categoriaId: categoria.valor.id }); if (!p.ok) throw new Error(p.motivo)
    const compra = await l.operacoesEstoque.registrarMovimento({ tipo: 'compra', produtoId: p.valor.id, data: '2026-09-10', quantidade: 20, custoUnitario: 335n })
    const venda = await l.operacoesEstoque.lancarVenda({ clienteId: c.valor.id, data: '2026-09-10', desconto: 0n, pagamento: 'fiado',
      itens: [{ produtoId: p.valor.id, descricao: 'Produto fictício', precoUnitario: 2500n, quantidade: 4, entregue: 2 }], parcelas: [{ valor: 10000n, vencimento: '2026-10-10' }] })
    const vista = await l.operacoesEstoque.lancarVenda({ clienteId: c.valor.id, data: '2026-09-11', desconto: 1n, pagamento: 'avista', forma: 'pix',
      itens: [{ produtoId: p.valor.id, descricao: 'Produto fictício', precoUnitario: 1001n, quantidade: 1, entregue: 1 }] })
    const recebimento = await l.receber({ clienteId: c.valor.id, data: '2026-09-12', valor: 500n, forma: 'dinheiro' })
    if (!compra.ok || !venda.ok || !vista.ok || !recebimento.ok) throw new Error('preparação recusada')
    const cliente = await l.repositorio.lerCliente(c.valor.id)
    if (!cliente) throw new Error('sem ficha')
    await l.repositorio.gravarCliente({ ...cliente, desativadoEm: '2026-10-01' })
  })
  const antes = await retratoFichasEstoque(page)
  await abrirCaixa(page, '2026-09')
  await totais(page, 'R$ 15,00', 'R$ 0,00', 'R$ 15,00')
  await expect(page.getByText(P.alcance, { exact: true })).toBeVisible()
  await expect(page.getByText(P.venda, { exact: true })).toBeVisible()
  await expect(page.getByText(P.recebimento, { exact: true })).toBeVisible()
  const compra = await anotar(page, 'despesa', 'Termo mercadoria livre', '10000', '2026-09-30', false, true)
  await totais(page, 'R$ 15,00', 'R$ 100,00', '-R$ 85,00')
  const pessoal = await anotar(page, 'despesa', 'Categoria pessoal çã', '2000', '2026-09-30', true)
  const receita = await anotar(page, 'receita-avulsa', 'Entrada pessoal teste', '2535', '2026-09-30', true)
  await totais(page, 'R$ 40,35', 'R$ 120,00', '-R$ 79,65')
  await page.getByRole('radio', { name: P.pessoal, exact: true }).check()
  await totais(page, 'R$ 25,35', 'R$ 20,00', 'R$ 5,35')
  await page.getByRole('radio', { name: P.negocio, exact: true }).check()
  await totais(page, 'R$ 15,00', 'R$ 100,00', '-R$ 85,00')
  await corrigir(page, compra, '8000')
  await totais(page, 'R$ 40,35', 'R$ 100,00', '-R$ 59,65')
  expect(await page.evaluate(async (id) => (await window.laboratorio?.repositorioCaixa.listarFatos())?.find((f) => f.id === id)?.revisao, compra)).toBe(2)
  await desfazer(page, pessoal)
  await totais(page, 'R$ 40,35', 'R$ 80,00', '-R$ 39,65')
  await page.getByText(P.historico, { exact: true }).click()
  await expect(page.getByText(P.anterior, { exact: true })).toBeVisible()
  await expect(page.getByText(/Gasto · Categoria pessoal çã/)).toBeVisible()
  await page.screenshot({ path: info.outputPath('caixa-historico-375.png'), fullPage: true })
  await page.getByLabel(P.mes, { exact: true }).fill('2026-10')
  await totais(page, 'R$ 0,00', 'R$ 0,00', 'R$ 0,00')
  await expect(page.getByText(P.vazio, { exact: true })).toBeVisible()
  await recarregar(page); await abrirCaixa(page, '2026-09')
  await totais(page, 'R$ 40,35', 'R$ 80,00', '-R$ 39,65')
  await expect(page.locator(`[data-caixa-id="${receita}"]`)).toBeVisible()
  expect(await retratoFichasEstoque(page)).toBe(antes)
  expect(erros).toEqual([])
})

test('E-34 correção enviada e movimento real em outro mês aparecem na tela aberta do outro contexto, reenvio e restauração', async ({ page, context, browser }) => {
  const outro = await browser.newContext(), b = await outro.newPage()
  const categoria = `Caixa compartilhado ${crypto.randomUUID()}`
  try {
    await abrirApp(page); await entrar(page); await sincronizar(page)
    await abrirCaixa(page, '2011-03')
    const id = await anotar(page, 'despesa', categoria, '10000', '2011-03-31')
    await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    await abrirApp(b); await entrar(b); await sincronizar(b); await abrirCaixa(b, '2011-03')
    await totais(b, 'R$ 0,00', 'R$ 100,00', '-R$ 100,00')
    await context.setOffline(true); await corrigir(page, id, '8000')
    await totais(page, 'R$ 0,00', 'R$ 80,00', '-R$ 80,00')
    await anotar(page, 'receita-avulsa', 'Dinheiro devolvido teste', '2000', '2011-04-01')
    await totais(page, 'R$ 20,00', 'R$ 0,00', 'R$ 20,00')
    await context.setOffline(false); await sincronizar(page); await sincronizar(b)
    await totais(b, 'R$ 0,00', 'R$ 80,00', '-R$ 80,00')
    await b.getByLabel(P.mes, { exact: true }).fill('2011-04')
    await totais(b, 'R$ 20,00', 'R$ 0,00', 'R$ 20,00')
    const antes = await page.evaluate(async () => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      return l.conteudoDoEfeito(await l.repositorioCaixa.listarFatos())
    })
    await page.evaluate(async () => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      for (const op of await l.banco.operacoesCaixa.toArray()) await l.banco.fila.add({ tabela: 'operacoesCaixa', registroId: op.id, versao: op.revisao, criadoEm: new Date().toISOString() })
    })
    await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    await b.evaluate(async () => { const l = window.laboratorio; if (!l) throw new Error('sem laboratório'); await l.banco.delete() })
    await recarregar(b); await sincronizar(b)
    expect(await b.evaluate(async () => { const l = window.laboratorio; if (!l) throw new Error('sem laboratório'); return l.conteudoDoEfeito(await l.repositorioCaixa.listarFatos()) })).toBe(antes)
    await outro.setOffline(true); await recarregar(b); await abrirCaixa(b, '2011-03')
    await totais(b, 'R$ 0,00', 'R$ 80,00', '-R$ 80,00')
    await b.getByText(P.historico, { exact: true }).click()
    await expect(b.getByText(/Gasto · Caixa compartilhado .* · R\$ 100,00/)).toBeVisible()
    await expect(b.getByText(P.correcao, { exact: true })).toBeVisible()
  } finally { await outro.close() }
})

test('E-34 D-070: correção recusada e dependente ficam para conferência, total aceito e evidências sobrevivem offline', async ({ page, context, browser }, info) => {
  const outro = await browser.newContext(), b = await outro.newPage(), categoria = `Disputa caixa ${crypto.randomUUID()}`
  try {
    await abrirApp(page); await entrar(page); await sincronizar(page); await abrirCaixa(page, '2012-03')
    const id = await anotar(page, 'despesa', categoria, '10000', '2012-03-31')
    await sincronizar(page); await abrirApp(b); await entrar(b); await sincronizar(b); await abrirCaixa(b, '2012-03')
    await context.setOffline(true); await outro.setOffline(true)
    await corrigir(page, id, '8000'); await corrigir(b, id, '6000')
    const tentativa = await b.locator('[data-caixa-id]').filter({ has: b.getByText(categoria, { exact: true }) }).getAttribute('data-caixa-id')
    if (!tentativa) throw new Error('sem substituto')
    await desfazer(b, tentativa)
    await totais(b, 'R$ 0,00', 'R$ 0,00', 'R$ 0,00')
    await context.setOffline(false); await sincronizar(page)
    await outro.setOffline(false); await sincronizar(b)
    await totais(b, 'R$ 0,00', 'R$ 80,00', '-R$ 80,00')
    const conferencia = b.getByRole('region', { name: P.conferir, exact: true })
    await expect(conferencia.getByText(P.recusada, { exact: true }).first()).toBeVisible()
    await expect(conferencia.getByText(P.dependente, { exact: true })).toBeVisible()
    await expect(conferencia.getByText(P.fora, { exact: true })).toHaveCount(2)
    await expect(conferencia.getByText(/R\$ 60,00/).first()).toBeVisible()
    await b.screenshot({ path: info.outputPath('caixa-conferencia.png'), fullPage: true })
    const retrato = async () => b.evaluate(async () => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      return l.conteudoDoEfeito({ fatos: await l.repositorioCaixa.listarFatos(), versoes: await l.banco.versoesCaixa.toArray(), fila: await l.banco.fila.toArray() })
    })
    const antes = await retrato()
    await outro.setOffline(true); await recarregar(b); await abrirCaixa(b, '2012-03')
    await totais(b, 'R$ 0,00', 'R$ 80,00', '-R$ 80,00')
    await expect(b.locator('[data-caixa-conferencia]')).toHaveCount(2)
    expect(await retrato()).toBe(antes)
  } finally { await outro.close() }
})
