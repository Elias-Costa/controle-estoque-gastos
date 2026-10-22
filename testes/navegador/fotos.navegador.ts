import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { abrirApp, entrar, esperarIndicador, nuvemDeFora, pularSemUsuario, recarregar, sincronizar } from './apoio.ts'

const arquivo = [...readFileSync(new URL('../arquivos/foto-teste.jpeg', import.meta.url))]
const exif = [...readFileSync(new URL('../arquivos/foto-exif-6.jpeg', import.meta.url))]
test.describe.configure({ mode: 'serial' })

test('E-22 encoder nativo — orientação EXIF, transparência, ruído WebP e falha explícita', async ({ page, context }) => {
  await abrirApp(page); await context.setOffline(true)
  const medidas = await page.evaluate(async ({ arquivo, exif }) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const orientada = await l.prepararFoto(new Blob([new Uint8Array(exif)]))
    const tela = document.createElement('canvas'); tela.width = 2048; tela.height = 2048
    const ctx = tela.getContext('2d'); if (!ctx) throw new Error('sem canvas')
    const pixels = ctx.createImageData(2048, 2048)
    let semente = 42
    for (let i = 0; i < pixels.data.length; i += 4) {
      for (let canal = 0; canal < 3; canal++) { semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0; pixels.data[i + canal] = semente >>> 24 }
      pixels.data[i + 3] = 255
    }
    ctx.putImageData(pixels, 0, 0)
    const entrada = await new Promise<Blob>((resolve) => tela.toBlob((v) => { if (v) resolve(v); else throw new Error('sem WebP') }, 'image/webp'))
    const complexa = await l.prepararFoto(entrada)
    tela.width = 8; tela.height = 8
    const transparente = await new Promise<Blob>((resolve) => tela.toBlob((v) => { if (v) resolve(v); else throw new Error('sem PNG') }, 'image/png'))
    const branca = await l.prepararFoto(transparente)
    const imagem = new Image(), url = URL.createObjectURL(new Blob([new Uint8Array(branca.binario)]))
    imagem.src = url; await imagem.decode(); ctx.drawImage(imagem, 0, 0); URL.revokeObjectURL(url)
    const canto = [...ctx.getImageData(0, 0, 1, 1).data]
    const original = HTMLCanvasElement.prototype.toBlob
    const falhas: string[] = []
    try {
      for (const retorno of [null, new Blob(['png'], { type: 'image/png' })]) {
        HTMLCanvasElement.prototype.toBlob = function (callback) { callback(retorno) }
        try { await l.prepararFoto(new Blob([new Uint8Array(arquivo)])); throw new Error('encoder defeituoso aceito') }
        catch (erro) { falhas.push(erro instanceof Error ? erro.message : '') }
      }
    } finally { HTMLCanvasElement.prototype.toBlob = original }
    return { orientada: { largura: orientada.largura, altura: orientada.altura,
      semExif: !new TextDecoder('latin1').decode(orientada.binario).includes('Exif\0\0') },
      complexa: { largura: complexa.largura, bytes: complexa.binario.length, miniatura: complexa.miniatura.length },
      branca: { largura: branca.largura, altura: branca.altura, canto }, falhas }
  }, { arquivo, exif })
  expect(medidas.orientada).toEqual({ largura: 1024, altura: 683, semExif: true })
  expect(medidas.complexa.bytes).toBeLessThanOrEqual(204800); expect(medidas.complexa.miniatura).toBeLessThanOrEqual(20480)
  expect(medidas.branca).toEqual({ largura: 8, altura: 8, canto: [255, 255, 255, 255] })
  expect(medidas.falhas).toEqual(['Não consegui preparar esta foto. Tente outra.', 'Não consegui preparar esta foto. Tente outra.'])
  console.log('E-22 encoder real:', JSON.stringify(medidas))
})

test('E-22 RT-07/08/10 — foto e financeiro offline, reabertura, envio e miniatura restaurada visível sem rede', async ({ page, context, browser }, testInfo) => {
  pularSemUsuario()
  await abrirApp(page); await entrar(page); await sincronizar(page)
  await context.setOffline(true)
  const antes = await page.evaluate(async (bytes) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    try { await l.prepararFoto(new Blob(['arquivo inválido'])); throw new Error('aceitou arquivo inválido') }
    catch (erro) { if (!(erro instanceof Error) || !erro.message.includes('Não consegui preparar')) throw erro }
    const foto = await l.prepararFoto(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
    const cat = await l.operacoesEstoque.cadastrarCategoria(`Fotos ${crypto.randomUUID()}`); if (!cat.ok) throw new Error(cat.motivo)
    const p = await l.repositorioEstoque.salvarProduto({ id: crypto.randomUUID(), nome: 'Produto fictício com foto', categoriaId: cat.valor.id }, foto)
    if (!p.ok || !p.valor.fotoId) throw new Error('sem foto')
    const cliente = await l.cadastrarCliente({ nome: `Foto offline ${crypto.randomUUID()}` }); if (!cliente.ok) throw new Error(cliente.motivo)
    const venda = await l.lancarVendaFiado({ clienteId: cliente.valor.id, data: '2026-10-18', itens: [{ descricao: 'Avulso', preco: 1000n }], parcelas: [{ vencimento: '2026-11-18', valor: 1000n }] })
    if (!venda.ok) throw new Error(venda.motivo)
    const recebimento = await l.receber({ clienteId: cliente.valor.id, data: '2026-10-18', valor: 300n, forma: 'pix' })
    if (!recebimento.ok) throw new Error(recebimento.motivo)
    return { produtoId: p.valor.id, fotoId: p.valor.fotoId, sha256: foto.sha256, bytes: foto.binario.length,
      miniatura: foto.miniatura.length, clienteId: cliente.valor.id, vendaId: venda.valor.id,
      recebimentoId: recebimento.valor.recebimento.id, saldo: String(l.saldo(await l.repositorio.lerFicha(cliente.valor.id))) }
  }, arquivo)
  expect(antes.bytes).toBeLessThanOrEqual(204800); expect(antes.miniatura).toBeLessThanOrEqual(20480)
  expect(antes.saldo).toBe('700')
  await recarregar(page)
  const persistido = await page.evaluate(async ({ fotoId, clienteId }) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const f = await l.banco.fotos.get(fotoId)
    return { sha256: f?.sha256, bytes: f?.binario?.length, miniatura: f?.miniatura?.length,
      saldo: String(l.saldo(await l.repositorio.lerFicha(clienteId))) }
  }, antes)
  expect(persistido).toEqual({ sha256: antes.sha256, bytes: antes.bytes, miniatura: antes.miniatura, saldo: '700' })
  // Falha só do Storage: financeiro precisa subir antes dela e o original continuar pendente.
  await page.route('**/storage/v1/**', (rota) => rota.abort())
  await context.setOffline(false)
  const falha = await page.evaluate(async () => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    l.sincronizacao.acordar(); await l.sincronizacao.sincronizar()
    return l.sincronizacao.estado().ultimaFalha
  })
  expect(falha).toBe('rede')
  expect(await page.evaluate(async (id) => (await window.laboratorio?.banco.fotos.get(id))?.binario?.length, antes.fotoId)).toBe(antes.bytes)
  const fora = await nuvemDeFora()
  try {
    expect(await fora.lancamentosPorId(antes.vendaId)).toHaveLength(1)
    expect(await fora.lancamentosPorId(antes.recebimentoId)).toHaveLength(1)
  } finally { await fora.sair() }
  await page.unroute('**/storage/v1/**'); await sincronizar(page)
  await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
  expect(await page.evaluate(async (id) => (await window.laboratorio?.banco.fotos.get(id))?.binario === undefined, antes.fotoId)).toBe(true)
  const outro = await browser.newContext(), b = await outro.newPage()
  try {
    await abrirApp(b); await entrar(b); await sincronizar(b)
    await esperarIndicador(b, { pendentes: 0, comProblema: 0 })
    await outro.setOffline(true); await recarregar(b)
    const imagem = await b.evaluate(async ({ fotoId, clienteId }) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const f = await l.banco.fotos.get(fotoId)
      if (!f?.miniatura) throw new Error('restauração sem miniatura')
      const img = new Image(); img.alt = 'Miniatura fictícia restaurada offline'
      const url = URL.createObjectURL(new Blob([new Uint8Array(f.miniatura)], { type: 'image/jpeg' }))
      img.src = url; await img.decode(); document.body.append(img)
      const medidas = { largura: img.naturalWidth, altura: img.naturalHeight, bytes: f.miniatura.length,
        semOriginal: f.binario === undefined, saldo: String(l.saldo(await l.repositorio.lerFicha(clienteId))) }
      URL.revokeObjectURL(url)
      return medidas
    }, antes)
    expect(imagem.semOriginal).toBe(true); expect(imagem.saldo).toBe('700')
    expect(imagem.largura).toBeGreaterThan(0); expect(imagem.altura).toBeLessThanOrEqual(320)
    await expect(b.getByAltText('Miniatura fictícia restaurada offline')).toBeVisible()
    await b.getByAltText('Miniatura fictícia restaurada offline').screenshot({ path: testInfo.outputPath('miniatura-offline.png') })
    console.log('E-22 bytes reais e restauração:', JSON.stringify({ antes, imagem }))
  } finally { await outro.close() }
})

test('E-22 RNF-04/05 — consulta local com 400 produtos e miniaturas no IndexedDB real', async ({ page, context }) => {
  await abrirApp(page)
  await context.setOffline(true)
  const medida = await page.evaluate(async (bytes) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    l.sincronizacao.parar()
    const foto = await l.prepararFoto(new Blob([new Uint8Array(bytes)]))
    const cat = await l.operacoesEstoque.cadastrarCategoria('Ensaio local 400'); if (!cat.ok) throw new Error(cat.motivo)
    const ids: string[] = []
    for (let i = 0; i < 400; i++) {
      const p = await l.repositorioEstoque.salvarProduto({ id: crypto.randomUUID(), nome: `Produto ${i}`, categoriaId: cat.valor.id }, foto)
      if (!p.ok || !p.valor.fotoId) throw new Error('sem foto')
      ids.push(p.valor.fotoId)
    }
    const inicio = performance.now()
    const produtos = await l.banco.produtos.where('categoriaId').equals(cat.valor.id).toArray()
    const miniaturas = await l.banco.fotos.bulkGet(ids)
    return { produtos: produtos.length, miniaturas: miniaturas.filter((f) => f?.miniatura).length,
      consultaMs: performance.now() - inicio, bytesMiniaturas: miniaturas.reduce((n, f) => n + (f?.miniatura?.length ?? 0), 0),
      bytesPendentes: miniaturas.reduce((n, f) => n + (f?.binario?.length ?? 0), 0) }
  }, arquivo)
  expect(medida.produtos).toBe(400); expect(medida.miniaturas).toBe(400)
  expect(medida.consultaMs).toBeLessThan(1000)
  expect(medida.bytesMiniaturas).toBeLessThanOrEqual(400 * 20480)
  console.log('E-22 consulta de 400 produtos fictícios offline:', JSON.stringify(medida))
})
