import { expect, test, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PALAVRAS_DO_ESTOQUE as E } from '../../src/interface/palavras-do-estoque.ts'

declare global { interface Window { pdfFiltroMultiplo?: string } }

async function estadoDaBase(page: Page) {
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

test('D-074 duas categorias e marcas: combinação offline, seleção individual, PDF e nenhuma opção', async ({ page, context }, info) => {
  const erros: string[] = []; page.on('pageerror', (erro) => erros.push(erro.message))
  await page.addInitScript(() => {
    // Apenas o seletor do SO é interceptado; o arquivo vem do gerador real do app.
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (dados: ShareData) => {
      const arquivo = dados.files?.[0]; if (!arquivo) throw new Error('Sem PDF')
      window.pdfFiltroMultiplo = await new Promise<string>((resolver, rejeitar) => {
        const leitor = new FileReader(); leitor.onload = () => typeof leitor.result === 'string' ? resolver(leitor.result.split(',')[1] ?? '') : rejeitar()
        leitor.onerror = rejeitar; leitor.readAsDataURL(arquivo)
      })
    } })
  })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  await page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('SW não ativou')), 15_000))]))
  await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  await context.setOffline(true)
  await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
  await page.getByLabel('Nome', { exact: true }).fill('Cliente dos filtros')
  await page.getByLabel('Telefone', { exact: true }).fill('85999999999')
  await page.getByRole('button', { name: 'Pronto', exact: true }).click()
  await page.getByRole('button', { name: 'Voltar', exact: true }).click()
  await page.getByRole('button', { name: /^Produtos/ }).click()
  const categoriasCriadas = new Set<string>()
  for (const [nome, categoria, marca, classificacao] of [
    ['A Perfume X', 'Perfumaria', 'X', 'masculino'],
    ['B Perfume Y', 'Perfumaria', 'Y', 'unissex'],
    ['C Roupa Y', 'Moda íntima', 'Y', 'masculino'],
    ['D Roupa Z', 'Moda íntima', 'Z', 'masculino'],
    ['E Cabo X', 'Celular', 'X', 'masculino'],
    ['F Perfume feminino', 'Perfumaria', 'X', 'feminino'],
    ['G Sem marca', 'Moda íntima', '', 'masculino'],
  ] as const) {
    await page.getByRole('button', { name: '+ Novo produto', exact: true }).click()
    await page.getByLabel('Nome', { exact: true }).fill(nome)
    if (!categoriasCriadas.has(categoria)) {
      await page.getByRole('button', { name: '+ Nova categoria', exact: true }).click()
      await page.getByLabel('Nome da categoria', { exact: true }).fill(categoria)
      await page.getByRole('button', { name: 'Usar esta categoria', exact: true }).click()
      categoriasCriadas.add(categoria)
    } else await page.getByLabel('Categoria', { exact: true }).selectOption({ label: categoria })
    await page.getByLabel('Marca', { exact: true }).fill(marca)
    await page.getByLabel('Classificação', { exact: true }).selectOption(classificacao)
    await page.getByLabel('Preço de venda', { exact: true }).fill('12345')
    await page.getByLabel('Escolher foto', { exact: true }).setInputFiles(fileURLToPath(new URL('../arquivos/foto-teste.jpeg', import.meta.url)))
    await expect(page.getByRole('img')).toBeVisible()
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await page.locator('[data-produto-id]').filter({ hasText: nome }).click()
    await page.getByRole('button', { name: E.ver, exact: true }).click()
    await page.getByRole('button', { name: E.inicial, exact: true }).click()
    await page.getByLabel(E.contado, { exact: true }).fill('2')
    await page.getByRole('button', { name: E.salvar, exact: true }).click()
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Divulgar produtos', exact: true }).click()
  await page.getByRole('button', { name: 'Identificar loja', exact: true }).click()
  await page.getByLabel('Nome da loja ou marca', { exact: true }).fill('Loja seleção múltipla')
  await page.getByRole('button', { name: 'Salvar identificação', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Editar identificação', exact: true })).toBeVisible()
  const categorias = page.getByRole('group', { name: 'Categorias', exact: true }), marcas = page.getByRole('group', { name: 'Marcas', exact: true })
  const linhas = page.locator('[data-divulgacao-id]'), preparar = page.getByRole('button', { name: 'Preparar PDF', exact: true })
  await expect(linhas).toHaveCount(7)
  await categorias.locator('summary').click()
  await categorias.getByRole('checkbox', { name: 'Todas as categorias', exact: true }).uncheck()
  await expect(linhas).toHaveCount(0); await expect(preparar).toBeDisabled()
  await categorias.getByRole('checkbox', { name: 'Perfumaria', exact: true }).check()
  await categorias.getByRole('checkbox', { name: 'Moda íntima', exact: true }).check()
  await expect(categorias.locator('summary')).toHaveText('2 selecionadas')
  await expect(linhas).toHaveCount(6)
  await marcas.locator('summary').click()
  await marcas.getByRole('checkbox', { name: 'Todas as marcas', exact: true }).uncheck()
  await expect(linhas).toHaveCount(0)
  await marcas.getByRole('checkbox', { name: 'X', exact: true }).check()
  await marcas.getByRole('checkbox', { name: 'Y', exact: true }).check()
  await expect(linhas).toHaveCount(4)
  await page.getByLabel('Classificação', { exact: true }).selectOption('masculino')
  await expect(linhas).toHaveCount(3)
  await expect(linhas.getByRole('checkbox').locator('..')).toHaveText(['A Perfume X', 'B Perfume Y', 'C Roupa Y'])
  await linhas.getByRole('checkbox', { name: 'B Perfume Y', exact: true }).uncheck()
  await page.getByLabel('Para qual fichinha?', { exact: true }).selectOption({ label: 'Cliente dos filtros' })
  await expect(page.getByText('2 selecionados de 3 produtos', { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('duas-categorias-duas-marcas.png'), fullPage: true })
  const antes = await estadoDaBase(page)
  await preparar.click(); await expect(page.getByText(/^PDF pronto com 2 produtos/)).toBeVisible()
  await page.getByRole('button', { name: 'Compartilhar PDF', exact: true }).click()
  await expect.poll(() => page.evaluate(() => !!window.pdfFiltroMultiplo)).toBe(true)
  const pdf = await page.evaluate(() => window.pdfFiltroMultiplo); if (!pdf) throw new Error('PDF ausente')
  await writeFile(info.outputPath('catalogo-duas-categorias-duas-marcas.pdf'), Buffer.from(pdf, 'base64'))
  expect(await estadoDaBase(page)).toBe(antes)
  await marcas.getByRole('checkbox', { name: 'Z', exact: true }).check()
  await expect(page.getByRole('button', { name: 'Compartilhar PDF', exact: true })).toHaveCount(0)
  await expect(linhas).toHaveCount(4)
  await expect(linhas.getByRole('checkbox', { name: 'B Perfume Y', exact: true })).not.toBeChecked()
  await marcas.getByRole('checkbox', { name: 'X', exact: true }).uncheck()
  await marcas.getByRole('checkbox', { name: 'Y', exact: true }).uncheck()
  await marcas.getByRole('checkbox', { name: 'Z', exact: true }).uncheck()
  await expect(marcas.locator('summary')).toHaveText('Nenhuma selecionada')
  await expect(linhas).toHaveCount(0); await expect(preparar).toBeDisabled()
  await marcas.getByRole('checkbox', { name: 'Sem marca', exact: true }).check()
  await expect(linhas).toHaveCount(1); await expect(linhas).toContainText('G Sem marca')
  await marcas.getByRole('checkbox', { name: 'Todas as marcas', exact: true }).check()
  await categorias.getByRole('checkbox', { name: 'Todas as categorias', exact: true }).check()
  await expect(linhas).toHaveCount(6)
  await categorias.getByRole('checkbox', { name: 'Celular', exact: true }).uncheck()
  await expect(linhas).toHaveCount(5)
  expect(await categorias.getByRole('checkbox', { name: 'Todas as categorias', exact: true }).evaluate((e: HTMLInputElement) => e.indeterminate)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(erros).toEqual([])
})
