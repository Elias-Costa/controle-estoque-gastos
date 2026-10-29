import { expect, test, type Page } from '@playwright/test'
import { abrirApp, cadastrar, entrar, pularSemUsuario, sincronizar } from './apoio.ts'

async function lerVenda(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const lab = window.laboratorio; if (!lab) throw new Error('Sem laboratório')
    const venda = await lab.banco.lancamentos.get(id); if (!venda) throw new Error('Venda fictícia ausente')
    return { conteudo: JSON.stringify(venda, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v),
      saldo: String(lab.saldo(await lab.repositorio.lerFicha(venda.clienteId))),
      fila: await lab.banco.fila.where('registroId').equals(id).count() }
  }, id)
}

test('D-078 recusa real e descrição preenchida pela tela chegam a outro navegador com o mesmo id e saldo', async ({ page, context, browser }, info) => {
  pularSemUsuario()
  const erros: string[] = []; page.on('pageerror', (e) => erros.push(e.message))
  await abrirApp(page); await entrar(page); await sincronizar(page)
  await context.setOffline(true)
  const clienteId = await cadastrar(page, `Cliente fictícia D-078 ${crypto.randomUUID()}`, '')
  const id = await page.evaluate(async (clienteId) => {
    const lab = window.laboratorio; if (!lab) throw new Error('Sem laboratório')
    const id = crypto.randomUUID()
    // Fila histórica: o caminho de criação novo recusa descrição vazia antes da gravação.
    await lab.repositorio.gravarLancamento({ tipo: 'venda', pagamento: 'fiado', id, clienteId, data: '2026-10-20',
      itens: [{ descricao: '', preco: 2010n }, { descricao: 'Nome preservado', preco: 990n }], desconto: 1n,
      parcelas: [{ id: crypto.randomUUID(), vencimento: '2026-11-20', valor: 2999n }] })
    return id
  }, clienteId)
  await context.setOffline(false); await sincronizar(page)
  expect(await page.evaluate(async (id) => {
    const lab = window.laboratorio; if (!lab) throw new Error('Sem laboratório')
    return (await lab.banco.fila.where('registroId').equals(id).first())?.problema
  }, id)).toMatchObject({ codigo: '23514', constraint: 'lancamentos_sem_itens' })
  const antes = await lerVenda(page, id)
  await page.getByRole('button', { name: 'Completar o que foi vendido', exact: true }).click()
  await page.getByLabel('O que foi vendido no item 1', { exact: true }).fill('Batom preenchido')
  await page.screenshot({ path: info.outputPath('completar-servidor-real.png'), fullPage: true })
  await page.getByRole('button', { name: 'Salvar e tentar enviar', exact: true }).click()
  await sincronizar(page)
  const depois = await lerVenda(page, id)
  expect({ ...depois, conteudo: JSON.parse(depois.conteudo) }).toEqual({ ...antes,
    conteudo: JSON.parse(antes.conteudo.replace('"descricao":""', '"descricao":"Batom preenchido"')), fila: 0 })
  const outroContexto = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const outraPagina = await outroContexto.newPage()
    await abrirApp(outraPagina); await entrar(outraPagina); await sincronizar(outraPagina)
    const restaurada = await lerVenda(outraPagina, id)
    expect({ ...restaurada, conteudo: JSON.parse(restaurada.conteudo) }).toEqual({ ...depois, conteudo: JSON.parse(depois.conteudo) })
  } finally { await outroContexto.close() }
  expect(erros).toEqual([])
})
