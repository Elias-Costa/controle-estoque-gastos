import { expect, test, type Page } from '@playwright/test'
import { PALAVRAS_DO_CAIXA as P } from '../../src/interface/palavras-do-caixa.ts'

for (const c of [
  { nome: '320 claro', largura: 320, tema: 'light', ampliar: false },
  { nome: '375 escuro', largura: 375, tema: 'dark', ampliar: false },
  { nome: '1280 claro', largura: 1280, tema: 'light', ampliar: false },
  { nome: '320 texto ampliado', largura: 320, tema: 'light', ampliar: true },
] as const) {
  test(`E-34 ${c.nome}: guardas, dinheiro exato, alvos, contraste, foco e rodapé`, async ({ page }, info) => {
    const erros: string[] = []; page.on('pageerror', (e) => erros.push(e.message))
    await page.setViewportSize({ width: c.largura, height: 812 }); await page.emulateMedia({ colorScheme: c.tema })
    await page.goto('/')
    if (c.ampliar) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
    await page.getByRole('button', { name: P.titulo, exact: true }).click()
    await expect(page.getByText(P.vazio, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: P.despesa, exact: true }).click()
    const pronto = page.getByRole('button', { name: P.salvar, exact: true })
    await expect(pronto).toBeDisabled()
    await page.getByLabel(P.valor, { exact: true }).fill('9007199254740993')
    await expect(page.getByLabel(P.valor, { exact: true })).toHaveValue('90.071.992.547.409,93')
    await page.getByLabel(P.categoria, { exact: true }).fill('CategoriaLivreÇã'.repeat(8))
    await page.getByLabel(P.data, { exact: true }).fill('2026-09-30')
    await expect(pronto).toBeDisabled()
    await page.getByRole('radio', { name: P.pessoal, exact: true }).check()
    await page.getByRole('radio', { name: P.sim, exact: true }).check()
    await expect(page.getByText(`${P.classificacao}: ${P.negocio}`, { exact: true })).toBeVisible()
    await expect(pronto).toBeEnabled()
    await page.getByLabel(P.data, { exact: true }).fill('2099-01-01')
    await expect(pronto).toBeDisabled()
    await page.getByLabel(P.data, { exact: true }).fill('2026-09-30')
    await expect(pronto).toBeEnabled()
    const contraste = await page.getByLabel(P.categoria, { exact: true }).evaluate((e) => {
      const estilo = getComputedStyle(e)
      function luz(cor: string): number {
        const v = cor.match(/[\d.]+/g)?.slice(0, 3).map((x) => {
          const n = Number(x) / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
        }) ?? []
        return (v[0] ?? 0) * 0.2126 + (v[1] ?? 0) * 0.7152 + (v[2] ?? 0) * 0.0722
      }
      const a = luz(estilo.borderTopColor), b = luz(estilo.backgroundColor)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    })
    expect(contraste).toBeGreaterThanOrEqual(3)
    await page.getByRole('radio', { name: P.sim, exact: true }).focus()
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('radio', { name: P.sim, exact: true })).toBeFocused()
    expect(await page.getByRole('radio', { name: P.sim, exact: true }).evaluate((e) => getComputedStyle(e.closest('label') ?? e).outlineStyle)).not.toBe('none')
    await layout(page)
    await page.screenshot({ path: info.outputPath('gasto.png'), fullPage: true })
    await pronto.click()
    await expect(page.locator('[data-caixa-total="saiu"]')).toHaveText('R$ 90.071.992.547.409,93')
    await expect(page.locator('[data-caixa-total="diferenca"]')).toHaveText('-R$ 90.071.992.547.409,93')
    await layout(page)
    await page.locator('[data-caixa-id] summary').click()
    await page.getByRole('button', { name: P.desfazer, exact: true }).click()
    await page.getByRole('button', { name: P.manter, exact: true }).focus()
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
    const posicao = await page.getByRole('button', { name: P.manter, exact: true }).boundingBox()
    const limite = await page.locator('.rodape-acao').boundingBox()
    expect(posicao).not.toBeNull(); expect(limite).not.toBeNull()
    expect((posicao?.y ?? -1) + (posicao?.height ?? 0)).toBeLessThanOrEqual((limite?.y ?? 0) - 3)
    await layout(page)
    await page.screenshot({ path: info.outputPath('caixa.png'), fullPage: true })
    expect(erros).toEqual([])
  })
}

async function layout(page: Page): Promise<void> {
  const medidas = await page.evaluate(() => ({ largura: document.documentElement.clientWidth, conteudo: document.documentElement.scrollWidth,
    pequenos: [...document.querySelectorAll('button, input:not([type="radio"]), summary, label:has(input[type="radio"])')].filter((e) => {
      const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44)
    }).length,
  }))
  expect(medidas.conteudo).toBeLessThanOrEqual(medidas.largura); expect(medidas.pequenos).toBe(0)
  await expect.poll(async () => page.locator('.tela').evaluate((e) => Number.parseFloat(getComputedStyle(e).paddingBottom) - (e.querySelector('.rodape-acao')?.getBoundingClientRect().height ?? 0))).toBeGreaterThanOrEqual(16)
}
