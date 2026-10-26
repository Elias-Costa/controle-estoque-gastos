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
    await page.getByRole('button', { name: 'Identificar loja', exact: true }).click()
    await page.getByLabel('Nome da loja ou marca', { exact: true }).fill('Cícera Mult')
    await page.getByLabel('Descrição da loja (opcional)', { exact: true }).fill('Perfumaria, moda íntima, beleza e acessórios para celular')
    await page.getByLabel('Escolher logo', { exact: true }).setInputFiles(fileURLToPath(new URL('../../public/icones/icone-192.png', import.meta.url)))
    await expect(page.getByRole('img', { name: 'Prévia do recorte circular', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('region', { name: 'Ajustar logo', exact: true }).screenshot({ path: info.outputPath('recorte-logo.png') })
    await page.getByRole('button', { name: 'Usar logo', exact: true }).click()
    await expect(page.getByRole('img', { name: 'Prévia da logo da loja', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('editor-identificacao.png'), fullPage: true })
    await page.getByRole('button', { name: 'Salvar identificação', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Editar identificação', exact: true })).toBeVisible()
    await page.getByLabel('Para qual fichinha?', { exact: true }).selectOption({ label: 'Cliente fictícia com nome comprido E-28C' })
    for (const titulo of ['Categorias', 'Marcas']) {
      const grupo = page.getByRole('group', { name: titulo, exact: true }), resumo = grupo.locator('summary')
      await resumo.focus(); await expect(resumo).toBeFocused()
      expect((await resumo.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      await resumo.press('Enter')
      for (const caixa of await grupo.getByRole('checkbox').all()) expect((await caixa.locator('..').boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }
    await page.screenshot({ path: info.outputPath('filtros-multiplos.png'), fullPage: true })
    for (const rotulo of ['Classificação', 'Para qual fichinha?']) {
      const campo = page.getByLabel(rotulo, { exact: true }); await campo.focus(); await expect(campo).toBeFocused()
      expect((await campo.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }
    expect((await page.locator('[data-divulgacao-id]').getByRole('checkbox').locator('..').boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await expect(page.getByText('R$ 9.007.199.254.740.993.123,45', { exact: true })).toBeVisible()
    const botao = page.getByRole('button', { name: 'Preparar PDF', exact: true })
    await expect(botao).toBeEnabled(); await botao.focus(); await expect(botao).toBeFocused()
    expect((await botao.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    const transbordamentos = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => ({ elemento: e.tagName, texto: e.textContent?.slice(0, 50), direita: e.getBoundingClientRect().right })))
    expect(transbordamentos).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (cenario.nome === '375 escuro') {
      await botao.click()
      await expect(page.getByText(/^PDF pronto com 1 produtos/)).toBeVisible()
      await page.getByRole('button', { name: 'Editar identificação', exact: true }).click()
      await page.getByLabel('Nome da loja ou marca', { exact: true }).fill('Minha identificação em edição')
      const outra = await page.context().newPage()
      await outra.goto('/')
      await outra.getByRole('button', { name: /^Produtos/ }).click()
      await outra.getByRole('button', { name: P.abrir, exact: true }).click()
      await outra.getByRole('button', { name: 'Editar identificação', exact: true }).click()
      await outra.getByLabel('Nome da loja ou marca', { exact: true }).fill('Identificação guardada em outra aba')
      await outra.getByRole('button', { name: 'Salvar identificação', exact: true }).click()
      await expect(outra.getByRole('button', { name: 'Editar identificação', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Compartilhar PDF', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Salvar identificação', exact: true }).click()
      await expect(page.getByText(/^A identificação mudou em outro lugar/)).toBeVisible()
      await expect(page.getByLabel('Nome da loja ou marca', { exact: true })).toHaveValue('Minha identificação em edição')
      await page.getByRole('button', { name: 'Usar a identificação guardada', exact: true }).click()
      await expect(page.getByLabel('Nome da loja ou marca', { exact: true })).toHaveValue('Identificação guardada em outra aba')
      await outra.close()
    }
    await page.screenshot({ path: info.outputPath('divulgacao.png'), fullPage: true })
    expect(erros).toEqual([])
  })
}
