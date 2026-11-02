import { expect, test, type Page } from '@playwright/test'
import type { Venda } from '../../src/dominio/ficha.ts'
import type { MovimentoEstoque } from '../../src/dominio/estoque.ts'

const cenarios = [
  { nome: '320 claro', largura: 320, altura: 812, tema: 'light', ampliado: false },
  { nome: '375 escuro', largura: 375, altura: 812, tema: 'dark', ampliado: false },
  { nome: '1280 claro', largura: 1280, altura: 812, tema: 'light', ampliado: false },
  { nome: '320 ampliado', largura: 320, altura: 812, tema: 'light', ampliado: true },
  { nome: '375 escuro ampliado', largura: 375, altura: 812, tema: 'dark', ampliado: true },
  { nome: '320 baixo escuro ampliado', largura: 320, altura: 480, tema: 'dark', ampliado: true },
] as const

for (const c of cenarios) {
  for (const produto of [false, true]) {
    test(`UX-03 ${c.nome}: ${produto ? 'produto selecionado' : 'venda avulsa'} e correção offline`, async ({ page, context }, info) => {
      const erros: string[] = []
      page.on('pageerror', e => erros.push(e.message))
      await page.setViewportSize({ width: c.largura, height: c.altura })
      await page.emulateMedia({ colorScheme: c.tema })
      await page.goto('/')
      await page.evaluate(async () => { await navigator.serviceWorker.ready })
      await page.reload()
      await page.waitForFunction(() => !!navigator.serviceWorker.controller)
      await context.setOffline(true)
      async function ampliar() {
        if (c.ampliado) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
      }
      await ampliar()
      if (produto) {
        await page.getByRole('button', { name: 'Produtos', exact: true }).click()
        await page.getByRole('button', { name: '+ Novo produto', exact: true }).click()
        await page.getByLabel('Nome', { exact: true }).fill('Creme UX-03')
        await page.getByRole('button', { name: '+ Nova categoria', exact: true }).click()
        await page.getByLabel('Nome da categoria', { exact: true }).fill('Cuidados')
        await page.getByRole('button', { name: 'Usar esta categoria', exact: true }).click()
        await page.getByLabel('Preço de venda', { exact: true }).fill('3335')
        await page.getByRole('button', { name: 'Salvar', exact: true }).click()
        await page.locator('[data-produto-id]').click()
        await page.getByRole('button', { name: 'Ver estoque ›', exact: true }).click()
        await page.getByRole('button', { name: 'Anotar estoque inicial', exact: true }).click()
        await page.getByLabel('Total contado', { exact: true }).fill('3')
        await page.getByRole('button', { name: 'Pronto', exact: true }).click()
        await page.getByRole('button', { name: 'Voltar', exact: true }).click()
        await page.getByRole('button', { name: 'Voltar', exact: true }).click()
      }
      await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
      await page.getByLabel('Nome', { exact: true }).fill('Cliente UX-03')
      await page.getByRole('button', { name: 'Pronto', exact: true }).click()
      await page.getByRole('button', { name: 'Vender fiado', exact: true }).click()
      await conferirRotulos(page)
      await page.screenshot({ path: info.outputPath('itens-vazios.png'), fullPage: true })
      const item = page.getByLabel('Item 1', { exact: true })
      const preco = page.getByLabel('Preço unitário 1', { exact: true })
      const segundoPreco = page.getByLabel('Preço unitário 2', { exact: true })
      await page.getByLabel('Item 2', { exact: true }).fill('Amostra UX-03')
      await segundoPreco.fill('0')
      await expect(segundoPreco).toHaveValue('0,00')
      await segundoPreco.press('Backspace')
      await expect(segundoPreco).toHaveValue('')
      await expect(segundoPreco).toHaveAccessibleDescription('Falta o preço de um item')
      await segundoPreco.fill('0')
      if (produto) {
        await page.getByRole('button', { name: 'Escolher produto', exact: true }).first().click()
        await page.locator('[data-escolher-produto]').click()
        await expect(preco).toHaveValue('33,35')
        await page.getByLabel('Quantidade 1', { exact: true }).fill('3')
        await expect(page.getByLabel('Entregue agora 1', { exact: true })).toHaveValue('3')
        await page.getByLabel('Entregue agora 1', { exact: true }).fill('2')
        await expect(page.locator('[data-item-venda="0"]')).toContainText('Disponível: 3 · A entregar: 1')
      } else {
        await item.fill('Avulso UX-03')
        for (const [digito, esperado] of [['5', '0,05'], ['2', '0,52'], ['7', '5,27'], ['0', '52,70']]) {
          await preco.press(digito!)
          await expect(preco).toHaveValue(esperado!)
        }
        await preco.fill('3335')
      }
      // Abrir e voltar da escolha não pode apagar nenhum dos itens já preenchidos.
      await page.locator('[data-item-venda="0"]').getByRole('button', { name: produto ? 'Mudar produto' : 'Escolher produto', exact: true }).click()
      await page.getByRole('button', { name: 'Voltar aos itens', exact: true }).click()
      await expect(item).toHaveValue(produto ? 'Creme UX-03' : 'Avulso UX-03')
      await expect(preco).toHaveValue('33,35')
      await expect(segundoPreco).toHaveValue('0,00')
      await page.getByRole('button', { name: 'Dar desconto', exact: true }).click()
      await page.getByLabel('Desconto', { exact: true }).fill('5')
      await page.getByRole('button', { name: '2×', exact: true }).click()
      await conferirRotulos(page)
      await expect(page.locator('strong').filter({ hasText: produto ? 'R$ 100,00' : 'R$ 33,30' })).toBeVisible()
      await page.screenshot({ path: info.outputPath('itens-preenchidos.png'), fullPage: true })
      await page.getByRole('button', { name: 'Pronto', exact: true }).click()
      await expect(page.getByText(produto ? 'Agora deve R$ 100,00' : 'Agora deve R$ 33,30', { exact: true })).toBeVisible()
      const antes = await retrato(page)
      const venda = antes.lancamentos[0]!
      expect(venda.itens.map(i => [i.precoUnitario, i.quantidade, i.preco])).toEqual([[3335n, produto ? 3 : 1, produto ? 10005n : 3335n], [0n, 1, 0n]])
      expect(venda.pagamento === 'fiado' && venda.parcelas.map(p => p.valor)).toEqual(produto ? [5000n, 5000n] : [1665n, 1665n])
      expect(venda.desconto).toBe(5n)
      expect(antes.movimentos.filter(m => m.tipo === 'entrega').map(m => [m.itemId, m.quantidade])).toEqual(produto ? [[venda.itens[0]!.id, 2]] : [])
      await page.reload()
      await ampliar()
      expect(await retrato(page)).toEqual(antes)
      await page.getByRole('button', { name: /^Cliente UX-03/ }).click()
      await page.getByRole('button').filter({ hasText: produto ? 'Creme UX-03' : 'Avulso UX-03' }).click()
      await page.getByRole('button', { name: 'Corrigir anotação', exact: true }).click()
      await expect(item).toHaveValue(produto ? 'Creme UX-03' : 'Avulso UX-03')
      await expect(preco).toHaveValue('33,35')
      await expect(segundoPreco).toHaveValue('0,00')
      await expect(page.getByLabel('Quantidade 1', { exact: true })).toHaveValue(produto ? '3' : '1')
      await expect(page.getByLabel('Desconto', { exact: true })).toHaveValue('0,05')
      await conferirRotulos(page)
      await preco.fill('3355')
      await conferirRotulos(page)
      await segundoPreco.focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      await expect(segundoPreco).toBeFocused()
      const foco = await segundoPreco.boundingBox(), rodape = await page.locator('.rodape-acao').boundingBox()
      expect(foco!.y).toBeGreaterThanOrEqual(0)
      expect(foco!.y + foco!.height).toBeLessThanOrEqual(rodape!.y)
      await page.screenshot({ path: info.outputPath('itens-correcao.png'), fullPage: true })
      await page.getByRole('button', { name: 'Pronto', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Cliente UX-03', exact: true })).toBeVisible()
      await expect(page.getByText(produto ? 'R$ 100,60' : 'R$ 33,50', { exact: true }).first()).toBeVisible()
      const depois = await retrato(page)
      const corrigida = depois.lancamentos.at(-1)!
      expect(corrigida.itens.map(i => [i.precoUnitario, i.quantidade, i.preco])).toEqual([[3355n, produto ? 3 : 1, produto ? 10065n : 3355n], [0n, 1, 0n]])
      expect(corrigida.pagamento === 'fiado' && corrigida.parcelas).toEqual(venda.pagamento === 'fiado' && venda.parcelas.map(p => ({ ...p, valor: produto ? 5030n : 1675n })))
      expect(corrigida.itens.map(i => [i.id, i.produtoId, i.descricao])).toEqual(venda.itens.map(i => [i.id, i.produtoId, i.descricao]))
      expect(corrigida.data).toBe(venda.data)
      expect(corrigida.desconto).toBe(5n)
      expect(depois.movimentos).toEqual(antes.movimentos)
      await page.reload()
      await ampliar()
      expect(await retrato(page)).toEqual(depois)
      await page.getByRole('button', { name: /^Cliente UX-03/ }).click()
      await expect(page.getByText(produto ? 'R$ 100,60' : 'R$ 33,50', { exact: true }).first()).toBeVisible()
      expect(erros).toEqual([])
    })
  }
}

async function conferirRotulos(page: Page) {
  for (const numero of [1, 2]) {
    const linha = page.locator(`[data-item-venda="${numero - 1}"]`)
    for (const texto of [`Item ${numero}`, `Preço unitário ${numero}`]) {
      const campo = linha.getByRole('textbox', { name: texto, exact: true })
      const rotulo = linha.locator('label').filter({ hasText: new RegExp(`^${texto}$`) })
      await expect(rotulo).toBeVisible()
      await expect(campo).toHaveAccessibleName(texto)
      expect(await rotulo.getAttribute('for')).toBe(await campo.getAttribute('id'))
      await rotulo.click()
      await expect(campo).toBeFocused()
      const caixa = await campo.boundingBox()
      expect(caixa!.width).toBeGreaterThanOrEqual(44)
      expect(caixa!.height).toBeGreaterThanOrEqual(52)
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  const fora = await page.locator('[data-item-venda] label').evaluateAll(rotulos => rotulos.flatMap(rotulo => {
    const faixa = document.createRange(); faixa.selectNodeContents(rotulo)
    const caixa = rotulo.getBoundingClientRect()
    return [...faixa.getClientRects()].filter(r => r.left < Math.max(0, caixa.left) - 1 || r.right > Math.min(innerWidth, caixa.right) + 1).map(() => rotulo.textContent)
  }))
  expect(fora, 'Cada rótulo cabe no seu campo sem avançar sobre o seguinte').toEqual([])
}

async function retrato(page: Page) {
  return page.evaluate(() => new Promise<Record<string, unknown[]> & { lancamentos: Venda[]; movimentos: MovimentoEstoque[] }>((resolver, rejeitar) => {
    const abertura = indexedDB.open('controle-fiado')
    abertura.onerror = () => rejeitar(abertura.error)
    abertura.onsuccess = () => {
      const db = abertura.result, tx = db.transaction([...db.objectStoreNames], 'readonly')
      const consultas = [...db.objectStoreNames].map(nome => [nome, tx.objectStore(nome).getAll()] as const)
      tx.oncomplete = () => {
        resolver({ ...Object.fromEntries(consultas.map(([nome, c]) => [nome, c.result])),
          lancamentos: consultas.find(([nome]) => nome === 'lancamentos')![1].result,
          movimentos: consultas.find(([nome]) => nome === 'movimentos')![1].result })
        db.close()
      }
      tx.onerror = () => { rejeitar(tx.error); db.close() }
    }
  }))
}
