import { expect, test, type Page, type TestInfo } from '@playwright/test'

type Retrato = Record<string, Record<string, unknown>[]> & {
  clientes: Record<string, unknown>[]
  lancamentos: Record<string, unknown>[]
  fila: Record<string, unknown>[]
}

const avisoParcial = 'A fichinha já foi criada, mas o saldo anterior não foi anotado. Confira os dados e tente de novo.'
const cenarios = [
  { nome: '320 claro', largura: 320, altura: 812, tema: 'light', ampliado: false },
  { nome: '375 escuro', largura: 375, altura: 812, tema: 'dark', ampliado: false },
  { nome: '1280 claro', largura: 1280, altura: 812, tema: 'light', ampliado: false },
  { nome: '320 claro ampliado', largura: 320, altura: 812, tema: 'light', ampliado: true },
  { nome: '375 escuro ampliado', largura: 375, altura: 812, tema: 'dark', ampliado: true },
  { nome: '320 escuro ampliado baixo', largura: 320, altura: 480, tema: 'dark', ampliado: true },
] as const

for (const c of cenarios) {
  for (const falha of ['recusa', 'aborto'] as const) {
    test(`V-01 ${c.nome}: ${falha} do saldo após cadastro, recuperação offline`, async ({ page, context }, info) => {
      const erros: string[] = []
      page.on('pageerror', erro => erros.push(erro.message))
      await page.setViewportSize({ width: c.largura, height: c.altura })
      await page.emulateMedia({ colorScheme: c.tema })
      await page.clock.setFixedTime('2026-11-04T12:00:00Z')
      await page.goto('/')
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
      await page.reload()
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
      if (c.ampliado) await page.addStyleTag({ content: 'html { font-size: 200%; } body { font-size: 36px; }' })
      await context.setOffline(true)

      // Exercita os dois destinos vigentes do cadastro (D-044/045).
      const pelaVenda = falha === 'aborto'
      if (pelaVenda) await page.getByRole('button', { name: 'Nova venda', exact: true }).click()
      await page.getByRole('button', { name: '+ Nova fichinha', exact: true }).click()
      await page.getByLabel('Nome', { exact: true }).fill('Cliente V-01')
      await page.getByLabel('Telefone', { exact: true }).fill('85 99999-0000')
      await page.getByLabel('Apelido', { exact: true }).fill('Vizinha da casa azul')
      await page.getByLabel('Observação', { exact: true }).fill('Saldo fictício para conferir recuperação')
      await page.getByLabel('Já me deve', { exact: true }).fill('8005')
      await page.getByLabel('Desde', { exact: true }).fill('2026-09-01')
      // O input nativo aceita ano de cinco dígitos; o domínio exige AAAA-MM-DD.
      // Provoca Resultado negativo real, sem mock de operação ou persistência (V-01).
      await page.getByLabel('Vence em', { exact: true }).fill(falha === 'recusa' ? '10000-01-10' : '2026-10-10')
      await page.getByRole('button', { name: '2×', exact: true }).click()
      await page.getByRole('button', { name: 'Mudar datas ou valores', exact: true }).click()
      await page.getByLabel('1ª valor', { exact: true }).fill('3005')
      await page.getByLabel('2ª valor', { exact: true }).fill('5000')
      const salvar = page.getByRole('button', { name: 'Pronto', exact: true })
      await expect(salvar).toBeEnabled()
      if (falha === 'aborto') await abortarSaldo(page)
      await salvar.click()
      await expect.poll(async () => (await retrato(page)).clientes.length).toBe(1)
      const parcial = await retrato(page)
      expect(parcial.lancamentos).toEqual([])
      expect(parcial.fila).toHaveLength(1)
      expect(parcial.fila[0]).toMatchObject({ tabela: 'clientes', registroId: parcial.clientes[0]!.id })
      await info.attach('base-apos-falha.json', { body: JSON.stringify(parcial, null, 2), contentType: 'application/json' })
      await expect(page.getByRole('alert')).toHaveText(avisoParcial)
      await expect(page.getByRole('heading', { name: 'Nova fichinha', exact: true })).toBeVisible()
      await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Cliente V-01')
      await expect(page.getByLabel('Telefone', { exact: true })).toHaveValue('85 99999-0000')
      await expect(page.getByLabel('Apelido', { exact: true })).toHaveValue('Vizinha da casa azul')
      await expect(page.getByLabel('Observação', { exact: true })).toHaveValue('Saldo fictício para conferir recuperação')
      await expect(page.getByLabel('Já me deve', { exact: true })).toHaveValue('80,05')
      await expect(page.getByLabel('Desde', { exact: true })).toHaveValue('2026-09-01')
      await expect(page.getByRole('button', { name: '2×', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByLabel('1ª valor', { exact: true })).toHaveValue('30,05')
      await expect(page.getByLabel('2ª valor', { exact: true })).toHaveValue('50,00')
      await conferirAvisoInteiro(page, info)
      await page.screenshot({ path: info.outputPath('formulario-preservado.png'), fullPage: true })

      // Repetir a falha não pode criar outra cliente nem uma dívida sem confirmação.
      if (falha === 'aborto') await abortarSaldo(page)
      await salvar.click()
      await expect(salvar).toBeEnabled()
      await expect(page.getByRole('alert')).toHaveText(avisoParcial)
      const repetida = await retrato(page)
      expect(repetida).toEqual(parcial)
      expect(repetida.clientes).toHaveLength(1)
      expect(repetida.clientes[0]!.id).toBe(parcial.clientes[0]!.id)
      expect(repetida.lancamentos).toEqual([])
      expect(repetida.fila).toHaveLength(1)

      // Os quatro dados continuam editáveis por RF-01, com o mesmo id (D-050).
      await page.getByLabel('Nome', { exact: true }).fill('Cliente V-01 corrigida')
      await page.getByLabel('Telefone', { exact: true }).fill('85 98888-1111')
      await page.getByLabel('Apelido', { exact: true }).fill('Casa verde')
      await page.getByLabel('Observação', { exact: true }).fill('Conferido')
      if (falha === 'recusa') {
        await page.getByLabel('Vence em', { exact: true }).fill('2026-10-10')
        await page.getByLabel('1ª vence em', { exact: true }).fill('2026-10-12')
        await page.getByLabel('2ª vence em', { exact: true }).fill('2026-11-15')
      }
      await page.getByLabel('2ª valor', { exact: true }).focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      await expect(page.getByLabel('2ª valor', { exact: true })).toBeFocused()
      const campo = await page.getByLabel('2ª valor', { exact: true }).boundingBox()
      const rodape = await page.locator('.rodape-acao').boundingBox()
      expect(campo!.y).toBeGreaterThanOrEqual(0)
      expect(campo!.y + campo!.height).toBeLessThanOrEqual(rodape!.y)
      await conferirAlcance(page, salvar)
      await page.screenshot({ path: info.outputPath('recuperacao.png') })
      // Dois eventos no mesmo turno exercitam a guarda antes da próxima renderização.
      await salvar.evaluate(botao => {
        if (!(botao instanceof HTMLButtonElement)) throw new Error('Pronto precisa ser um botão')
        botao.click()
        botao.click()
      })
      await expect(page.getByRole('heading', { name: pelaVenda ? 'O que Cliente V-01 corrigida levou' : 'Cliente V-01 corrigida', exact: true })).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
      const concluida = await retrato(page)
      expect(concluida.clientes).toHaveLength(1)
      expect(concluida.clientes[0]).toMatchObject({ id: parcial.clientes[0]!.id, nome: 'Cliente V-01 corrigida', telefone: '85 98888-1111', apelido: 'Casa verde', observacao: 'Conferido' })
      expect(concluida.lancamentos).toHaveLength(1)
      expect(concluida.lancamentos[0]).toMatchObject({
        tipo: 'saldo-anterior', clienteId: parcial.clientes[0]!.id, data: '2026-09-01',
        parcelas: [
          { valor: '3005', vencimento: falha === 'recusa' ? '2026-10-12' : '2026-10-10' },
          { valor: '5000', vencimento: falha === 'recusa' ? '2026-11-15' : '2026-11-10' },
        ],
      })
      expect(concluida.fila).toHaveLength(2)
      expect(concluida.fila[1]).toMatchObject({ tabela: 'lancamentos', registroId: concluida.lancamentos[0]!.id })
      for (const tabela of Object.keys(concluida).filter(t => !['clientes', 'lancamentos', 'fila'].includes(t))) expect(concluida[tabela]).toEqual(parcial[tabela])
      await page.reload()
      expect(await retrato(page)).toEqual(concluida)
      await page.getByRole('button', { name: /^Cliente V-01 corrigida/ }).click()
      await expect(page.locator('p').filter({ hasText: /^R\$ 80,05$/ })).toBeVisible()
      await expect(page.getByRole('button', { name: /Já devia/ })).toHaveCount(1)
      expect(await retrato(page)).toEqual(concluida)
      expect(erros).toEqual([])
    })
  }
}

async function abortarSaldo(page: Page) {
  // A cliente já foi confirmada em outra transação; aborta somente saldo + fila.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      const pedido = original.apply(this, args)
      if (this.name === 'lancamentos') {
        IDBObjectStore.prototype.put = original
        this.transaction.abort()
      }
      return pedido
    }
  })
}

async function conferirAlcance(page: Page, alvo: ReturnType<Page['getByRole']>) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  await alvo.scrollIntoViewIfNeeded()
  const caixa = await alvo.boundingBox()
  expect(caixa!.y).toBeGreaterThanOrEqual(0)
  expect(caixa!.y + caixa!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1)
}

async function conferirAvisoInteiro(page: Page, info: TestInfo) {
  const aviso = page.getByRole('alert')
  const linhas = await aviso.evaluate(el => {
    const trecho = document.createRange()
    trecho.selectNodeContents(el)
    return trecho.getClientRects().length
  })
  expect(linhas).toBeGreaterThan(0)
  // O kit permite rolar dentro do rodapé em janela baixa. Confere cada linha,
  // sem exigir que o alerta inteiro caiba ao mesmo tempo na metade da janela.
  for (let posicao = 0; posicao < linhas; posicao++) {
    const leitura = await aviso.evaluate((el, indice) => {
      const rodape = el.closest('.rodape-acao')!
      const trecho = document.createRange()
      trecho.selectNodeContents(el)
      const caixaDoRodape = rodape.getBoundingClientRect()
      rodape.scrollTop += trecho.getClientRects()[indice]!.top - caixaDoRodape.top - 8
      const caixa = trecho.getClientRects()[indice]!
      const alvo = document.elementFromPoint(caixa.left + caixa.width / 2, caixa.top + caixa.height / 2)
      return {
        esquerda: caixa.left, direita: caixa.right, topo: caixa.top, fim: caixa.bottom,
        topoDoRodape: caixaDoRodape.top, fimDoRodape: caixaDoRodape.bottom,
        acessivel: alvo !== null && el.contains(alvo),
      }
    }, posicao)
    expect(leitura.esquerda).toBeGreaterThanOrEqual(0)
    expect(leitura.direita).toBeLessThanOrEqual(page.viewportSize()!.width)
    expect(leitura.topo).toBeGreaterThanOrEqual(leitura.topoDoRodape)
    expect(leitura.fim).toBeLessThanOrEqual(leitura.fimDoRodape)
    expect(leitura.acessivel).toBe(true)
    if (posicao === 0 || posicao === linhas - 1) await page.screenshot({ path: info.outputPath(`resultado-parcial-${posicao === 0 ? 'inicio' : 'fim'}.png`) })
  }
}

async function retrato(page: Page) {
  return page.evaluate(() => new Promise<Retrato>((resolver, rejeitar) => {
    const abertura = indexedDB.open('controle-fiado')
    abertura.onerror = () => rejeitar(abertura.error)
    abertura.onsuccess = () => {
      const db = abertura.result
      const tx = db.transaction([...db.objectStoreNames], 'readonly')
      const consultas = [...db.objectStoreNames].map(nome => [nome, tx.objectStore(nome).getAll()] as const)
      tx.oncomplete = () => {
        resolver(JSON.parse(JSON.stringify(Object.fromEntries(consultas.map(([nome, c]) => [nome, c.result])), (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v)))
        db.close()
      }
      tx.onerror = () => { rejeitar(tx.error); db.close() }
    }
  }))
}
