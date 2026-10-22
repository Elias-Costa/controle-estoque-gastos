import { expect, test, type Page } from '@playwright/test'
import { abrirApp, apagarBase, entrar, esperarIndicador, pularSemUsuario, recarregar, sincronizar } from './apoio.ts'

// D-043/E-21: mesmas operações do app, IndexedDB e SW reais, build; dados fictícios D-050.
test.describe.configure({ mode: 'serial' })

async function preparar(page: Page, quantidade = 10) {
  return page.evaluate(async (quantidade) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const c = await l.cadastrarCliente({ nome: `Vera fictícia E-21 ${crypto.randomUUID()}` }); if (!c.ok) throw new Error(c.motivo)
    const categoria = await l.operacoesEstoque.cadastrarCategoria(`Perfumes ${crypto.randomUUID()}`); if (!categoria.ok) throw new Error(categoria.motivo)
    const p = await l.operacoesEstoque.cadastrarProduto({ nome: 'Perfume', categoriaId: categoria.valor.id,
      marca: 'Marca', codigoCatalogo: 'ABC', estoqueMinimo: 0, precoVenda: 5000n, custoManual: 9007199254740993n }); if (!p.ok) throw new Error(p.motivo)
    const compra = await l.operacoesEstoque.registrarMovimento({ tipo: 'compra', produtoId: p.valor.id, data: '2026-10-18', quantidade, custoUnitario: 9007199254740993n })
    if (!compra.ok) throw new Error(compra.motivo)
    return { clienteId: c.valor.id, produtoId: p.valor.id, categoriaId: categoria.valor.id }
  }, quantidade)
}
type Alvos = Awaited<ReturnType<typeof preparar>>
async function vender(page: Page, alvos: Alvos, quantidade = 3, entregue = 1) {
  return page.evaluate(async ({ clienteId, produtoId, quantidade, entregue }) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const r = await l.operacoesEstoque.lancarVenda({ clienteId, data: '2026-10-18', pagamento: 'fiado', desconto: 0n,
      parcelas: [{ vencimento: '2026-11-18', valor: BigInt(quantidade) * 5000n }], itens: [{ produtoId, descricao: 'Perfume', quantidade, entregue }] })
    if (!r.ok) throw new Error(r.motivo)
    const venda = r.valor.lancamentos[0]; if (!venda || venda.tipo !== 'venda' || !venda.itens[0]?.id) throw new Error('sem item')
    return { vendaId: venda.id, itemId: venda.itens[0].id, operacaoId: r.valor.operacao.id }
  }, { ...alvos, quantidade, entregue })
}
async function retrato(page: Page, alvos: Alvos) {
  return page.evaluate(async ({ clienteId, produtoId, categoriaId }) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const estado = await l.repositorioEstoque.lerEstado()
    const movimentos = estado.movimentos.filter((m) => m.produtoId === produtoId).sort((a, b) => a.id.localeCompare(b.id) || a.revisao - b.revisao)
    const ficha = estado.lancamentos.filter((f) => f.clienteId === clienteId).sort((a, b) => a.id.localeCompare(b.id))
    const grupos = estado.grupos.filter((g) => g.movimentos.some((m) => m.produtoId === produtoId) || g.lancamentos.some((f) => f.clienteId === clienteId))
      .sort((a, b) => a.operacao.id.localeCompare(b.operacao.id))
    const proj = l.projetarEstoque(movimentos, produtoId); if (!proj.ok) throw new Error(proj.motivo)
    const encerramentos = (await l.banco.encerramentos.toArray()).filter((e) => e.evidencia.grupo.lancamentos.some((f) => f.clienteId === clienteId))
      .sort((a, b) => a.id.localeCompare(b.id))
    return { fisico: proj.valor.fisico, saldo: String(l.saldo(ficha)), dados: l.conteudoDoEfeito({
      cliente: await l.banco.clientes.get(clienteId), categoria: await l.banco.categorias.get(categoriaId), produto: await l.banco.produtos.get(produtoId),
      movimentos, ficha, grupos, encerramentos }) }
  }, alvos)
}

test('E-21 RT-07/08/10/11 — ciclo offline, reabertura, retentativa e restauração F1 + estoque campo a campo', async ({ page, context }) => {
  pularSemUsuario()
  await abrirApp(page); await entrar(page); await sincronizar(page)
  await context.setOffline(true)
  const alvos = await preparar(page)
  const v = await vender(page, alvos)
  await page.evaluate(async ({ clienteId }) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const r = await l.lancarVendaFiado({ clienteId, data: '2026-10-18', itens: [{ descricao: 'Avulso F1', preco: 1000n }], parcelas: [{ vencimento: '2026-11-18', valor: 1000n }] })
    if (!r.ok) throw new Error(r.motivo)
  }, alvos)
  const antes = await retrato(page, alvos)
  expect(antes.fisico).toBe(9); expect(antes.saldo).toBe('16000')
  await recarregar(page)
  expect(await retrato(page, alvos)).toEqual(antes)
  await context.setOffline(false); await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
  // Reenvia os mesmos grupos já aceitos: idempotência exercitada pelo motor real.
  await page.evaluate(async () => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    for (const op of await l.banco.operacoes.toArray()) await l.banco.fila.add({ tabela: 'operacoes', registroId: op.id, versao: op.revisao, criadoEm: new Date().toISOString() })
  })
  await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
  await context.setOffline(true)
  await page.evaluate(async ({ vendaId, itemId }) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const entrega = await l.operacoesEstoque.entregar({ vendaId, itemId, quantidade: 1, data: '2026-10-18' }); if (!entrega.ok) throw new Error(entrega.motivo)
    const cancelar = await l.operacoesEstoque.cancelarVenda(vendaId, '2026-10-18', [{ itemId, quantidade: 1 }]); if (!cancelar.ok) throw new Error(cancelar.motivo)
  }, v)
  const offline = await retrato(page, alvos)
  expect(offline.fisico).toBe(9); expect(offline.saldo).toBe('1000')
  await recarregar(page); expect(await retrato(page, alvos)).toEqual(offline)
  await context.setOffline(false); await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
  const final = await retrato(page, alvos)
  await apagarBase(page); await recarregar(page); await sincronizar(page)
  expect(await retrato(page, alvos)).toEqual(final)
  await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
  await context.setOffline(true); await recarregar(page)
  expect(await retrato(page, alvos)).toEqual(final)
})

test('E-21 RT-09/11 — dois aparelhos vendem o último item offline e convergem sem descartar entregas', async ({ browser }) => {
  pularSemUsuario()
  const ca = await browser.newContext(), cb = await browser.newContext()
  const a = await ca.newPage(), b = await cb.newPage()
  try {
    await abrirApp(a); await entrar(a); await sincronizar(a)
    const alvos = await preparar(a, 1); await sincronizar(a)
    await abrirApp(b); await entrar(b); await sincronizar(b)
    await ca.setOffline(true); await cb.setOffline(true)
    await vender(a, alvos, 1, 1); await vender(b, alvos, 1, 1)
    await recarregar(a); await recarregar(b)
    await ca.setOffline(false); await sincronizar(a)
    await cb.setOffline(false); await sincronizar(b); await sincronizar(a)
    await esperarIndicador(a, { pendentes: 0, comProblema: 0 }); await esperarIndicador(b, { pendentes: 0, comProblema: 0 })
    const final = await retrato(a, alvos)
    expect(final.fisico).toBe(-1); expect(final.saldo).toBe('10000')
    expect(await retrato(b, alvos)).toEqual(final)
  } finally { await ca.close(); await cb.close() }
})

test('E-21 Q47 — tentativa F1 recusada fica até confirmação humana; resolução e evidência restauram sem duplicar', async ({ page }) => {
  pularSemUsuario()
  await abrirApp(page); await entrar(page); await sincronizar(page)
  const alvos = await preparar(page), v = await vender(page, alvos)
  await sincronizar(page)
  const legadoId = await page.evaluate(async ({ vendaId, clienteId }) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const id = crypto.randomUUID()
    await l.banco.transaction('rw', l.banco.lancamentos, l.banco.fila, async () => {
      await l.banco.lancamentos.put({ id, clienteId, data: '2026-10-18', tipo: 'estorno', estornaId: vendaId })
      await l.banco.fila.add({ tabela: 'lancamentos', registroId: id, criadoEm: new Date().toISOString() })
    })
    return id
  }, { ...v, ...alvos })
  await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 1 })
  expect((await retrato(page, alvos)).saldo).toBe('0')
  const encerramentoId = await page.evaluate(async (id) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const tentativa = await l.repositorioEstoque.registrarRecusaLegada(id); if (!tentativa.ok) throw new Error(tentativa.motivo)
    const r = await l.repositorioEstoque.encerrar(tentativa.valor.id, { data: '2026-10-18', confirmado: true, intencaoPendente: false })
    if (!r.ok) throw new Error(r.motivo)
    const outra = await l.repositorioEstoque.encerrar(tentativa.valor.id, { data: '2026-10-18', confirmado: true, intencaoPendente: false })
    if (!outra.ok || outra.valor.id !== r.valor.id) throw new Error('confirmação duplicou')
    return r.valor.id
  }, legadoId)
  await sincronizar(page); await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
  const final = await retrato(page, alvos)
  expect(final.saldo).toBe('15000'); expect(final.fisico).toBe(9)
  await apagarBase(page); await recarregar(page); await sincronizar(page)
  expect(await retrato(page, alvos)).toEqual(final)
  expect(await page.evaluate(async (id) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const e = await l.banco.encerramentos.get(id)
    return e?.evidencia.diagnostico !== undefined && e.evidencia.grupo.lancamentos.length === 1
  }, encerramentoId)).toBe(true)
})
