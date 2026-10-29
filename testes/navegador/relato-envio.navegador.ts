import { expect, test, type Page } from '@playwright/test'
import { abrirApp, cadastrar, entrar, pularSemUsuario, sair } from './apoio.ts'

async function retrato(page: Page) {
  return page.evaluate(async () => {
    const lab = window.laboratorio; if (!lab) throw new Error('Sem laboratório')
    const tabelas = ['clientes', 'lancamentos', 'fila', 'produtos', 'operacoes', 'movimentos', 'versoesEstoque', 'encerramentos', 'fotos']
    return JSON.stringify(await Promise.all(tabelas.map(async (nome) => [nome, await lab.banco.table(nome).toArray()])),
      (_, valor: unknown) => typeof valor === 'bigint' ? valor.toString() : valor)
  })
}

test('D-077 contato só após login e toque, falha offline preserva fila e WhatsApp recebe relato pronto', async ({ page, context }, info) => {
  pularSemUsuario()
  const erros: string[] = []; page.on('pageerror', (erro) => erros.push(erro.message))
  let consultas = 0
  page.on('request', (requisicao) => { if (requisicao.url().endsWith('/rpc/obter_contato_suporte')) consultas++ })
  await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page)
  const id = await cadastrar(page, 'Cliente privada do relato', '85999998888')
  await page.evaluate(async (registroId) => {
    const lab = window.laboratorio; if (!lab) throw new Error('Sem laboratório')
    await lab.banco.fila.where('registroId').equals(registroId).modify({ problema: {
      codigo: '23505', constraint: 'restricao-de-teste', mensagem: 'Erro de teste: "anotação" & vínculo? 🧪', em: '2026-10-26T12:00:00.000Z',
    } })
    await lab.sincronizacao.sincronizar()
  }, id)
  const aviso = page.getByRole('complementary', { name: 'Problema no envio', exact: true })
  await expect(aviso).toContainText('Entre na sua conta para relatar o problema.')
  expect(consultas).toBe(0)
  await entrar(page)
  await page.evaluate(async () => window.laboratorio?.sincronizacao.sincronizar())
  const botao = aviso.getByRole('button', { name: 'Relatar problema', exact: true })
  await expect(botao).toBeVisible()
  expect(consultas).toBe(0)
  expect(await page.content()).not.toContain('5511999999999')
  const antes = await retrato(page)
  await context.setOffline(true)
  let abriu = page.waitForEvent('popup')
  await botao.click()
  const falhou = await abriu
  await expect(aviso).toContainText('Confira a conexão e tente de novo.')
  await expect.poll(() => falhou.isClosed()).toBe(true)
  expect(await retrato(page)).toBe(antes)
  expect(await page.content()).not.toContain('5511999999999')
  await context.setOffline(false)
  await page.evaluate(async () => window.laboratorio?.sincronizacao.sincronizar())
  await context.route('https://wa.me/**', (rota) => rota.fulfill({ contentType: 'text/html', body: 'Destino WhatsApp interceptado' }))
  abriu = page.waitForEvent('popup')
  await botao.click()
  const destino = await abriu
  await destino.waitForURL('https://wa.me/**')
  const url = new URL(destino.url())
  expect(url.origin + url.pathname).toBe('https://wa.me/5511999999999')
  const texto = url.searchParams.get('text')!
  const relato: { versaoDoApp: string; problemas: { tabela: string; registroId: string; problema: { codigo: string; mensagem: string } }[] } = JSON.parse(texto.slice(texto.indexOf('{')))
  expect(relato.problemas).toHaveLength(1)
  expect(relato.problemas[0]).toMatchObject({ tabela: 'clientes', registroId: id, problema: { codigo: '23505', mensagem: 'Erro de teste: "anotação" & vínculo? 🧪' } })
  await expect(page.getByText(`versão ${relato.versaoDoApp}`, { exact: true })).toBeVisible()
  expect(texto).not.toContain('Cliente privada do relato'); expect(texto).not.toContain('85999998888')
  await destino.close()
  expect(await retrato(page)).toBe(antes)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('5511999999999')
  await expect(aviso).not.toContainText(/23505|restricao-de-teste|SQLSTATE/)
  await botao.focus(); await expect(botao).toBeFocused()
  const tamanho = await botao.boundingBox(); expect(tamanho?.width).toBeGreaterThanOrEqual(44); expect(tamanho?.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: info.outputPath('relato-autenticado.png') })
  await sair(page)
  await expect(aviso).toContainText('Entre na sua conta para relatar o problema.')
  await expect(botao).toHaveCount(0)
  expect(await page.content()).not.toContain('5511999999999')
  expect(consultas).toBeGreaterThanOrEqual(2)
  expect(erros).toEqual([])
})

test('sair da conta durante a consulta fecha a janela e não revela o contato na volta', async ({ page }) => {
  pularSemUsuario()
  await abrirApp(page)
  const id = await cadastrar(page, 'Cliente da saída durante relato', '')
  await page.evaluate(async (registroId) => {
    const lab = window.laboratorio; if (!lab) throw new Error('Sem laboratório')
    await lab.banco.fila.where('registroId').equals(registroId).modify({ problema: {
      codigo: '23505', mensagem: 'Recusa fictícia', em: '2026-10-26T12:00:00.000Z',
    } })
    await lab.sincronizacao.sincronizar()
  }, id)
  await entrar(page)
  const aviso = page.getByRole('complementary', { name: 'Problema no envio', exact: true })
  const botao = aviso.getByRole('button', { name: 'Relatar problema', exact: true })
  await expect(botao).toBeVisible()
  let liberar = () => {}, pronta = false, finalizou = false
  const pausa = new Promise<void>((resolver) => { liberar = resolver })
  // Consulta real autenticada; apenas a entrega da resposta à tela é atrasada para a disputa.
  await page.route('**/rpc/obter_contato_suporte', async (rota) => {
    try {
      const resposta = await rota.fetch(); pronta = true
      await pausa; await rota.fulfill({ response: resposta })
    } finally { finalizou = true }
  })
  try {
    const abriu = page.waitForEvent('popup')
    await botao.click()
    const janela = await abriu
    await expect.poll(() => pronta).toBe(true)
    await sair(page)
    await expect.poll(() => janela.isClosed()).toBe(true)
    liberar(); await expect.poll(() => finalizou).toBe(true)
    await expect(aviso).toContainText('Entre na sua conta para relatar o problema.')
    await expect(aviso.getByRole('link')).toHaveCount(0)
    expect(await page.content()).not.toContain('5511999999999')
  } finally { liberar() }
})
