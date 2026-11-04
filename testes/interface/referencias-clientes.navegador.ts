import { expect, test, type Locator, type Page } from '@playwright/test'

// UX-04/RF-01: o final da referência precisa distinguir homônimas antes de abrir a ficha.
const prefixo = 'Vizinha da rua das Flores perto da padaria da esquina, ' + 'ReferenciaSemEspacos'.repeat(3)
const azul = { nome: 'Maria UX-04', referencia: `${prefixo}, casa azul`, digitos: '12345', valor: 'R$ 123,45', vencimento: '2026-10-01' }
const verde = { nome: 'Maria UX-04', referencia: `${prefixo}, casa verde`, digitos: '9007199254740993', valor: 'R$ 90.071.992.547.409,93', vencimento: '2026-10-20' }
const ana = { nome: 'Ana UX-04', referencia: '', digitos: '5555', valor: 'R$ 55,55', vencimento: '2026-12-01' }
const desativadas = ['amarela', 'violeta'].map(cor => ({
  nome: 'Maria UX-04', referencia: `${prefixo}, casa ${cor}`, digitos: '45678', valor: 'R$ 456,78', vencimento: '2026-09-01',
}))
const cenarios = [
  { nome: '320 claro', largura: 320, tema: 'light', ampliado: false },
  { nome: '375 escuro', largura: 375, tema: 'dark', ampliado: false },
  { nome: '1280 claro', largura: 1280, tema: 'light', ampliado: false },
  { nome: '320 claro ampliado', largura: 320, tema: 'light', ampliado: true },
  { nome: '375 escuro ampliado', largura: 375, tema: 'dark', ampliado: true },
  { nome: '320 escuro ampliado baixo', largura: 320, tema: 'dark', ampliado: true, altura: 480 },
] as const

for (const cenario of cenarios) {
  test(`UX-04 referências completas: ${cenario.nome}`, async ({ page, context }, info) => {
    const erros: string[] = []
    page.on('pageerror', erro => erros.push(erro.message))
    await page.setViewportSize({ width: cenario.largura, height: 'altura' in cenario ? cenario.altura : 812 })
    await page.emulateMedia({ colorScheme: cenario.tema })
    await page.clock.setFixedTime('2026-11-02T12:00:00Z')
    await page.goto('/')
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
    await page.reload()
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
    await context.setOffline(true)
    async function ampliar() {
      if (cenario.ampliado) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
    }
    function capturaDaTela(tela: string) {
      return async (final: string) => { await page.screenshot({ path: info.outputPath(`${tela}-${final}.png`) }) }
    }
    await ampliar()
    // Só operações reais da UI; não insere fixture nem simula persistência/transporte.
    for (const cliente of [verde, ana, azul, ...desativadas]) {
      await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
      await page.getByLabel('Nome', { exact: true }).fill(cliente.nome)
      await page.getByLabel('Apelido', { exact: true }).fill(cliente.referencia)
      await page.getByLabel('Já me deve', { exact: true }).fill(cliente.digitos)
      await page.getByLabel('Desde', { exact: true }).fill('2026-09-01')
      await page.getByLabel('Vence em', { exact: true }).fill(cliente.vencimento)
      await page.getByRole('button', { name: 'Pronto', exact: true }).click()
      await expect(page.getByRole('heading', { name: cliente.nome, exact: true })).toBeVisible()
      if (desativadas.includes(cliente)) {
        await page.getByRole('button', { name: 'Mudar dados', exact: true }).click()
        await page.getByRole('button', { name: 'Desativar a fichinha', exact: true }).click()
        await page.getByRole('button', { name: 'Sim, desativar', exact: true }).click()
      } else await voltar(page)
      await expect(page.getByRole('heading', { name: 'Fichinhas', exact: true })).toBeVisible()
    }
    const antes = await retrato(page)
    const busca = page.getByRole('searchbox', { name: 'Procurar pelo nome', exact: true })
    await expect(page.locator('ul > li')).toHaveCount(3)
    await expect(page.locator('ul > li').first()).toContainText(ana.nome)
    await busca.fill('mArIa')
    await expect(page.locator('ul > li')).toHaveCount(2)
    await page.screenshot({ path: info.outputPath('inicio.png'), fullPage: true })
    await conferirLista(page, [azul, verde], capturaDaTela('inicio'))
    for (const cliente of [azul, verde]) {
      // Toque no preenchimento lateral, fora dos textos: a linha inteira continua sendo alvo.
      await tocarNaLinha(linha(page, cliente.referencia))
      await expect(page.getByRole('heading', { name: cliente.nome, exact: true })).toBeVisible()
      await expect(page.locator('header').getByText(cliente.referencia, { exact: true })).toBeVisible()
      await expect(page.getByText(cliente.valor, { exact: true }).first()).toBeVisible()
      await voltar(page)
      await expect(busca).toHaveValue('mArIa')
      await expect(page.locator('ul > li')).toHaveCount(2)
    }
    // A busca sem acento encontra também o final da referência, e sobrevive à ida/volta.
    await busca.fill('CASA AZUL')
    await expect(page.locator('ul > li')).toHaveCount(1)
    await tocarNaLinha(linha(page, azul.referencia))
    await voltar(page)
    await expect(busca).toHaveValue('CASA AZUL')
    await busca.fill('mArIa')
    await page.getByRole('button', { name: 'Ver as fichinhas desativadas (2)', exact: true }).click()
    await expect(page.locator('ul > li')).toHaveCount(2)
    await page.screenshot({ path: info.outputPath('desativadas.png'), fullPage: true })
    await conferirLista(page, desativadas, capturaDaTela('desativadas'))
    await busca.fill('CASA VIOLETA')
    await expect(page.locator('ul > li')).toHaveCount(1)
    await tocarNaLinha(linha(page, desativadas[1]!.referencia))
    await expect(page.getByText('Fichinha desativada', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reativar a fichinha', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Vender fiado', exact: true })).toHaveCount(0)
    await voltar(page)
    // O alternador é local à abertura: voltar mostra ativas com a mesma busca, hoje sem resultado.
    await expect(busca).toHaveValue('CASA VIOLETA')
    await expect(page.getByText('Ninguém com esse nome', { exact: true })).toBeVisible()
    await busca.fill('mArIa')

    await page.getByRole('button', { name: 'Nova venda', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Para quem?', exact: true })).toBeVisible()
    await expect(busca).toHaveValue('')
    await expect(page.locator('ul > li')).toHaveCount(3)
    await expect(page.locator('ul > li').first()).toContainText(ana.nome)
    await busca.fill('referenciasemespacos')
    await expect(page.locator('ul > li')).toHaveCount(2)
    await expect(page.getByRole('button', { name: /Ver as fichinhas desativadas/ })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('para-quem.png'), fullPage: true })
    await conferirLista(page, [azul, verde], capturaDaTela('para-quem'))
    await tocarNaLinha(linha(page, verde.referencia))
    await expect(page.getByLabel('Item 1', { exact: true })).toBeVisible()
    await voltar(page)
    await expect(busca).toHaveValue('')
    await expect(page.locator('ul > li')).toHaveCount(3)
    await voltar(page)
    await expect(busca).toHaveValue('mArIa')

    await page.getByRole('button', { name: 'Quem está devendo', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Em atraso', exact: true })).toBeChecked()
    await expect(page.getByRole('radio', { name: 'Maior atraso', exact: true })).toBeChecked()
    await expect(page.locator('ul > li')).toHaveCount(2)
    await expect(page.locator('ul > li').first()).toContainText(azul.referencia)
    await page.screenshot({ path: info.outputPath('devedoras.png'), fullPage: true })
    await conferirLista(page, [azul, verde], capturaDaTela('devedoras'))
    await expect(page.getByRole('searchbox')).toHaveCount(0)
    await page.getByRole('radio', { name: 'Maior valor', exact: true }).check()
    await expect(page.locator('ul > li').first()).toContainText(verde.referencia)
    await tocarNaLinha(linha(page, verde.referencia))
    await expect(page.locator('header').getByText(verde.referencia, { exact: true })).toBeVisible()
    await voltar(page)
    await expect(page.getByRole('heading', { name: 'Quem está devendo', exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Maior atraso', exact: true })).toBeChecked()
    await page.getByRole('radio', { name: 'A vencer', exact: true }).check()
    await expect(page.locator('ul > li')).toHaveCount(1)
    await expect(page.locator('ul > li').first()).toContainText(ana.nome)
    await page.getByRole('radio', { name: 'Todas', exact: true }).check()
    await page.getByRole('radio', { name: 'Nome', exact: true }).check()
    await expect(page.locator('ul > li')).toHaveCount(3)
    await expect(page.locator('ul > li').first()).toContainText(ana.nome)
    expect(await retrato(page), 'Ler, buscar, selecionar e cancelar não alteram a base').toEqual(antes)
    await voltar(page)
    await expect(busca).toHaveValue('mArIa')

    // Confere o destino da seleção entre homônimas por uma venda real offline (RT-07).
    await page.getByRole('button', { name: 'Nova venda', exact: true }).click()
    await busca.fill('CASA VERDE')
    await expect(page.locator('ul > li')).toHaveCount(1)
    await tocarNaLinha(linha(page, verde.referencia))
    await page.getByLabel('Item 1', { exact: true }).fill('Avulso UX-04')
    await page.getByLabel('Preço unitário 1', { exact: true }).fill('123')
    await page.getByRole('button', { name: 'Pronto', exact: true }).click()
    await expect(page.getByText('Agora deve R$ 90.071.992.547.411,16', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Ver a fichinha', exact: true }).click()
    await expect(page.locator('header').getByText(verde.referencia, { exact: true })).toBeVisible()
    const depois = await retrato(page)
    await page.reload()
    await ampliar()
    expect(await retrato(page)).toEqual(depois)
    await busca.fill('CASA VERDE')
    await conferirLista(page, [{ ...verde, valor: 'R$ 90.071.992.547.411,16' }])
    await tocarNaLinha(linha(page, verde.referencia))
    await expect(page.locator('header').getByText(verde.referencia, { exact: true })).toBeVisible()
    await expect(page.getByText('R$ 90.071.992.547.411,16', { exact: true }).first()).toBeVisible()
    expect(erros).toEqual([])
  })
}

function linha(page: Page, referencia: string): Locator {
  return page.locator('ul > li > button').filter({ has: page.getByText(referencia, { exact: true }) })
}

async function voltar(page: Page) {
  await page.getByRole('button', { name: 'Voltar', exact: true }).click()
}

async function tocarNaLinha(botao: Locator) {
  await botao.evaluate(elemento => elemento.scrollIntoView({ block: 'start' }))
  // Dentro do preenchimento lateral, além da curva do canto mesmo com a fonte ampliada.
  await botao.click({ position: { x: 6, y: 40 } })
}

async function conferirLista(page: Page, clientes: readonly { referencia: string; valor: string }[], aoCapturar?: (final: string) => Promise<void>) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  for (const cliente of clientes) {
    const botao = linha(page, cliente.referencia)
    const referencia = botao.getByText(cliente.referencia, { exact: true })
    await expect(referencia).toBeVisible()
    await expect(botao).toContainText(cliente.valor)
    const medidas = await referencia.evaluate(elemento => {
      const nome = elemento.parentElement!, botao = nome.parentElement!, valor = nome.nextElementSibling!
      const r = elemento.getBoundingClientRect(), n = nome.getBoundingClientRect(), v = valor.getBoundingClientRect(), b = botao.getBoundingClientRect()
      const faixa = document.createRange(); faixa.selectNodeContents(elemento)
      const fora = [...faixa.getClientRects()].filter(f => f.left < Math.max(r.left, b.left, 0) - 1 || f.right > Math.min(r.right, b.right, innerWidth) + 1 || f.top < r.top - 1 || f.bottom > r.bottom + 1)
      const faixaDoValor = document.createRange(); faixaDoValor.selectNodeContents(valor)
      const valorFora = [...faixaDoValor.getClientRects()].filter(f => f.left < Math.max(v.left, b.left, 0) - 1 || f.right > Math.min(v.right, b.right, innerWidth) + 1 || f.top < b.top - 1 || f.bottom > b.bottom + 1)
      return {
        fora: fora.length, valorFora: valorFora.length,
        sobreposicao: n.left < v.right && n.right > v.left && n.top < v.bottom && n.bottom > v.top,
        altura: b.height, largura: b.width,
        fonteReferencia: parseFloat(getComputedStyle(elemento).fontSize), fonteNome: parseFloat(getComputedStyle(nome).fontSize),
        fonteValor: parseFloat(getComputedStyle(valor).fontSize), pesoReferencia: getComputedStyle(elemento).fontWeight, pesoNome: getComputedStyle(nome).fontWeight,
      }
    })
    expect(medidas.fora, `Referência integral desenhada: ${cliente.referencia}`).toBe(0)
    expect(medidas.valorFora, 'Valor integral dentro da linha').toBe(0)
    expect(medidas.sobreposicao, 'Nome/referência e valor não se sobrepõem').toBe(false)
    expect(medidas.altura).toBeGreaterThanOrEqual(60)
    expect(medidas.largura).toBeGreaterThanOrEqual(44)
    expect(medidas.fonteReferencia).toBeLessThan(medidas.fonteNome)
    expect(medidas.fonteReferencia).toBeLessThan(medidas.fonteValor)
    expect(medidas.pesoReferencia).toBe('400')
    expect(medidas.pesoNome).toBe('600')
    // Página inteira não prova alcance: o rodapé fixo pode ficar sobre parte da captura.
    for (const parte of ['referencia', 'valor'] as const) {
      const trechos = await referencia.evaluate((elemento, parte) => {
        const faixa = document.createRange()
        if (parte === 'valor') faixa.selectNode(elemento.parentElement!.nextElementSibling!.firstChild!)
        else {
          const texto = elemento.firstChild!
          faixa.selectNodeContents(elemento)
          faixa.setStart(texto, texto.textContent!.lastIndexOf('casa '))
        }
        const limite = document.querySelector('.rodape-acao')?.getBoundingClientRect().top ?? innerHeight
        window.scrollBy(0, faixa.getBoundingClientRect().bottom - (limite - 16))
        return [...faixa.getClientRects()].map(r => ({
          visivel: r.top >= 0 && r.bottom <= limite,
          alcancavel: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === elemento.closest('button'),
        }))
      }, parte)
      expect(trechos.length).toBeGreaterThan(0)
      expect(trechos.every(f => f.visivel && f.alcancavel), `${parte}: trecho completo alcançável acima do rodapé antes de abrir`).toBe(true)
      const final = cliente.referencia.slice(cliente.referencia.lastIndexOf('casa ')).replace(' ', '-')
      if (aoCapturar) await aoCapturar(`${final}${parte === 'valor' ? '-valor' : ''}`)
    }
  }
}

async function retrato(page: Page) {
  return page.evaluate(() => new Promise<Record<string, unknown[]>>((resolver, rejeitar) => {
    const abertura = indexedDB.open('controle-fiado')
    abertura.onerror = () => rejeitar(abertura.error)
    abertura.onsuccess = () => {
      const db = abertura.result, tx = db.transaction([...db.objectStoreNames], 'readonly')
      const consultas = [...db.objectStoreNames].map(nome => [nome, tx.objectStore(nome).getAll()] as const)
      tx.oncomplete = () => { resolver(Object.fromEntries(consultas.map(([nome, c]) => [nome, c.result]))); db.close() }
      tx.onerror = () => { rejeitar(tx.error); db.close() }
    }
  }))
}
