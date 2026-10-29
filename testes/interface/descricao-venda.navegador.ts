import { expect, test, type Page } from '@playwright/test'

type BaseComparavel = Record<string, unknown[]> & {
  lancamentos: { itens: { descricao: string }[] }[]
  fila: { tabela: string; versao: number; problema?: unknown }[]
}

async function retrato(page: Page) {
  return page.evaluate(() => new Promise<BaseComparavel>((resolver, rejeitar) => {
    const abertura = indexedDB.open('controle-fiado')
    abertura.onerror = () => rejeitar(abertura.error)
    abertura.onsuccess = () => {
      const db = abertura.result, tx = db.transaction([...db.objectStoreNames], 'readonly')
      const consultas = [...db.objectStoreNames].map((nome) => [nome, tx.objectStore(nome).getAll()] as const)
      tx.oncomplete = () => { resolver(JSON.parse(JSON.stringify(Object.fromEntries(consultas.map(([nome, c]) => [nome, c.result])), (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v))); db.close() }
      tx.onerror = () => rejeitar(tx.error)
    }
  }))
}

for (const c of [{ nome: '320 ampliado', largura: 320, ampliado: true, tema: 'light' }, { nome: '375 escuro', largura: 375, ampliado: false, tema: 'dark' }] as const) {
  test(`D-078 descrição obrigatória e complemento offline: ${c.nome}`, async ({ page, context }, info) => {
    const erros: string[] = []; page.on('pageerror', (e) => erros.push(e.message))
    await page.setViewportSize({ width: c.largura, height: 812 }); await page.emulateMedia({ colorScheme: c.tema })
    await page.goto('/'); await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)); await page.reload()
    await page.waitForFunction(() => !!navigator.serviceWorker.controller); await context.setOffline(true)
    await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Cliente fictícia do complemento')
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await page.getByRole('button', { name: 'Vender fiado', exact: true }).click()
    await page.getByLabel('Preço unitário 1', { exact: true }).fill('1000')
    await expect(page.getByText('Informe o que foi vendido em cada item', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pronto', exact: true })).toBeDisabled()
    await page.getByLabel('Item 1', { exact: true }).fill('   ')
    await expect(page.getByRole('button', { name: 'Pronto', exact: true })).toBeDisabled()
    await page.getByLabel('Item 1', { exact: true }).fill('Batom')
    await expect(page.getByRole('button', { name: 'Pronto', exact: true })).toBeEnabled()
    // Legado fictício escrito direto no IndexedDB: novas vendas já não permitem esse conteúdo.
    await page.evaluate(() => new Promise<void>((resolver, rejeitar) => {
      const abertura = indexedDB.open('controle-fiado'); abertura.onerror = () => rejeitar(abertura.error)
      abertura.onsuccess = () => {
        const db = abertura.result, tx = db.transaction(['clientes', 'lancamentos', 'fila'], 'readwrite')
        const clientes = tx.objectStore('clientes').getAll()
        clientes.onsuccess = () => {
          const venda = { tipo: 'venda', pagamento: 'fiado', id: '00000000-0000-7000-8000-000000000078', clienteId: clientes.result[0].id, data: '2026-10-20',
            itens: [{ descricao: '', preco: 1000n }, { descricao: '  ', preco: 0n }, { descricao: 'Nome preservado', preco: 500n }], desconto: 1n,
            parcelas: [{ id: '00000000-0000-7000-8000-000000000079', vencimento: '2026-11-20', valor: 1499n }] }
          tx.objectStore('lancamentos').put(venda)
          tx.objectStore('fila').add({ tabela: 'lancamentos', registroId: venda.id, criadoEm: '2026-10-20T17:16:41.862Z', versao: 0,
            problema: { codigo: '23514', constraint: 'lancamentos_sem_itens', mensagem: 'Recusa fictícia', em: '2026-10-20T17:16:42.390Z' } })
        }
        tx.oncomplete = () => { db.close(); resolver() }; tx.onerror = () => rejeitar(tx.error)
      }
    }))
    await page.reload()
    if (c.ampliado) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
    const completar = page.getByRole('button', { name: 'Completar o que foi vendido', exact: true })
    await expect(completar).toBeVisible()
    const antes = await retrato(page)
    await page.getByRole('button', { name: /^Cliente fictícia do complemento/ }).click()
    await page.getByRole('button', { name: /Nome preservado/ }).click()
    await expect(page.getByText('Falta completar o que foi vendido. Volte ao começo e toque em “Completar o que foi vendido”.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Desfazer esta venda', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    expect(await retrato(page)).toEqual(antes)
    await completar.click(); await expect(page.getByLabel('O que foi vendido no item 1', { exact: true })).toBeVisible()
    await expect(page.getByLabel('O que foi vendido no item 3', { exact: true })).toHaveCount(0)
    expect(await retrato(page)).toEqual(antes)
    await page.getByRole('button', { name: 'Deixar como está', exact: true }).click()
    expect(await retrato(page)).toEqual(antes)
    await completar.click()
    const salvar = page.getByRole('button', { name: 'Salvar e tentar enviar', exact: true })
    await page.getByLabel('O que foi vendido no item 1', { exact: true }).fill('Batom')
    await page.getByLabel('O que foi vendido no item 2', { exact: true }).fill(' '); await expect(salvar).toBeDisabled()
    await page.getByLabel('O que foi vendido no item 2', { exact: true }).fill('Amostra')
    await expect(salvar).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('completar.png'), fullPage: true })
    await salvar.click()
    const esperado = structuredClone(antes)
    const registro = esperado.lancamentos[0]!
    registro.itens[0]!.descricao = 'Batom'; registro.itens[1]!.descricao = 'Amostra'
    for (const fila of esperado.fila) {
      if (fila.tabela === 'lancamentos') { fila.versao = 1; delete fila.problema }
    }
    await expect.poll(() => retrato(page)).toEqual(esperado)
    await page.reload(); expect(await retrato(page)).toEqual(esperado)
    expect(erros).toEqual([])
  })
}
