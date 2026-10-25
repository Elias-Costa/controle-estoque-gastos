import { expect, test } from '@playwright/test'

for (const c of [
  { nome: '320 claro', largura: 320, tema: 'light', ampliar: false },
  { nome: '375 escuro', largura: 375, tema: 'dark', ampliar: false },
  { nome: '1280 claro', largura: 1280, tema: 'light', ampliar: false },
  { nome: '320 ampliado', largura: 320, tema: 'light', ampliar: true },
] as const) test(`E-36 ${c.nome}: prévia, inserção, alvos e foco offline`, async ({ page }, info) => {
  await page.setViewportSize({ width: c.largura, height: 812 }); await page.emulateMedia({ colorScheme: c.tema })
  await page.goto('/')
  if (c.ampliar) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
  await page.getByRole('button', { name: 'Mensagens do WhatsApp ›', exact: true }).click()
  const campo = page.getByLabel('Texto da mensagem', { exact: true })
  await campo.fill('Mensagem grande '.repeat(40) + ' {nome}')
  const guardar = page.getByRole('button', { name: 'Guardar os textos', exact: true })
  await guardar.click(); await expect(page.getByRole('status')).toHaveText('Textos guardados neste aparelho.')
  await campo.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
  await expect(campo).toBeFocused()
  expect(await campo.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none')
  const medidas = await page.evaluate(() => ({ largura: document.documentElement.clientWidth, conteudo: document.documentElement.scrollWidth,
    pequenos: [...document.querySelectorAll('button, select, textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44) }).length }))
  expect(medidas.conteudo).toBeLessThanOrEqual(medidas.largura); expect(medidas.pequenos).toBe(0)
  await page.screenshot({ path: info.outputPath('modelos.png'), fullPage: true })
})
