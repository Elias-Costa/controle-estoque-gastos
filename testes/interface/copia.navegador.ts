import { expect, test } from '@playwright/test'

// RNF-03: esta suíte verifica apresentação; conta/arquivo reais ficam em navegador/copia.
for (const c of [
  { nome: '320 claro', largura: 320, tema: 'light', ampliar: false },
  { nome: '375 escuro', largura: 375, tema: 'dark', ampliar: false },
  { nome: '1280 claro', largura: 1280, tema: 'light', ampliar: false },
  { nome: '320 texto ampliado', largura: 320, tema: 'light', ampliar: true },
] as const) {
  test(`E-35 ${c.nome}: leitura, alvos, foco e reserva sem conta`, async ({ page }, info) => {
    const erros: string[] = []; page.on('pageerror', (e) => erros.push(e.message))
    await page.setViewportSize({ width: c.largura, height: 812 }); await page.emulateMedia({ colorScheme: c.tema })
    await page.goto('/')
    if (c.ampliar) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
    await page.getByRole('button', { name: 'Cópia das anotações ›', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Cópia das anotações', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Preparar cópia completa', exact: true }).click()
    await expect(page.getByText('Entre na sua conta para identificar de quem é a cópia.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Começar a usar uma cópia', exact: true }).click()
    const cancelar = page.getByRole('button', { name: 'Cancelar esta preparação', exact: true })
    await expect(cancelar).toBeVisible()
    await expect(page.getByRole('button', { name: 'Preparar cópia completa', exact: true })).toBeDisabled()
    await cancelar.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
    await expect(cancelar).toBeFocused()
    const foco = await cancelar.evaluate((e) => ({ estilo: getComputedStyle(e).outlineStyle, topo: e.getBoundingClientRect().top, base: e.getBoundingClientRect().bottom }))
    expect(foco.estilo).not.toBe('none'); expect(foco.topo).toBeGreaterThanOrEqual(0); expect(foco.base).toBeLessThanOrEqual(812)
    const layout = await page.evaluate(() => ({ largura: document.documentElement.clientWidth, conteudo: document.documentElement.scrollWidth,
      pequenos: [...document.querySelectorAll('button, input, a')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44) }).length }))
    expect(layout.conteudo).toBeLessThanOrEqual(layout.largura); expect(layout.pequenos).toBe(0)
    await page.screenshot({ path: info.outputPath('copia.png'), fullPage: true })
    await cancelar.click()
    await expect(page.getByRole('button', { name: 'Começar a usar uma cópia', exact: true })).toBeVisible()
    expect(erros).toEqual([])
  })
}
