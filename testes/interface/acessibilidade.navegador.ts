import { expect, test, type Page } from '@playwright/test'
import type { Lancamento } from '../../src/dominio/ficha.ts'

// RNF-03: casos de layout, sem nuvem. Não substituem RT-07–13 nem prova em aparelho real.
const cenarios = [
  { nome: 'estreito claro', largura: 320, tema: 'light', ampliado: false },
  { nome: 'celular escuro', largura: 375, tema: 'dark', ampliado: false },
  { nome: 'computador claro', largura: 1280, tema: 'light', ampliado: false },
  { nome: 'estreito com texto ampliado', largura: 320, tema: 'light', ampliado: true },
  { nome: 'celular escuro com texto ampliado', largura: 375, tema: 'dark', ampliado: true },
  { nome: 'janela baixa escura com texto ampliado', largura: 320, tema: 'dark', ampliado: true, altura: 480 },
] as const

for (const cenario of cenarios) {
  test(cenario.nome, async ({ page }, testInfo) => {
    const erros: string[] = []
    page.on('pageerror', (erro) => erros.push(erro.message))
    const altura = 'altura' in cenario ? cenario.altura : 812
    await page.setViewportSize({ width: cenario.largura, height: altura })
    await page.emulateMedia({ colorScheme: cenario.tema })
    await page.goto('/')
    if (cenario.ampliado) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
    await expect(page.getByText('Nenhuma fichinha ainda', { exact: true })).toBeVisible()
    await conferirRodape(page)
    await conferirLargura(page)

    await page.getByRole('button', { name: 'Produtos', exact: true }).click()
    await page.getByRole('button', { name: '+ Novo produto', exact: true }).click()
    for (const rotulo of ['Nome', 'Categoria', 'Classificação']) {
      const contraste = await page.getByLabel(rotulo, { exact: true }).evaluate((elemento) => {
        const estilo = getComputedStyle(elemento)
        function luminancia(cor: string): number {
          const canais = cor.match(/[\d.]+/g)?.slice(0, 3).map((canal) => {
            const normalizado = Number(canal) / 255
            return normalizado <= 0.04045 ? normalizado / 12.92 : ((normalizado + 0.055) / 1.055) ** 2.4
          }) ?? []
          return (canais[0] ?? 0) * 0.2126 + (canais[1] ?? 0) * 0.7152 + (canais[2] ?? 0) * 0.0722
        }
        const borda = luminancia(estilo.borderTopColor)
        const fundo = luminancia(estilo.backgroundColor)
        return (Math.max(borda, fundo) + 0.05) / (Math.min(borda, fundo) + 0.05)
      })
      expect.soft(contraste, `Contorno de ${rotulo}`).toBeGreaterThanOrEqual(3)
    }
    await page.screenshot({ path: testInfo.outputPath('campos.png') })
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()

    await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Cliente fictícia com nome comprido para conferir a leitura')
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await page.getByRole('button', { name: 'Vender fiado', exact: true }).click()
    await page.getByLabel('Item 1', { exact: true }).fill('Batom de teste')
    await page.getByLabel('Preço unitário 1', { exact: true }).fill('5000')
    await page.getByLabel('Item 2', { exact: true }).fill('Creme de teste')
    await page.getByLabel('Preço unitário 2', { exact: true }).fill('3000')
    for (const vezes of await page.getByRole('button', { name: /^[1-6]×$/ }).all()) {
      const tamanho = await vezes.boundingBox()
      expect.soft(tamanho?.width, 'Alvo da parcela').toBeGreaterThanOrEqual(44)
      expect.soft(tamanho?.height).toBeGreaterThanOrEqual(44)
    }
    await conferirLargura(page)
    // Tab deve deixar visível tanto a opção nativa quanto o botão de ação principal.
    await page.getByRole('radio', { name: 'Fiado', exact: true }).focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('radio', { name: 'Fiado', exact: true })).toBeFocused()
    const foco = await page.getByRole('radio', { name: 'Fiado', exact: true }).evaluate((elemento) => {
      const rotulo = elemento.closest('label')
      return rotulo ? getComputedStyle(rotulo).outlineStyle : 'none'
    })
    expect.soft(foco).not.toBe('none')
    await conferirFocoVisivel(page)
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await page.getByRole('button', { name: 'Ver a fichinha', exact: true }).click()
    // UX-01: conferir a ficha aberta; a confirmação seguinte não expõe a mesma linha rígida.
    await conferirLargura(page)
    await conferirRodape(page)
    await conferirTextoDaFicha(page)
    await page.screenshot({ path: testInfo.outputPath('ficha.png'), fullPage: true })
    await page.getByRole('button', { name: 'Abater valor', exact: true }).click()
    await page.getByRole('textbox', { name: 'Quanto pagou', exact: true }).fill('7995')
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Considerar pago', exact: true })).toBeVisible()
    await expect(page.getByText('Ainda deve R$ 0,05', { exact: true })).toBeVisible()
    await expect(page.locator('.rodape-acao button')).toHaveCount(3)
    await conferirRodape(page)
    await conferirLargura(page)
    // Conferir pelo teclado o último conteúdo antes do rodapé, inclusive quando há rolagem.
    await page.getByRole('link', { name: 'Mandar o recibo no WhatsApp', exact: true }).focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await conferirFocoVisivel(page)
    await page.screenshot({ path: testInfo.outputPath('confirmacao.png') })
    // Em texto ampliado o próprio rodapé rola: o terceiro botão precisa ficar alcançável.
    await page.getByRole('button', { name: 'Voltar para o começo', exact: true }).focus()
    const ultimoBotao = await page.getByRole('button', { name: 'Voltar para o começo', exact: true }).boundingBox()
    expect.soft(ultimoBotao).not.toBeNull()
    expect.soft((ultimoBotao?.y ?? -1) + (ultimoBotao?.height ?? 0)).toBeLessThanOrEqual(altura)
    await page.getByRole('button', { name: 'Considerar pago', exact: true }).click()
    await expect(page.locator('.rodape-acao button')).toHaveCount(2)
    await expect(page.getByText('Não deve mais nada', { exact: true })).toBeVisible()
    await conferirRodape(page)
    await page.getByRole('button', { name: 'Voltar para o começo', exact: true }).click()
    await page.getByRole('button', { name: 'Produtos', exact: true }).click()
    await page.getByRole('button', { name: 'No mínimo', exact: true }).click()
    await expect(page.getByText('Nenhum produto no mínimo', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--altura-rodape'))).toBe('')
    expect(erros).toEqual([])
  })

  test(`UX-01 valores extensos: ${cenario.nome}`, async ({ page, context }, info) => {
    const erros: string[] = []
    page.on('pageerror', (erro) => erros.push(erro.message))
    await page.setViewportSize({ width: cenario.largura, height: 'altura' in cenario ? cenario.altura : 812 })
    await page.emulateMedia({ colorScheme: cenario.tema })
    await page.goto('/')
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload()
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
    await context.setOffline(true)
    async function ampliar(): Promise<void> {
      if (cenario.ampliado) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
    }
    await ampliar()
    await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
    const nome = 'Cliente fictícia para valores extensos'
    await page.getByLabel('Nome', { exact: true }).fill(nome)
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await expect(page.getByText('Não deve nada', { exact: true })).toBeVisible()
    await conferirTextoDaFicha(page)
    await conferirLargura(page)
    await page.getByRole('button', { name: 'Vender fiado', exact: true }).click()
    const descricao = 'Creme de teste com descrição longa para reconhecer a compra ' + 'ReferênciaSemEspaços'.repeat(5)
    await page.getByLabel('Item 1', { exact: true }).fill(descricao)
    await page.getByLabel('Preço unitário 1', { exact: true }).fill('9007199254740993')
    await expect(page.getByLabel('Preço unitário 1', { exact: true })).toHaveValue('90.071.992.547.409,93')
    await page.getByLabel('Item 2', { exact: true }).fill('Amostra de teste')
    await page.getByLabel('Preço unitário 2', { exact: true }).fill('7')
    await page.getByRole('button', { name: 'Dar desconto', exact: true }).click()
    await page.getByLabel('Desconto', { exact: true }).fill('5')
    await page.getByRole('button', { name: '2×', exact: true }).click()
    const total = 'R$ 90.071.992.547.409,95'
    await expect(page.locator('strong').filter({ hasText: total })).toHaveText(total)
    await conferirLargura(page)
    await page.screenshot({ path: info.outputPath('venda-extensa.png'), fullPage: true })
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await expect(page.getByText(`Agora deve ${total}`, { exact: true })).toBeVisible()
    const aposVenda = await lerLancamentos(page)
    const venda = aposVenda.find((l) => l.tipo === 'venda')
    expect(venda?.tipo === 'venda' && venda.pagamento === 'fiado' && venda.parcelas.map((p) => p.valor)).toEqual([4503599627370500n, 4503599627370495n])
    await page.getByRole('button', { name: 'Ver a fichinha', exact: true }).click()
    await conferirLargura(page)
    await conferirTextoDaFicha(page)
    await page.screenshot({ path: info.outputPath('ficha-extensa.png'), fullPage: true })
    // RT-07 no alcance visual alterado: recarga offline, lista e ficha relidas sem perder centavos/parcelas.
    await page.reload()
    await ampliar()
    expect(await lerLancamentos(page)).toEqual(aposVenda)
    const fichaNaLista = page.getByRole('button').filter({ hasText: nome })
    await expect(fichaNaLista).toContainText(total)
    await conferirLargura(page)
    await page.screenshot({ path: info.outputPath('lista-extensa.png'), fullPage: true })
    await fichaNaLista.click()
    const cartao = page.getByText('Deve', { exact: true }).locator('..')
    await expect(cartao).toContainText(total)
    await expect(cartao).toContainText('R$ 45.035.996.273.705,00')
    await conferirTextoDaFicha(page)
    await conferirRodape(page)
    const ultimaAcao = page.getByRole('button', { name: 'Anotar o que já devia', exact: true })
    await ultimaAcao.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(ultimaAcao).toBeFocused()
    await conferirFocoVisivel(page)
    await page.screenshot({ path: info.outputPath('ficha-rodape.png') })
    const linhaDaVenda = page.getByRole('button').filter({ hasText: descricao })
    await expect(linhaDaVenda).toContainText(total)
    const alvo = await linhaDaVenda.boundingBox()
    expect(alvo?.height).toBeGreaterThanOrEqual(44)
    await linhaDaVenda.click()
    await expect(page.getByRole('button', { name: 'Corrigir anotação', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    expect(await lerLancamentos(page)).toEqual(aposVenda)
    await page.getByRole('button', { name: 'Abater valor', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Quanto pagou', exact: true })).toHaveValue('45.035.996.273.705,00')
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click()
    await expect(page.getByText('Ainda deve R$ 45.035.996.273.704,95', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Ver a fichinha', exact: true }).click()
    await conferirTextoDaFicha(page)
    await conferirLargura(page)
    await page.getByRole('button', { name: 'Abater valor', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Quanto pagou', exact: true })).toHaveValue('45.035.996.273.704,95')
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click()
    await page.getByRole('button', { name: 'Ver a fichinha', exact: true }).click()
    await expect(page.getByText('Está tudo pago', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Abater valor', exact: true })).toHaveCount(0)
    await conferirLargura(page)
    await conferirTextoDaFicha(page)
    await page.screenshot({ path: info.outputPath('ficha-paga.png'), fullPage: true })
    const aposRecebimentos = await lerLancamentos(page)
    expect(aposRecebimentos.filter((l) => l.tipo === 'venda')).toEqual([venda])
    expect(aposRecebimentos.filter((l) => l.tipo === 'recebimento').map((l) => l.valor).sort()).toEqual([4503599627370495n, 4503599627370500n])
    await page.reload()
    await ampliar()
    expect(await lerLancamentos(page)).toEqual(aposRecebimentos)
    await page.getByRole('button').filter({ hasText: nome }).click()
    await expect(page.getByText('Está tudo pago', { exact: true })).toBeVisible()
    await conferirLargura(page)
    await conferirTextoDaFicha(page)
    expect(erros).toEqual([])
  })
}

// Mede os fragmentos efetivamente desenhados: esconder o excesso não satisfaz UX-01.
async function conferirTextoDaFicha(page: Page): Promise<void> {
  const fora = await page.locator('main > ul, main > div').evaluateAll((regioes) => {
    const falhas: string[] = []
    for (const regiao of regioes) {
      const textos = document.createTreeWalker(regiao, NodeFilter.SHOW_TEXT)
      while (textos.nextNode()) {
        const no = textos.currentNode
        if (!no.textContent?.trim()) continue
        const faixa = document.createRange()
        faixa.selectNodeContents(no)
        if ([...faixa.getClientRects()].some((r) => r.left < -1 || r.right > innerWidth + 1)) falhas.push(no.textContent)
      }
    }
    return falhas
  })
  expect.soft(fora, 'Textos integrais da ficha dentro da largura visível').toEqual([])
}

async function lerLancamentos(page: Page): Promise<Lancamento[]> {
  return page.evaluate(() => new Promise<Lancamento[]>((resolver, rejeitar) => {
    const abertura = indexedDB.open('controle-fiado')
    abertura.onerror = () => rejeitar(abertura.error)
    abertura.onsuccess = () => {
      const banco = abertura.result
      const transacao = banco.transaction('lancamentos', 'readonly')
      const consulta = transacao.objectStore('lancamentos').getAll()
      transacao.oncomplete = () => { resolver(consulta.result); banco.close() }
      transacao.onerror = () => { rejeitar(transacao.error); banco.close() }
    }
  }))
}

async function conferirLargura(page: Page): Promise<void> {
  const dimensoes = await page.evaluate(() => ({ largura: document.documentElement.clientWidth, conteudo: document.documentElement.scrollWidth }))
  expect.soft(dimensoes.conteudo).toBeLessThanOrEqual(dimensoes.largura)
}

async function conferirRodape(page: Page): Promise<void> {
  await expect.poll(async () => page.locator('.tela').evaluate((tela) => {
    const rodape = tela.querySelector('.rodape-acao')
    return Number.parseFloat(getComputedStyle(tela).paddingBottom) - (rodape?.getBoundingClientRect().height ?? 0)
  })).toBeGreaterThanOrEqual(16)
}

async function conferirFocoVisivel(page: Page): Promise<void> {
  const posicao = await page.evaluate(() => {
    const ativo = document.activeElement
    const rodape = document.querySelector('.rodape-acao')
    const alvo = ativo?.getBoundingClientRect()
    return { topo: alvo?.top ?? -1, base: alvo?.bottom ?? -1, limite: rodape?.getBoundingClientRect().top ?? innerHeight }
  })
  expect.soft(posicao.topo).toBeGreaterThanOrEqual(0)
  expect.soft(posicao.base).toBeLessThanOrEqual(posicao.limite - 3)
}
