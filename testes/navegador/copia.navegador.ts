import { readFile, writeFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { abrirApp, entrar, recarregar, sincronizar, USUARIO_DE_TESTE } from './apoio.ts'
import { criarArquivoBackup, lerArquivoCopia } from '../../src/plataforma/arquivo-copia.ts'
import { hashDaFoto } from '../../src/plataforma/fotos.ts'

async function abrirCopia(page: Page) {
  await page.getByRole('button', { name: 'Cópia das anotações ›', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Cópia das anotações', exact: true })).toBeVisible()
}
async function reservarEEntrar(page: Page) {
  await abrirCopia(page)
  await page.getByRole('button', { name: 'Começar a usar uma cópia', exact: true }).click()
  await page.getByRole('button', { name: 'Entrar para usar a cópia', exact: true }).click()
  await page.getByLabel('E-mail', { exact: true }).fill(USUARIO_DE_TESTE.email)
  await page.getByLabel('Senha', { exact: true }).fill(USUARIO_DE_TESTE.senha)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByLabel('Escolher arquivo da cópia', { exact: true })).toBeVisible()
}

for (const formato of [4, 5]) test(`E-35/BA-01 formato ${formato} com fotos/pendências importa pela tela, reabre offline e retoma sem duplicar`, async ({ page, context, browser }, info) => {
  const outro = await browser.newContext(), b = await outro.newPage(), erros: string[] = []
  page.on('pageerror', (e) => erros.push(e.message)); b.on('pageerror', (e) => erros.push(e.message))
  const bytes = [...await readFile('testes/arquivos/foto-teste.jpeg')]
  try {
    await page.setViewportSize({ width: 375, height: 812 })
    await abrirApp(page); await entrar(page); await sincronizar(page); await context.setOffline(true)
    const esperado = await page.evaluate(async (bytes) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const c = await l.cadastrarCliente({ nome: `Ficha da cópia offline ${crypto.randomUUID().slice(0, 8)}` }); if (!c.ok) throw new Error(c.motivo)
      const categoria = await l.operacoesEstoque.cadastrarCategoria('Categoria da cópia'); if (!categoria.ok) throw new Error(categoria.motivo)
      const foto = await l.prepararFoto(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
      const p = await l.operacoesEstoque.cadastrarProduto({ nome: 'Produto fotografado da cópia', categoriaId: categoria.valor.id, custoManual: 300n, classificacao: 'unissex' }, foto)
      if (!p.ok) throw new Error(p.motivo)
      const compra = await l.operacoesEstoque.registrarMovimento({ tipo: 'compra', produtoId: p.valor.id, data: '2026-10-01', quantidade: 7, custoUnitario: 300n })
      const venda = await l.operacoesEstoque.lancarVenda({ clienteId: c.valor.id, data: '2026-10-02', desconto: 0n, pagamento: 'fiado',
        itens: [{ produtoId: p.valor.id, descricao: p.valor.nome, quantidade: 2, entregue: 1, precoUnitario: 500n }], parcelas: [{ vencimento: '2026-10-24', valor: 1000n }] })
      const gasto = await l.operacoesCaixa.registrar({ tipo: 'despesa', data: '2026-10-03', valor: 1250n, categoria: 'Gasto da cópia offline', classificacao: 'pessoal', mercadoria: false })
      if (!compra.ok || !venda.ok || !gasto.ok) throw new Error('preparação inválida')
      const modelos = { 'cobranca-vencida': '{nome}, parcela de {valor} em {vencimento}.', 'cobranca-a-vencer': '{nome}, vence em {vencimento}.',
        'recibo-com-saldo': 'Recebi {valor}; falta {saldo}.', 'recibo-quitado': 'Recebi {valor}. Obrigada, {nome}!' }
      if (!(await l.repositorioModelos.salvar(modelos, await l.repositorioModelos.ler())).ok) throw new Error('modelos não guardados')
      const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII='
      const identidade = { nome: 'Loja fictícia da cópia', descricao: 'Catálogo restaurável', logo }
      if (!(await l.repositorioIdentidadeLoja.salvar(identidade, await l.repositorioIdentidadeLoja.ler())).ok) throw new Error('identidade não guardada')
      return { clienteId: c.valor.id, clienteNome: c.valor.nome, produtoId: p.valor.id, fotoId: p.valor.fotoId, modelos, identidade,
        fila: (await l.banco.fila.toArray()).map((f) => f.registroId).sort(), foto: [...foto.miniatura] }
    }, bytes)
    await abrirCopia(page)
    await page.getByRole('button', { name: 'Preparar cópia completa', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Salvar arquivo', exact: true })).toBeVisible()
    const evento = page.waitForEvent('download'); await page.getByRole('link', { name: 'Salvar arquivo', exact: true }).click()
    let arquivo = info.outputPath('copia-completa.zip'), invalido: string | undefined
    await (await evento).saveAs(arquivo)
    if (formato === 5) {
      // Empacotador real sem Canvas no processo do teste; o decoder real roda depois, no app offline.
      const vinculo = await page.evaluate(async () => window.laboratorio?.repositorioCopia.vinculo())
      if (!vinculo) throw new Error('sem vínculo')
      const validada = await lerArquivoCopia(new Blob([new Uint8Array(await readFile(arquivo))]), vinculo)
      const dados = { ...validada.dados, fotos: validada.dados.fotos.map(({ miniatura: _m, ...foto }) => foto) }
      const estagio = { id: crypto.randomUUID(), tipo: 'exportacao', pronto: true, vinculo, capturadoEm: validada.capturadoEm } as const
      const zip = await criarArquivoBackup(estagio, dados, { tipo: 'servidor' })
      arquivo = info.outputPath('backup-sem-miniaturas.zip')
      await writeFile(arquivo, new Uint8Array(await zip.arrayBuffer()))
      // CRC e hashes válidos não fazem bytes arbitrários virarem uma imagem decodificável.
      const fotos = await Promise.all(dados.fotos.map(async (foto) => {
        const binario = new Uint8Array(foto.bytes)
        return { ...foto, binario, sha256: await hashDaFoto(binario) }
      }))
      const corrompido = await criarArquivoBackup(estagio, { ...dados, fotos }, { tipo: 'servidor' })
      invalido = info.outputPath('backup-jpeg-invalido.zip')
      await writeFile(invalido, new Uint8Array(await corrompido.arrayBuffer()))
    }
    await page.screenshot({ path: info.outputPath('copia-pronta-375.png'), fullPage: true })
    await abrirApp(b); await reservarEEntrar(b); await outro.setOffline(true)
    if (invalido) {
      await b.getByLabel('Escolher arquivo da cópia', { exact: true }).setInputFiles(invalido)
      await b.getByRole('button', { name: 'Conferir e usar esta cópia', exact: true }).click()
      await expect(b.getByText('Não deu para conferir o arquivo inteiro. Escolha uma cópia completa criada pelo aplicativo.', { exact: true })).toBeVisible()
      expect(await b.evaluate(async () => {
        const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
        return { fichas: await l.banco.clientes.count(), fotos: await l.banco.fotos.count(),
          lotes: await l.banco.lotesCopia.count(), fase: (await l.repositorioCopia.restauracao())?.fase }
      })).toEqual({ fichas: 0, fotos: 0, lotes: 0, fase: 'escolher' })
      await b.screenshot({ path: info.outputPath('backup-invalido-sem-publicacao.png'), fullPage: true })
    }
    await b.getByLabel('Escolher arquivo da cópia', { exact: true }).setInputFiles(arquivo)
    await b.getByRole('button', { name: 'Conferir e usar esta cópia', exact: true }).click()
    await expect(b.getByText(/^As anotações da cópia estão neste aparelho/)).toBeVisible()
    async function conferir() {
      return b.evaluate(async (e) => {
        const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
        const posicao = l.projetarEstoque(await l.banco.movimentos.toArray(), e.produtoId)
        return { saldo: String(l.saldo(await l.repositorio.lerFicha(e.clienteId))), fisico: posicao.ok ? posicao.valor.fisico : null,
          foto: [...((await l.banco.fotos.get(e.fotoId ?? ''))?.miniatura ?? [])], modelos: (await l.repositorioModelos.ler())?.modelos,
          identidade: (await l.repositorioIdentidadeLoja.ler())?.identidade,
          classificacao: (await l.banco.produtos.get(e.produtoId))?.classificacao,
          fila: (await l.banco.fila.toArray()).map((f) => f.registroId).sort() }
      }, esperado)
    }
    expect(await conferir()).toEqual({ saldo: '1000', fisico: 6, foto: esperado.foto, fila: esperado.fila, modelos: esperado.modelos, identidade: esperado.identidade, classificacao: 'unissex' })
    await recarregar(b)
    expect(await conferir()).toEqual({ saldo: '1000', fisico: 6, foto: esperado.foto, fila: esperado.fila, modelos: esperado.modelos, identidade: esperado.identidade, classificacao: 'unissex' })
    await b.getByRole('button', { name: esperado.clienteNome, exact: false }).click()
    await expect(b.getByText('R$ 10,00', { exact: true }).first()).toBeVisible()
    await b.screenshot({ path: info.outputPath('ficha-restaurada-offline.png'), fullPage: true })
    await outro.setOffline(false); await sincronizar(b)
    await context.setOffline(false); await sincronizar(page); await sincronizar(b)
    const depois = await conferir()
    expect(depois.saldo).toBe('1000'); expect(depois.fisico).toBe(6); expect(depois.foto).toEqual(esperado.foto); expect(depois.fila).toEqual([])
    expect(depois.modelos).toEqual(esperado.modelos)
    expect(depois.identidade).toEqual(esperado.identidade); expect(depois.classificacao).toBe('unissex')
    await recarregar(b); await abrirCopia(b)
    await b.getByRole('button', { name: 'Começar a usar uma cópia', exact: true }).click()
    await expect(b.getByText(/^Este aparelho já tem anotações/)).toBeVisible()
    expect((await conferir()).saldo).toBe('1000')
    expect(erros).toEqual([])
  } finally { await outro.close() }
})

test('BA-01 RNF-05: 5/10 sem miniaturas com cinco anos sintéticos e 400 fotos nos tetos', async ({ page, context, browser }, info) => {
  test.setTimeout(180_000)
  const outro = await browser.newContext(), b = await outro.newPage()
  const bytes = [...await readFile('testes/arquivos/foto-teste.jpeg')]
  try {
    // Reserva antes do login conserva a base vazia. O volume é isolado e nunca vai à nuvem.
    await abrirApp(page); await reservarEEntrar(page); await context.setOffline(true)
    await page.evaluate(async (bytes) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const reserva = await l.copia.restauracao(); if (!reserva) throw new Error('sem reserva')
      await l.copia.descartar(reserva.id)
      const categoriaId = crypto.randomUUID(), agora = new Date().toISOString()
      const foto = await l.prepararFoto(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
      const binario = new Uint8Array(204800), miniatura = new Uint8Array(20480)
      binario.set(foto.binario); miniatura.set(foto.miniatura)
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', binario))].map((b) => b.toString(16).padStart(2, '0')).join('')
      const clientes = Array.from({ length: 150 }, (_, i) => ({ id: crypto.randomUUID(), nome: `Volume ${i}`, atualizadoEm: agora }))
      await l.banco.transaction('rw', l.banco.clientes, l.banco.lancamentos, l.banco.categorias, l.banco.produtos, l.banco.fotos, async () => {
        await l.banco.clientes.bulkAdd(clientes)
        await l.banco.categorias.add({ id: categoriaId, nome: 'Volume' })
        for (let i = 0; i < 2400; i++) {
          const clienteId = clientes[i % 150]?.id; if (!clienteId) throw new Error('sem cliente')
          const data = `${2021 + Math.floor(i / 480)}-${String(Math.floor(i / 40) % 12 + 1).padStart(2, '0')}-01`
          await l.banco.lancamentos.add({ id: crypto.randomUUID(), clienteId, tipo: 'venda', pagamento: 'fiado', data,
            itens: [{ descricao: 'Volume', preco: 1200n }], desconto: 0n,
            parcelas: Array.from({ length: 6 }, () => ({ id: crypto.randomUUID(), vencimento: data, valor: 200n })) })
          for (let n = 0; n < 6; n++) await l.banco.lancamentos.add({ id: crypto.randomUUID(), clienteId, tipo: 'recebimento', data, valor: 200n, forma: 'dinheiro' })
        }
        for (let i = 0; i < 400; i++) {
          const id = crypto.randomUUID(), fotoId = crypto.randomUUID()
          await l.banco.produtos.add({ id, nome: `Produto volume ${i}`, categoriaId, fotoId, atualizadoEm: agora })
          await l.banco.fotos.add({ id: fotoId, copiaId: crypto.randomUUID(), produtoId: id, cadastroEm: agora,
            geracaoEnvio: crypto.randomUUID(), sha256, bytes: binario.byteLength, largura: foto.largura, altura: foto.altura,
            situacao: 'pendente', binario, miniatura })
        }
      })
    }, bytes)
    await recarregar(page); await abrirCopia(page)
    const inicio = Date.now()
    await page.getByRole('button', { name: 'Preparar cópia completa', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Salvar arquivo', exact: true })).toBeVisible({ timeout: 90_000 })
    const evento = page.waitForEvent('download'); await page.getByRole('link', { name: 'Salvar arquivo', exact: true }).click()
    const download = await evento, manual = info.outputPath('volume-app.zip'); await download.saveAs(manual)
    const exportarMs = Date.now() - inicio
    const vinculo = await page.evaluate(async () => window.laboratorio?.repositorioCopia.vinculo())
    if (!vinculo) throw new Error('sem vínculo')
    const validada = await lerArquivoCopia(new Blob([new Uint8Array(await readFile(manual))]), vinculo)
    const dados = { ...validada.dados, fotos: validada.dados.fotos.map(({ miniatura: _m, ...foto }) => foto) }
    const zip = await criarArquivoBackup({ id: crypto.randomUUID(), tipo: 'exportacao', pronto: true,
      vinculo, capturadoEm: validada.capturadoEm }, dados, { tipo: 'servidor' })
    const arquivo = info.outputPath('volume-backup-sem-miniaturas.zip')
    await writeFile(arquivo, new Uint8Array(await zip.arrayBuffer()))
    await abrirApp(b); await reservarEEntrar(b); await outro.setOffline(true)
    await b.getByLabel('Escolher arquivo da cópia', { exact: true }).setInputFiles(arquivo)
    const antesImportar = Date.now()
    await b.getByRole('button', { name: 'Conferir e usar esta cópia', exact: true }).click()
    await expect(b.getByText(/^As anotações da cópia estão neste aparelho/)).toBeVisible({ timeout: 90_000 })
    const importarMs = Date.now() - antesImportar
    const restaurado = await b.evaluate(async () => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const dados = await l.repositorioCopia.conferirDados()
      return { clientes: dados.clientes.length, produtos: dados.produtos.length, lancamentos: dados.lancamentos.length, fotos: dados.fotos.length,
        saldo: String(l.saldo(dados.lancamentos.filter((v) => v.clienteId === dados.clientes[0]?.id))),
        bytesFotos: dados.fotos.reduce((n, f) => n + (f.binario?.byteLength ?? 0) + (f.miniatura?.byteLength ?? 0), 0),
        bytesOriginais: dados.fotos.reduce((n, f) => n + (f.binario?.byteLength ?? 0), 0),
        miniaturas: dados.fotos.filter((f) => f.miniatura && f.miniatura.byteLength > 0 && f.miniatura.byteLength <= 20480).length,
        originaisConferidos: (await Promise.all(dados.fotos.map(async (f) => {
          if (!f.binario) return false
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(f.binario)))].map((b) => b.toString(16).padStart(2, '0')).join('')
          return hash === f.sha256
        }))).filter(Boolean).length }
    })
    expect(restaurado).toMatchObject({ clientes: 150, produtos: 400, lancamentos: 16800, fotos: 400, saldo: '0',
      bytesOriginais: 81920000, miniaturas: 400, originaisConferidos: 400 })
    expect(restaurado.bytesFotos).toBeGreaterThan(81920000); expect(restaurado.bytesFotos).toBeLessThanOrEqual(90112000)
    await info.attach('volume-ba01', { body: JSON.stringify({ exportarMs, importarMs, bytesZip: zip.size, ...restaurado }), contentType: 'application/json' })
    console.log('BA-01 volume app:', JSON.stringify({ exportarMs, importarMs, bytesZip: zip.size, ...restaurado }))
    await recarregar(b)
    expect(await b.evaluate(async () => window.laboratorio?.banco.lancamentos.count())).toBe(16800)
  } finally { await outro.close() }
})
