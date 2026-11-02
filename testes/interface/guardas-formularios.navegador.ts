import { expect, test, type Locator, type Page } from '@playwright/test'

const cenarios = [
  { nome: '320 claro', largura: 320, altura: 812, tema: 'light', ampliado: false },
  { nome: '375 escuro', largura: 375, altura: 812, tema: 'dark', ampliado: false },
  { nome: '1280 claro', largura: 1280, altura: 812, tema: 'light', ampliado: false },
  { nome: '320 ampliado', largura: 320, altura: 812, tema: 'light', ampliado: true },
  { nome: '375 escuro ampliado', largura: 375, altura: 812, tema: 'dark', ampliado: true },
  { nome: '320 baixo escuro ampliado', largura: 320, altura: 480, tema: 'dark', ampliado: true },
] as const

for (const c of cenarios) {
  test(`UX-02 ${c.nome}: localizar pendências, corrigir e gravar offline`, async ({ page, context }, info) => {
    const erros: string[] = []
    page.on('pageerror', e => erros.push(e.message))
    await page.setViewportSize({ width: c.largura, height: c.altura })
    await page.emulateMedia({ colorScheme: c.tema })
    await abrirBuild(page)
    if (c.ampliado) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
    await context.setOffline(true)

    await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
    const nome = page.getByLabel('Nome', { exact: true })
    await expect(nome).toHaveAccessibleDescription('Só o nome é obrigatório.')
    await expect(nome).toHaveAttribute('required', '')
    await expect(nome).not.toHaveAttribute('aria-invalid', 'true')
    await conferirAvisoNoRodape(page, 'Falta o nome')
    await page.screenshot({ path: info.outputPath('cadastro.png') })
    await nome.fill('Cliente UX-02')
    await page.getByLabel('Telefone', { exact: true }).fill('85999999999')
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await page.getByRole('button', { name: 'Vender fiado', exact: true }).click()

    const item = page.getByLabel('Item 1', { exact: true })
    const preco = page.getByLabel('Preço unitário 1', { exact: true })
    await preco.fill('5000')
    await expect(item).toHaveAttribute('aria-invalid', 'true')
    await expect(item).toHaveAccessibleDescription('Informe o que foi vendido em cada item')
    await expect(page.getByLabel('Item 2', { exact: true })).not.toHaveAttribute('aria-invalid', 'true')
    await conferirAvisoNoRodape(page, 'Informe o que foi vendido em cada item')
    await preco.focus()
    await preco.press('0')
    await expect(preco).toBeFocused()
    await preco.fill('5000')
    await page.screenshot({ path: info.outputPath('item-incompleto.png') })
    await item.fill('Batom de teste')
    await expect(item).not.toHaveAttribute('aria-invalid', 'true')
    await page.getByLabel('Item 2', { exact: true }).fill('Creme de teste')
    await expect(page.getByLabel('Preço unitário 2', { exact: true })).toHaveAccessibleDescription('Falta o preço de um item')
    await expect(page.getByLabel('Preço unitário 2', { exact: true })).toHaveAttribute('aria-invalid', 'true')
    await conferirAvisoNoRodape(page, 'Falta o preço de um item')
    await page.getByLabel('Preço unitário 2', { exact: true }).fill('3000')

    await page.getByRole('button', { name: '2×', exact: true }).click()
    await page.getByRole('button', { name: 'Mudar datas ou valores', exact: true }).click()
    await page.getByLabel('1ª valor', { exact: true }).fill('4000')
    await page.getByLabel('2ª valor', { exact: true }).fill('3900')
    const divergencia = 'As parcelas somam R$ 79,00; a venda é R$ 80,00'
    await expect(page.getByLabel('2ª valor', { exact: true })).toHaveAccessibleDescription(divergencia)
    await conferirAvisoNoRodape(page, 'Confira as parcelas.')
    await page.evaluate(() => {
      document.documentElement.dataset.mudancasDoAviso = '0'
      const aviso = document.querySelector('.rodape-acao [role="status"]')!
      new MutationObserver(() => {
        document.documentElement.dataset.mudancasDoAviso = String(Number(document.documentElement.dataset.mudancasDoAviso) + 1)
      }).observe(aviso, { childList: true, subtree: true, characterData: true })
    })
    await page.getByLabel('2ª valor', { exact: true }).press('0')
    await expect(page.getByLabel('2ª valor', { exact: true })).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.dataset.mudancasDoAviso)).toBe('0')
    await page.getByLabel('2ª valor', { exact: true }).fill('3900')
    await page.getByLabel('2ª valor', { exact: true }).focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByLabel('2ª valor', { exact: true })).toBeFocused()
    const foco = await page.getByLabel('2ª valor', { exact: true }).boundingBox()
    const rodape = await page.locator('.rodape-acao').boundingBox()
    expect(foco!.y).toBeGreaterThanOrEqual(0)
    expect(foco!.y + foco!.height).toBeLessThanOrEqual(rodape!.y)
    await conferirLargura(page)
    await page.screenshot({ path: info.outputPath('parcelas.png') })
    await page.getByLabel('2ª valor', { exact: true }).fill('4000')
    await expect(page.getByRole('button', { name: 'Pronto', exact: true })).toBeEnabled()
    await expect(item).toHaveValue('Batom de teste')
    await expect(preco).toHaveValue('50,00')
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await page.getByRole('button', { name: 'Ver a fichinha', exact: true }).click()
    await page.getByRole('button', { name: 'Abater valor', exact: true }).click()
    await page.getByLabel('Quanto pagou', { exact: true }).fill('2500')
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click()
    await expect(page.getByText('Ainda deve R$ 55,00', { exact: true })).toBeVisible()
    const antes = await retrato(page)
    await page.reload()
    await page.getByRole('button', { name: /^Cliente UX-02/ }).click()
    await expect(page.getByText('R$ 55,00', { exact: true })).toBeVisible()
    expect(await retrato(page)).toEqual(antes)
    expect(erros).toEqual([])
  })
}

test('UX-02 saldo anterior: parcelas associadas no cadastro e na tela própria', async ({ page, context }, info) => {
  await page.setViewportSize({ width: 320, height: 812 })
  await abrirBuild(page)
  await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
  await context.setOffline(true)
  await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
  await page.getByLabel('Nome', { exact: true }).fill('Saldo UX-02')
  for (const etapa of ['cadastro', 'saldo anterior']) {
    await page.getByLabel(etapa === 'cadastro' ? 'Já me deve' : 'Quanto', { exact: true }).fill('8000')
    await page.getByRole('button', { name: '2×', exact: true }).click()
    await page.getByRole('button', { name: 'Mudar datas ou valores', exact: true }).click()
    await page.getByLabel('1ª valor', { exact: true }).fill('4000')
    await page.getByLabel('2ª valor', { exact: true }).fill('3900')
    await expect(page.getByLabel('2ª valor', { exact: true })).toHaveAccessibleDescription('As parcelas somam R$ 79,00; o saldo é R$ 80,00')
    await conferirAvisoNoRodape(page, 'Confira as parcelas.')
    await page.screenshot({ path: info.outputPath(`${etapa}-parcelas.png`) })
    await page.getByLabel('2ª valor', { exact: true }).fill('4000')
    if (etapa === 'cadastro') await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Saldo UX-02')
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Saldo UX-02', exact: true })).toBeVisible()
    if (etapa === 'cadastro') await page.getByRole('button', { name: 'Anotar o que já devia', exact: true }).click()
  }
  await expect(page.getByText('R$ 160,00', { exact: true })).toBeVisible()
  const antes = await retrato(page)
  await page.reload()
  expect(await retrato(page)).toEqual(antes)
})

for (const fluxo of ['cadastro', 'venda', 'recebimento', 'saldo anterior'] as const) {
  test(`UX-02 falha local real: ${fluxo} mantém campos e permite tentar de novo`, async ({ page, context }, info) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await abrirBuild(page)
    await context.setOffline(true)
    await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Falha UX-02')
    let campo: Locator = page.getByLabel('Nome', { exact: true })
    let valor = 'Falha UX-02'
    if (fluxo !== 'cadastro') {
      await page.getByRole('button', { name: 'Pronto', exact: true }).click()
      if (fluxo === 'saldo anterior') {
        await page.getByRole('button', { name: 'Anotar o que já devia', exact: true }).click()
        campo = page.getByLabel('Quanto', { exact: true })
        await campo.fill('5000')
        valor = '50,00'
      } else {
        await page.getByRole('button', { name: 'Vender fiado', exact: true }).click()
        await page.getByLabel('Item 1', { exact: true }).fill('Batom da falha')
        await page.getByLabel('Preço unitário 1', { exact: true }).fill('5000')
        campo = page.getByLabel('Item 1', { exact: true })
        valor = 'Batom da falha'
        if (fluxo === 'recebimento') {
          await page.getByRole('button', { name: 'Pronto', exact: true }).click()
          await page.getByRole('button', { name: 'Ver a fichinha', exact: true }).click()
          await page.getByRole('button', { name: 'Abater valor', exact: true }).click()
          campo = page.getByLabel('Quanto pagou', { exact: true })
          await campo.fill('2000')
          valor = '20,00'
        }
      }
    }
    const antes = await retrato(page)
    // Aborta uma transação nativa de verdade; não substitui o banco nem fabrica resposta.
    await page.evaluate((tabela) => {
      const original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        const pedido = original.apply(this, args)
        if (this.name === tabela) {
          IDBObjectStore.prototype.put = original
          this.transaction.abort()
        }
        return pedido
      }
    }, fluxo === 'cadastro' ? 'clientes' : 'lancamentos')
    const salvar = page.getByRole('button', { name: fluxo === 'recebimento' ? 'Confirmar' : 'Pronto', exact: true })
    await salvar.click()
    await expect(page.getByRole('alert')).toHaveText('Não deu para anotar. Tente de novo.')
    await expect(campo).toHaveValue(valor)
    expect(await retrato(page)).toEqual(antes)
    await expect(salvar).toBeEnabled()
    await page.screenshot({ path: info.outputPath('falha.png'), fullPage: true })
    await salvar.click()
    if (fluxo === 'venda') await expect(page.getByRole('button', { name: 'Ver a fichinha', exact: true })).toBeVisible()
    else if (fluxo === 'recebimento') await expect(page.getByText('Ainda deve R$ 30,00', { exact: true })).toBeVisible()
    else await expect(page.getByRole('heading', { name: 'Falha UX-02', exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    const depois = await retrato(page)
    expect(depois).not.toEqual(antes)
    await page.reload()
    expect(await retrato(page)).toEqual(depois)
  })
}

async function abrirBuild(page: Page) {
  await page.goto('/')
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.reload()
  await expect(page.getByText('Nenhuma fichinha ainda', { exact: true })).toBeVisible()
}

async function conferirAvisoNoRodape(page: Page, frase: string) {
  const aviso = page.locator('.rodape-acao').getByText(frase, { exact: true })
  await expect(aviso).toBeVisible()
  await aviso.scrollIntoViewIfNeeded()
  const posicao = await aviso.boundingBox()
  expect(posicao?.y).toBeGreaterThanOrEqual(0)
  expect(posicao!.y + posicao!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1)
  await expect(page.locator('.rodape-acao button')).toBeDisabled()
  await conferirLargura(page)
}

async function conferirLargura(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
}

async function retrato(page: Page) {
  return page.evaluate(() => new Promise<Record<string, unknown[]>>((resolver, rejeitar) => {
    const abertura = indexedDB.open('controle-fiado')
    abertura.onerror = () => rejeitar(abertura.error)
    abertura.onsuccess = () => {
      const db = abertura.result
      const tx = db.transaction([...db.objectStoreNames], 'readonly')
      const consultas = [...db.objectStoreNames].map(nome => [nome, tx.objectStore(nome).getAll()] as const)
      tx.oncomplete = () => {
        resolver(JSON.parse(JSON.stringify(Object.fromEntries(consultas.map(([nome, c]) => [nome, c.result])), (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v)))
        db.close()
      }
      tx.onerror = () => { rejeitar(tx.error); db.close() }
    }
  }))
}
