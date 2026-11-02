import { expect, test, type Page } from '@playwright/test'

async function preparar(page: Page) {
  await page.clock.setFixedTime('2026-11-01T12:00:00Z')
  await page.goto('/')
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await page.evaluate(() => new Promise<void>((resolver, rejeitar) => {
    const abertura = indexedDB.open('controle-fiado')
    abertura.onerror = () => rejeitar(abertura.error)
    abertura.onsuccess = () => {
      const db = abertura.result, tx = db.transaction(['clientes', 'lancamentos', 'categorias', 'produtos'], 'readwrite')
      const cliente = '00000000-0000-7000-8000-000000000381', categoria = '00000000-0000-7000-8000-000000000382'
      tx.objectStore('clientes').put({ id: cliente, nome: 'Cliente fictícia com parcela hoje', atualizadoEm: '2026-10-31T12:00:00Z' })
      tx.objectStore('lancamentos').put({ id: '00000000-0000-7000-8000-000000000383', clienteId: cliente, tipo: 'venda', pagamento: 'fiado',
        data: '2026-10-31', desconto: 0n, itens: [{ descricao: 'Fictício', preco: 10001n }],
        parcelas: [{ id: '00000000-0000-7000-8000-000000000384', vencimento: '2026-11-01', valor: 10001n }] })
      tx.objectStore('categorias').put({ id: categoria, nome: 'Fictícia' })
      tx.objectStore('produtos').put({ id: '00000000-0000-7000-8000-000000000385', nome: 'Fictício no mínimo', categoriaId: categoria,
        estoqueMinimo: 0, atualizadoEm: '2026-10-31T12:00:00Z' })
      tx.oncomplete = () => { db.close(); resolver() }; tx.onerror = () => rejeitar(tx.error)
    }
  }))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Lembretes', exact: true })).toBeVisible()
}
for (const c of [{ largura: 375, ampliado: false }, { largura: 320, ampliado: true }]) {
  test(`E-38 ${c.largura}/${c.ampliado}: reserva offline, ficha de hoje, mínimo e mês certo`, async ({ page, context }, info) => {
    await page.setViewportSize({ width: c.largura, height: 812 })
    const erros: string[] = []; page.on('pageerror', (e) => erros.push(e.message))
    await preparar(page)
    await context.setOffline(true)
    await page.reload()
    if (c.ampliado) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
    await expect(page.getByRole('heading', { name: 'Lembretes', exact: true })).toBeVisible()
    await page.locator('#lembretes summary').click()
    const ficha = page.getByRole('button', { name: 'Conferir a fichinha de Cliente fictícia com parcela hoje ›', exact: true })
    await expect(ficha).toBeVisible(); await ficha.focus(); await expect(ficha).toBeFocused()
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
    expect(await ficha.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none')
    const medidas = await page.locator('#lembretes').evaluate((bloco) => ({
      largura: document.documentElement.clientWidth, conteudo: document.documentElement.scrollWidth,
      pequenos: [...bloco.querySelectorAll('button,summary')].filter((e) => {
        const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44)
      }).length,
    }))
    expect(medidas.conteudo).toBeLessThanOrEqual(medidas.largura); expect(medidas.pequenos).toBe(0)
    await page.screenshot({ path: info.outputPath('lembretes.png'), fullPage: true })
    await ficha.click(); await expect(page.getByRole('heading', { name: 'Cliente fictícia com parcela hoje', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    await page.getByRole('button', { name: 'Conferir produtos no mínimo ›', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'No mínimo', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    await page.getByRole('button', { name: 'Conferir o caixa do mês anterior ›', exact: true }).click()
    await expect(page.locator('input[type="month"]')).toHaveValue('2026-10')
    expect(erros).toEqual([])
  })
}
test('E-38 mensagem do SW preserva o formulário em andamento e só mostra aviso genérico', async ({ page, context }) => {
  await preparar(page)
  await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
  await page.getByLabel('Nome', { exact: true }).fill('Rascunho preservado')
  const worker = context.serviceWorkers()[0]
  if (!worker) throw new Error('Worker ausente no build')
  // Mensagem real do SW controlando a página; não é transporte Web Push ou toque de aparelho.
  await worker.evaluate("self.clients.matchAll({type:'window'}).then(cs => cs.forEach(c => c.postMessage({tipo:'ABRIR_LEMBRETES'})))")
  await expect(page.getByText('Há lembretes para conferir no começo.', { exact: false })).toBeVisible()
  await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Rascunho preservado')
  await page.getByRole('button', { name: 'Fechar aviso', exact: true }).click()
  await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Rascunho preservado')
})

test('E-38 primeira abertura aceita só o SW ativo sem recarga ou perda do formulário', async ({ page, context }) => {
  await page.goto('/')
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  expect(await page.evaluate(() => navigator.serviceWorker.controller === null)).toBe(true)
  await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
  await page.getByLabel('Nome', { exact: true }).fill('Rascunho da primeira abertura')
  // Fonte diferente do worker ativo não deve sinalizar um toque legítimo.
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {
    data: { tipo: 'ABRIR_LEMBRETES' }, source: window,
  })))
  await expect(page.getByText('Há lembretes para conferir no começo.', { exact: false })).toHaveCount(0)
  const worker = context.serviceWorkers()[0]
  if (!worker) throw new Error('Worker ausente na primeira abertura')
  await worker.evaluate("self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs => cs.forEach(c => c.postMessage({tipo:'ABRIR_LEMBRETES'})))")
  await expect(page.getByText('Há lembretes para conferir no começo.', { exact: false })).toBeVisible()
  await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Rascunho da primeira abertura')
  expect(await page.evaluate(() => navigator.serviceWorker.controller === null)).toBe(true)
})
