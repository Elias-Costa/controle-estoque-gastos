import { expect, test } from '@playwright/test'
import { abrirApp } from './apoio.ts'

for (const largura of [320, 375]) {
  test(`D-085 retorno ${largura}: documento isolado sob SW, sem rede e sem código no cache`, async ({ page, context }) => {
    const erros: string[] = []
    page.on('pageerror', (erro) => erros.push(erro.message))
    await page.setViewportSize({ width: largura, height: 812 })
    await abrirApp(page)
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
    await context.setOffline(true)
    await page.goto('/google-drive-retorno.html?state=invalida&code=codigo-ficticio-do-ensaio')
    await expect(page.getByRole('status')).toContainText('Não deu para conferir esta autorização.')
    expect(new URL(page.url()).search).toBe('')
    const temCodigo = await page.evaluate(async () => {
      for (const nome of await caches.keys()) for (const pedido of await (await caches.open(nome)).keys()) {
        if (pedido.url.includes('codigo-ficticio-do-ensaio') || pedido.url.includes('state=invalida')) return true
      }
      return false
    })
    expect(temCodigo).toBe(false)
    await page.getByRole('link', { name: 'Voltar ao Fichinhas', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Cópia das anotações', exact: true })).toBeVisible()
    expect(erros).toEqual([])
  })
}
