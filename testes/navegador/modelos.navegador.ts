import { expect, test, type Page } from '@playwright/test'
import { abrirApp, entrar, recarregar, sincronizar } from './apoio.ts'

async function abrirEditor(page: Page) { await page.getByRole('button', { name: 'Mensagens do WhatsApp ›', exact: true }).click(); await expect(page.getByLabel('Texto da mensagem', { exact: true })).toBeVisible() }
async function previa(page: Page, texto: string, acao: string) {
  await expect(page.locator('[data-mensagem-previa]')).toHaveText(texto)
  const href = await page.getByRole('link', { name: acao, exact: true }).getAttribute('href')
  expect(href).not.toBeNull(); expect(new URL(href ?? '').searchParams.get('text')).toBe(texto)
  expect(new URL(href ?? '').hostname).toBe('wa.me')
}

test('E-36: quatro mensagens com valores relidos, edição, guardas e recarga offline; nenhum envio automático', async ({ page, context }, info) => {
  await page.setViewportSize({ width: 375, height: 812 }); await abrirApp(page); await context.setOffline(true)
  const nomes = ['Dona Rosa Exemplo', 'Seu João Exemplo']
  await page.evaluate(async (nomes) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    for (const [i, nome] of nomes.entries()) {
      const c = await l.cadastrarCliente({ nome, telefone: '85999999999' }); if (!c.ok) throw new Error(c.motivo)
      const v = await l.lancarVendaFiado({ clienteId: c.valor.id, data: '2026-09-01', itens: [{ descricao: 'Item fictício', preco: 10000n }],
        parcelas: [{ vencimento: i === 0 ? '2026-09-01' : '2050-10-30', valor: 10000n }] })
      if (!v.ok) throw new Error(v.motivo)
    }
  }, nomes)
  await abrirEditor(page)
  const campo = page.getByLabel('Texto da mensagem', { exact: true }), guardar = page.getByRole('button', { name: 'Guardar os textos', exact: true })
  await campo.fill(''); await expect(guardar).toBeDisabled()
  await campo.fill('Texto {telefone}'); await expect(guardar).toBeDisabled()
  await campo.fill('Olá, '); await campo.press('End'); await page.getByRole('button', { name: 'Nome', exact: true }).click()
  await expect(campo).toHaveValue('Olá, {nome}'); await expect(page.locator('[data-modelo-previa]')).toHaveText('Olá, Maria')
  for (const [s, texto] of [
    ['cobranca-vencida', '{nome}: falta {valor}, venceu em {vencimento}.'],
    ['cobranca-a-vencer', 'A vencer: {nome}, {valor} em {vencimento}.'],
    ['recibo-com-saldo', '{nome}, recebi {valor}; faltam {saldo}.'],
    ['recibo-quitado', '{nome}, recebi {valor}; saldo {saldo}.'],
  ]) { await page.getByLabel('Mensagem', { exact: true }).selectOption(s ?? ''); await campo.fill(texto ?? '') }
  await guardar.click(); await expect(page.getByRole('status')).toContainText('Textos guardados neste aparelho.')
  await recarregar(page)
  await page.getByRole('button', { name: /Dona Rosa Exemplo/ }).click()
  await previa(page, 'Dona Rosa: falta R$ 100,00, venceu em 01/09.', 'Cobrar no WhatsApp')
  await page.getByRole('button', { name: 'Abater valor', exact: true }).click()
  await page.getByLabel('Quanto pagou', { exact: true }).fill('9995')
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click()
  await previa(page, 'Dona Rosa, recebi R$ 99,95; faltam R$ 0,05.', 'Mandar o recibo no WhatsApp')
  await page.getByRole('button', { name: 'Considerar pago', exact: true }).click()
  await previa(page, 'Dona Rosa, recebi R$ 99,95; saldo R$ 0,00.', 'Mandar o recibo no WhatsApp')
  await page.screenshot({ path: info.outputPath('recibo-quitado-375.png'), fullPage: true })
  await page.getByRole('button', { name: 'Voltar para o começo', exact: true }).click()
  await page.getByRole('button', { name: /Seu João Exemplo/ }).click()
  await previa(page, 'A vencer: Seu João, R$ 100,00 em 30/10.', 'Cobrar no WhatsApp')
  expect(context.pages()).toHaveLength(1)
})

test('E-36: rascunho de outra aba permanece, confirmação revalida e preferência restaura da nuvem', async ({ page, context, browser }, info) => {
  await abrirApp(page); await context.setOffline(true); await abrirEditor(page)
  const outraAba = await context.newPage(); await abrirApp(outraAba); await abrirEditor(outraAba)
  await page.getByLabel('Texto da mensagem', { exact: true }).fill('Texto da primeira aba')
  await outraAba.getByLabel('Texto da mensagem', { exact: true }).fill('Texto da segunda aba')
  await page.getByRole('button', { name: 'Guardar os textos', exact: true }).click()
  await outraAba.getByRole('button', { name: 'Guardar os textos', exact: true }).click()
  await expect(outraAba.getByRole('alert')).toContainText('Os textos mudaram')
  await expect(outraAba.getByLabel('Texto da mensagem', { exact: true })).toHaveValue('Texto da segunda aba')
  // Outra mudança entre aviso e confirmação tem de pedir nova conferência.
  await page.getByLabel('Texto da mensagem', { exact: true }).fill('Texto alterado novamente')
  await page.getByRole('button', { name: 'Guardar os textos', exact: true }).click()
  await outraAba.getByRole('button', { name: 'Guardar os meus quatro textos', exact: true }).click()
  await expect(outraAba.getByRole('alert')).toContainText('Texto alterado novamente')
  await outraAba.screenshot({ path: info.outputPath('concorrencia.png'), fullPage: true })
  await outraAba.getByRole('button', { name: 'Guardar os meus quatro textos', exact: true }).click()
  await expect(outraAba.getByRole('status')).toContainText('Textos guardados')
  await context.setOffline(false); await entrar(outraAba); await sincronizar(outraAba)
  const outro = await browser.newContext(), b = await outro.newPage()
  try {
    await abrirApp(b); await entrar(b); await sincronizar(b); await abrirEditor(b)
    await expect(b.getByLabel('Texto da mensagem', { exact: true })).toHaveValue('Texto da segunda aba')
    await outro.setOffline(true); await recarregar(b); await abrirEditor(b)
    await expect(b.getByLabel('Texto da mensagem', { exact: true })).toHaveValue('Texto da segunda aba')
  } finally { await outro.close(); await outraAba.close() }
})
