import { expect, test, type Page } from '@playwright/test'

async function retratoDaBase(page: Page) {
  return page.evaluate(() => new Promise<string>((resolver, rejeitar) => {
    const abertura = indexedDB.open('controle-fiado')
    abertura.onerror = () => rejeitar(abertura.error)
    abertura.onsuccess = () => {
      const db = abertura.result, tabelas = [...db.objectStoreNames], tx = db.transaction(tabelas, 'readonly')
      const consultas = tabelas.map((nome) => ({ nome, consulta: tx.objectStore(nome).getAll() }))
      tx.oncomplete = () => {
        resolver(JSON.stringify(consultas.map((c) => [c.nome, c.consulta.result]), (_, valor: unknown) => typeof valor === 'bigint' ? valor.toString() : valor)); db.close()
      }
      tx.onerror = () => rejeitar(tx.error)
    }
  }))
}

for (const cenario of [{ nome: 'estreito ampliado', largura: 320, ampliado: true, tema: 'light' },
  { nome: 'celular escuro', largura: 375, ampliado: false, tema: 'dark' }] as const) {
  test(`D-077 relato offline: ${cenario.nome}`, async ({ page, context }, info) => {
    const erros: string[] = []; page.on('pageerror', (erro) => erros.push(erro.message))
    await page.setViewportSize({ width: cenario.largura, height: 812 })
    await page.emulateMedia({ colorScheme: cenario.tema })
    await page.goto('/')
    await page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('SW não ativou')), 15_000))]))
    await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller)
    await expect(page.getByRole('link', { name: 'Relatar problema', exact: true })).toHaveCount(0)
    await context.setOffline(true)
    await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Cliente privada do relato')
    await page.getByLabel('Telefone', { exact: true }).fill('85999998888')
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Cliente privada do relato', exact: true })).toBeVisible()
    // Recusa fictícia na fila real: não há Supabase neste build, nem operação de produção.
    await page.evaluate(() => new Promise<void>((resolver, rejeitar) => {
      const abertura = indexedDB.open('controle-fiado')
      abertura.onerror = () => rejeitar(abertura.error)
      abertura.onsuccess = () => {
        const db = abertura.result, tx = db.transaction('fila', 'readwrite'), fila = tx.objectStore('fila')
        const consulta = fila.getAll()
        consulta.onsuccess = () => {
          const item: { ordem: number; problema?: unknown } = consulta.result[0]
          item.problema = { codigo: '23505', constraint: 'restricao-de-teste', mensagem: 'Erro de teste: "anotação" & vínculo? 🧪', em: '2026-10-26T12:00:00.000Z' }
          fila.put(item)
        }
        tx.oncomplete = () => { db.close(); resolver() }
        tx.onerror = () => rejeitar(tx.error)
      }
    }))
    await page.reload()
    if (cenario.ampliado) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
    await expect(page.locator('.indicador')).toHaveAttribute('data-com-problema', '1')
    const aviso = page.getByRole('complementary', { name: 'Problema no envio', exact: true })
    await expect(aviso).toContainText('Uma anotação não pôde ser enviada.')
    await expect(aviso).not.toContainText(/23505|restricao-de-teste|sincroniza|SQLSTATE/)
    const antes = await retratoDaBase(page)
    await expect(aviso).toContainText('Entre na sua conta para relatar o problema.')
    await expect(aviso.getByRole('button', { name: 'Relatar problema', exact: true })).toHaveCount(0)
    await expect(aviso.getByRole('link')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('relato.png'), fullPage: true })
    expect(await retratoDaBase(page)).toBe(antes)
    await expect(page.locator('.indicador')).toHaveAttribute('data-com-problema', '1')
    expect(erros).toEqual([])
  })
}
