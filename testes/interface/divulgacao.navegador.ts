import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { PALAVRAS_DO_ESTOQUE as E } from '../../src/interface/palavras-do-estoque.ts'
import { PALAVRAS_DA_DIVULGACAO as P } from '../../src/interface/palavras-da-divulgacao.ts'

for (const cenario of [
  { nome: '320 claro', largura: 320, tema: 'light', ampliado: false },
  { nome: '375 escuro', largura: 375, tema: 'dark', ampliado: false },
  { nome: '1280 claro', largura: 1280, tema: 'light', ampliado: false },
  { nome: '320 ampliado', largura: 320, tema: 'light', ampliado: true },
] as const) {
  test(`E-28C divulgação ${cenario.nome}`, async ({ page }, info) => {
    const erros: string[] = []
    page.on('pageerror', (erro) => erros.push(erro.message))
    await page.setViewportSize({ width: cenario.largura, height: 812 }); await page.emulateMedia({ colorScheme: cenario.tema })
    await page.goto('/')
    await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Cliente fictícia com nome comprido E-28C')
    await page.getByLabel('Telefone', { exact: true }).fill('85999999999')
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    await page.getByRole('button', { name: /^Produtos/ }).click()
    await page.getByRole('button', { name: '+ Novo produto', exact: true }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Perfume Açúcar e Âmbar com nome comprido para conferir a leitura no celular')
    await page.getByRole('button', { name: '+ Nova categoria', exact: true }).click()
    await page.getByLabel('Nome da categoria', { exact: true }).fill('Perfumaria')
    await page.getByRole('button', { name: 'Usar esta categoria', exact: true }).click()
    await page.getByLabel('Marca', { exact: true }).fill('Marca longa de teste para conferir o espaço')
    await page.getByLabel('Preço de venda', { exact: true }).fill('900719925474099312345')
    await page.getByLabel('Escolher foto', { exact: true }).setInputFiles(fileURLToPath(new URL('../arquivos/foto-teste.jpeg', import.meta.url)))
    await expect(page.getByRole('img')).toBeVisible()
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await page.locator('[data-produto-id]').click()
    await page.getByRole('button', { name: E.ver, exact: true }).click()
    await page.getByRole('button', { name: E.inicial, exact: true }).click()
    await page.getByLabel(E.contado, { exact: true }).fill('1')
    await page.getByRole('button', { name: E.salvar, exact: true }).click()
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    await page.getByRole('button', { name: P.abrir, exact: true }).click()
    await expect(page.locator('[data-divulgacao-id]')).toHaveCount(1)
    if (cenario.ampliado) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
    await page.getByLabel('Para qual fichinha?', { exact: true }).selectOption({ label: 'Cliente fictícia com nome comprido E-28C' })
    for (const rotulo of ['Categoria', 'Marca', 'Classificação', 'Para qual fichinha?']) {
      const campo = page.getByLabel(rotulo, { exact: true }); await campo.focus(); await expect(campo).toBeFocused()
      expect((await campo.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }
    expect((await page.getByRole('checkbox').locator('..').boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await expect(page.getByText('R$ 9.007.199.254.740.993.123,45', { exact: true })).toBeVisible()
    const botao = page.getByRole('button', { name: 'Preparar PDF', exact: true })
    await expect(botao).toBeEnabled(); await botao.focus(); await expect(botao).toBeFocused()
    expect((await botao.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    const transbordamentos = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => ({ elemento: e.tagName, texto: e.textContent?.slice(0, 50), direita: e.getBoundingClientRect().right })))
    expect(transbordamentos).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('divulgacao.png'), fullPage: true })
    expect(erros).toEqual([])
  })
}
