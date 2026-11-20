import { expect, test } from '@playwright/test'
import { abrirApp, cadastrar, entrar, lerFicha, pularSemUsuario, recarregar, sincronizar, vender } from './apoio.ts'

test('E-42 salva o prazo sem rede, reabre escolha e venda no build e sincroniza outro contexto', async ({ page, context, browser }) => {
  pularSemUsuario()
  await abrirApp(page)
  await context.setOffline(true)
  const cliente = await cadastrar(page, 'Ficha do prazo offline', '85999990001')
  const venda = await vender(page, { clienteId: cliente, data: '2026-11-20', itens: [{ descricao: 'Item fictício', preco: '5000' }],
    parcelas: [{ vencimento: '2026-12-20', valor: '5000' }] })
  const escolha = await page.evaluate(async () => {
    const l = window.laboratorio
    if (!l) throw new Error('Laboratório ausente')
    return l.repositorioPrazoEncalhe.salvar(45, undefined)
  })
  if (!escolha.ok) throw new Error('Prazo não salvo')
  await recarregar(page)
  expect(await lerFicha(page, cliente)).toEqual({ saldo: '5000', ids: [venda] })
  const local = await page.evaluate(async () => {
    const l = window.laboratorio
    if (!l) throw new Error('Laboratório ausente')
    return { prazo: await l.repositorioPrazoEncalhe.ler(), fila: await l.banco.fila.toArray() }
  })
  expect(local.prazo).toEqual(escolha.preferencia)
  expect(local.fila).toEqual(expect.arrayContaining([
    expect.objectContaining({ tabela: 'lancamentos', registroId: venda }),
    expect.objectContaining({ tabela: 'prazoEncalhe', registroId: escolha.preferencia.id, versao: 0 }),
  ]))
  await context.setOffline(false)
  await entrar(page)
  expect((await sincronizar(page)).pendentes).toBe(0)

  const outro = await browser.newContext()
  try {
    const segunda = await outro.newPage()
    await abrirApp(segunda)
    await entrar(segunda)
    await sincronizar(segunda)
    expect(await lerFicha(segunda, cliente)).toEqual({ saldo: '5000', ids: [venda] })
    const prazo = await segunda.evaluate(() => window.laboratorio?.repositorioPrazoEncalhe.ler())
    expect(prazo).toEqual(escolha.preferencia)
  } finally { await outro.close() }
})
