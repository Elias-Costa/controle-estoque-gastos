import { expect, test, type Page } from '@playwright/test'

async function lerEstado(page: Page) {
  return page.evaluate(() => new Promise<{ logo?: string; preferencia: unknown; fila: unknown[] }>((resolver, rejeitar) => {
    const abertura = indexedDB.open('controle-fiado')
    abertura.onerror = () => rejeitar(abertura.error)
    abertura.onsuccess = () => {
      const db = abertura.result, tx = db.transaction(['identidadesLoja', 'fila'], 'readonly')
      const preferencia = tx.objectStore('identidadesLoja').get('loja'), fila = tx.objectStore('fila').getAll()
      tx.oncomplete = () => { resolver({ logo: preferencia.result?.identidade.logo, preferencia: preferencia.result, fila: fila.result }); db.close() }
      tx.onerror = () => rejeitar(tx.error)
    }
  }))
}

test.use({ viewport: { width: 320, height: 812 }, hasTouch: true, isMobile: true })

test('D-076 recorte offline: toque, teclado, zoom, pixels e cancelamento conservam a identificação', async ({ page, context }, info) => {
  const erros: string[] = []; page.on('pageerror', (erro) => erros.push(erro.message))
  await page.goto('/')
  await page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('SW não ativou')), 15_000))]))
  await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  await context.setOffline(true)
  await page.getByRole('button', { name: /^Produtos/ }).click()
  await page.getByRole('button', { name: 'Divulgar produtos', exact: true }).click()
  await page.getByRole('button', { name: 'Identificar loja', exact: true }).click()
  await page.getByLabel('Nome da loja ou marca', { exact: true }).fill('Loja do recorte')
  const original = await page.evaluate(() => {
    // Duas cores conhecidas tornam visível se o recorte realmente moveu os pixels.
    const tela = document.createElement('canvas'); tela.width = 400; tela.height = 200
    const c = tela.getContext('2d'); if (!c) throw new Error('Canvas indisponível')
    c.fillStyle = '#ff0000'; c.fillRect(0, 0, 200, 200)
    c.fillStyle = '#0000ff'; c.fillRect(200, 0, 200, 200)
    return tela.toDataURL('image/png').split(',')[1] ?? ''
  })
  const arquivo = { name: 'retangulo.png', mimeType: 'image/png', buffer: Buffer.from(original, 'base64') }
  await page.getByLabel('Escolher logo', { exact: true }).setInputFiles(arquivo)
  const usar = page.getByRole('button', { name: 'Usar logo', exact: true })
  await expect(usar).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Salvar identificação', exact: true })).toBeDisabled()
  const posicao = page.getByRole('group', { name: 'Posição da logo', exact: true })
  await posicao.scrollIntoViewIfNeeded()
  const caixa = await posicao.boundingBox(); if (!caixa) throw new Error('Sem moldura')
  const antes = await page.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL())
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: caixa.x + caixa.width / 2, y: caixa.y + caixa.height / 2 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: caixa.x + caixa.width / 2 + 30, y: caixa.y + caixa.height / 2 + 15 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  await expect.poll(() => page.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(antes)
  await page.getByRole('button', { name: 'Centralizar imagem', exact: true }).click()
  await page.getByRole('slider', { name: 'Tamanho da logo', exact: true }).fill('200')
  await posicao.focus()
  for (let i = 0; i < 25; i++) await posicao.press('ArrowRight')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('recorte-ajustado.png'), fullPage: true })
  await usar.click()
  await expect(page.getByRole('img', { name: 'Prévia da logo da loja', exact: true })).toBeVisible()
  const resultado = await page.getByRole('img', { name: 'Prévia da logo da loja', exact: true }).evaluate(async (e: HTMLImageElement) => {
    await e.decode()
    const tela = document.createElement('canvas'); tela.width = e.naturalWidth; tela.height = e.naturalHeight
    const c = tela.getContext('2d'); if (!c) throw new Error('Canvas indisponível'); c.drawImage(e, 0, 0)
    return { largura: e.naturalWidth, altura: e.naturalHeight, centro: [...c.getImageData(100, 100, 1, 1).data],
      direita: [...c.getImageData(175, 100, 1, 1).data], cantos: [[0, 0], [199, 0], [0, 199], [199, 199]].map(([x, y]) => c.getImageData(x!, y!, 1, 1).data[3]),
      bytes: atob(e.src.slice(22)).length }
  })
  expect(resultado.largura).toBe(200); expect(resultado.altura).toBe(200)
  expect(resultado.centro).toEqual([255, 0, 0, 255]); expect(resultado.direita).toEqual([0, 0, 255, 255])
  expect(resultado.cantos).toEqual([0, 0, 0, 0]); expect(resultado.bytes).toBeLessThanOrEqual(204800)
  await page.getByRole('button', { name: 'Salvar identificação', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Editar identificação', exact: true })).toBeVisible()
  const salvo = await lerEstado(page)
  await page.getByRole('button', { name: 'Editar identificação', exact: true }).click()
  const previa = await page.getByRole('img', { name: 'Prévia da logo da loja', exact: true }).getAttribute('src')
  await page.getByLabel('Escolher logo', { exact: true }).setInputFiles(arquivo)
  await expect(usar).toBeEnabled()
  await page.getByRole('slider', { name: 'Tamanho da logo', exact: true }).fill('50')
  await page.getByRole('button', { name: 'Cancelar recorte', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Prévia da logo da loja', exact: true })).toHaveAttribute('src', previa!)
  expect(await lerEstado(page)).toEqual(salvo)
  await page.getByLabel('Escolher logo', { exact: true }).setInputFiles({ name: 'quebrada.png', mimeType: 'image/png', buffer: Buffer.from('imagem inválida') })
  await expect(page.getByRole('alert')).toHaveText('Não consegui abrir esta imagem. Escolha outra logo.')
  await expect(usar).toBeDisabled()
  await page.getByRole('button', { name: 'Cancelar recorte', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Prévia da logo da loja', exact: true })).toHaveAttribute('src', previa!)
  await page.getByRole('button', { name: 'Ajustar logo', exact: true }).click()
  await expect(usar).toBeEnabled(); await page.getByRole('slider', { name: 'Tamanho da logo', exact: true }).fill('150')
  await usar.click()
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
  expect(await lerEstado(page)).toEqual(salvo)
  await page.reload()
  await page.getByRole('button', { name: /^Produtos/ }).click()
  await page.getByRole('button', { name: 'Divulgar produtos', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Logo da loja', exact: true })).toHaveAttribute('src', salvo.logo!)
  expect(erros).toEqual([])
})
