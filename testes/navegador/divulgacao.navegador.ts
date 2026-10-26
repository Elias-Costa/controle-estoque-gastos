import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { abrirApp } from './apoio.ts'
import { PALAVRAS_DA_DIVULGACAO as P } from '../../src/interface/palavras-da-divulgacao.ts'

declare global {
  interface Window {
    pdfsDivulgacao?: { nome: string; tipo: string; base64: string }[]
    cancelarDivulgacao?: boolean
  }
}

async function observarCompartilhamento(page: Page) {
  // Inspeção do payload no desktop; o seletor real foi provado separadamente no Poco X5 Pro.
  await page.addInitScript(() => {
    window.pdfsDivulgacao = []
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (dados: ShareData) => dados.files?.every((arquivo) => arquivo.type === 'application/pdf') ?? false })
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (dados: ShareData) => {
      if (window.cancelarDivulgacao) { window.cancelarDivulgacao = false; throw new DOMException('Cancelado', 'AbortError') }
      for (const arquivo of dados.files ?? []) {
        const base64 = await new Promise<string>((resolver, rejeitar) => { const leitor = new FileReader(); leitor.onload = () => typeof leitor.result === 'string' ? resolver(leitor.result.split(',')[1] ?? '') : rejeitar(); leitor.onerror = rejeitar; leitor.readAsDataURL(arquivo) })
        window.pdfsDivulgacao?.push({ nome: arquivo.name, tipo: arquivo.type, base64 })
      }
    } })
  })
}

async function abrirDivulgacao(page: Page) {
  await page.getByRole('button', { name: /^Produtos/ }).click()
  await page.getByRole('button', { name: P.abrir, exact: true }).click()
  await expect(page.getByRole('heading', { name: P.titulo, exact: true })).toBeVisible()
  const identificar = page.getByRole('button', { name: 'Identificar loja', exact: true })
  await expect(page.getByRole('region', { name: 'Identificação da loja', exact: true })).toBeVisible()
  if (await identificar.count()) {
    await identificar.click()
    await page.getByLabel('Nome da loja ou marca', { exact: true }).fill('Cícera Mult')
    await page.getByLabel('Descrição da loja (opcional)', { exact: true }).fill('Perfumaria, moda íntima, beleza e acessórios para celular')
    // Logo de diagnóstico, sem representar a marca real; canto transparente e proporção 2:1.
    const logo = await page.evaluate(() => {
      const tela = document.createElement('canvas'); tela.width = 160; tela.height = 80
      const c = tela.getContext('2d'); if (!c) throw new Error('sem Canvas')
      c.fillStyle = '#0b5f3a'; c.fillRect(10, 10, 140, 60)
      c.fillStyle = '#ffffff'; c.font = '20px sans-serif'; c.fillText('TESTE', 48, 48)
      return tela.toDataURL('image/png').split(',')[1] ?? ''
    })
    await page.getByLabel('Escolher logo', { exact: true }).setInputFiles({ name: 'logo-teste.png', mimeType: 'image/png', buffer: Buffer.from(logo, 'base64') })
    await page.getByRole('button', { name: 'Usar logo', exact: true }).click()
    await expect(page.getByRole('img', { name: 'Prévia da logo da loja', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Salvar identificação', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Editar identificação', exact: true })).toBeVisible()
    const imagem = await page.evaluate(async () => {
      const p = await window.laboratorio?.repositorioIdentidadeLoja.ler()
      if (!p?.identidade.logo) throw new Error('sem logo')
      const img = new Image(); img.src = p.identidade.logo; await img.decode()
      const tela = document.createElement('canvas'); tela.width = img.naturalWidth; tela.height = img.naturalHeight
      const c = tela.getContext('2d'); if (!c) throw new Error('sem Canvas')
      c.drawImage(img, 0, 0)
      return { largura: img.naturalWidth, altura: img.naturalHeight, alfa: c.getImageData(0, 0, 1, 1).data[3] }
    })
    expect(imagem).toEqual({ largura: 160, altura: 160, alfa: 0 })
  }
}

test('E-28C prévia offline, foto/preço/telefone, PDF exato, cancelamento e releitura de outra aba', async ({ page, context }, info) => {
  await observarCompartilhamento(page); await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page); await context.setOffline(true)
  const bytes = [...await readFile(new URL('../arquivos/foto-teste.jpeg', import.meta.url))]
  const ids = await page.evaluate(async (bytes) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const cliente = crypto.randomUUID()
    await l.repositorio.gravarCliente({ id: cliente, nome: 'Cliente fictícia E-28C' })
    const categoria = await l.operacoesEstoque.cadastrarCategoria('Perfumes E-28C')
    if (!categoria.ok) throw new Error(categoria.motivo)
    const foto = await l.prepararFoto(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
    const produtos = []
    for (const [nome, classificacao, incompleto] of [['01 - Açúcar masculino', 'masculino', false], ['02 - Unissex', 'unissex', false], ['03 - Gratuito', 'masculino', true]] as const) {
      const p = await l.operacoesEstoque.cadastrarProduto({ nome, categoriaId: categoria.valor.id, marca: 'X', classificacao, custoManual: 777n,
        ...(incompleto ? {} : { precoVenda: 900719925474099312345n }) }, incompleto ? undefined : foto)
      if (!p.ok) throw new Error(p.motivo)
      const c = await l.operacoesEstoque.registrarMovimento({ tipo: 'compra', produtoId: p.valor.id, quantidade: 3, custoUnitario: 777n, data: '2026-10-25' })
      if (!c.ok) throw new Error(c.motivo)
      produtos.push(p.valor.id)
    }
    const primeiro = produtos[0]
    if (!primeiro) throw new Error('sem produto')
    const promessa = await l.operacoesEstoque.lancarVenda({ clienteId: cliente, pagamento: 'fiado', data: '2026-10-25', desconto: 0n,
      parcelas: [{ vencimento: '2026-11-25', valor: 200n }], itens: [{ produtoId: primeiro, descricao: 'Promessa E-28C', quantidade: 2, entregue: 0, precoUnitario: 100n }] })
    if (!promessa.ok) throw new Error(promessa.motivo)
    return { cliente, categoria: categoria.valor.id, produtos }
  }, bytes)
  const [primeiro, unissex, incompleto] = ids.produtos
  if (!primeiro || !unissex || !incompleto) throw new Error('fixture incompleta')
  await abrirDivulgacao(page)
  await page.getByLabel('Categoria', { exact: true }).selectOption(ids.categoria)
  await page.getByLabel('Marca', { exact: true }).selectOption('marca:x')
  await page.getByLabel('Classificação', { exact: true }).selectOption('masculino')
  const linha = (id: string) => page.locator(`[data-divulgacao-id="${id}"]`)
  await expect(page.locator('[data-divulgacao-id]')).toHaveCount(3)
  await expect(linha(primeiro)).toContainText('Quantidade disponível: 1')
  await linha(unissex).getByRole('checkbox').uncheck()
  await page.getByLabel('Para qual fichinha?', { exact: true }).selectOption(ids.cliente)
  await expect(page.getByRole('button', { name: 'Preparar PDF', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Adicionar ou corrigir telefone', exact: true }).click()
  await page.getByLabel('Telefone', { exact: true }).fill('85999999999')
  await page.getByRole('button', { name: 'Pronto', exact: true }).click()
  await expect(linha(unissex).getByRole('checkbox')).not.toBeChecked()
  await linha(incompleto).getByRole('button', { name: /^Completar dados/ }).click()
  await page.getByLabel('Preço de venda', { exact: true }).fill('0')
  await page.getByLabel('Escolher foto', { exact: true }).setInputFiles(fileURLToPath(new URL('../arquivos/foto-teste.jpeg', import.meta.url)))
  await expect(page.getByRole('img', { name: '03 - Gratuito', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Salvar', exact: true }).click()
  await expect(linha(incompleto)).toContainText('R$ 0,00 (gratuito)')
  const antes = await page.evaluate(async () => {
    const b = window.laboratorio?.banco; if (!b) throw new Error('sem banco')
    return JSON.stringify(await Promise.all([b.clientes.toArray(), b.produtos.toArray(), b.lancamentos.toArray(), b.movimentos.toArray(), b.operacoes.toArray(), b.versoesEstoque.toArray(), b.fila.toArray()]), (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v)
  })
  await page.getByRole('button', { name: 'Preparar PDF', exact: true }).click()
  await expect(page.getByText(/^PDF pronto com 2 produtos/)).toBeVisible()
  await page.evaluate(() => { window.cancelarDivulgacao = true })
  await page.getByRole('button', { name: 'Compartilhar PDF', exact: true }).click()
  await expect(page.getByText(P.cancelou, { exact: true })).toBeVisible()
  await expect(linha(unissex).getByRole('checkbox')).not.toBeChecked()
  await page.getByRole('button', { name: 'Compartilhar PDF', exact: true }).click()
  await expect(page.getByText(P.retornou, { exact: true })).toBeVisible()
  const compartilhado = await page.evaluate(async () => {
    const b = window.laboratorio?.banco; if (!b) throw new Error('sem banco')
    return { pdfs: window.pdfsDivulgacao, usos: await b.usosFotos.count(), estado: JSON.stringify(await Promise.all([b.clientes.toArray(), b.produtos.toArray(), b.lancamentos.toArray(), b.movimentos.toArray(), b.operacoes.toArray(), b.versoesEstoque.toArray(), b.fila.toArray()]), (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v) }
  })
  expect(compartilhado.estado).toBe(antes); expect(compartilhado.usos).toBe(0)
  expect(compartilhado.pdfs).toHaveLength(1)
  const pdf = compartilhado.pdfs?.[0]; if (!pdf) throw new Error('sem PDF')
  expect(pdf.nome).toBe('produtos-disponiveis.pdf'); expect(pdf.tipo).toBe('application/pdf')
  await writeFile(info.outputPath('produtos-ui.pdf'), Buffer.from(pdf.base64, 'base64'))
  await page.screenshot({ path: info.outputPath('divulgacao-375.png'), fullPage: true })

  const outra = await context.newPage(); await outra.goto('/'); await outra.waitForFunction(() => !!window.laboratorio)
  await outra.evaluate(async (produtoId) => {
    const l = window.laboratorio, p = await l?.banco.produtos.get(produtoId); if (!l || !p) throw new Error('sem produto')
    const r = await l.repositorioEstoque.salvarProduto({ ...p, nome: '01 - Nome alterado em outra aba' }); if (!r.ok) throw new Error(r.motivo)
  }, primeiro)
  await expect(linha(primeiro)).toContainText('Nome alterado em outra aba')
  await expect(page.getByRole('button', { name: 'Compartilhar PDF', exact: true })).toHaveCount(0)
  await expect(linha(unissex).getByRole('checkbox')).not.toBeChecked()
  const novo = await outra.evaluate(async (categoriaId) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const p = await l.operacoesEstoque.cadastrarProduto({ nome: '04 - Novo resultado', categoriaId, marca: 'X', classificacao: 'masculino' })
    if (!p.ok) throw new Error(p.motivo)
    const c = await l.operacoesEstoque.registrarMovimento({ tipo: 'compra', produtoId: p.valor.id, quantidade: 1, data: '2026-10-25' }); if (!c.ok) throw new Error(c.motivo)
    return p.valor.id
  }, ids.categoria)
  await expect(page.getByRole('button', { name: /^Incluir 1 novo/ })).toBeVisible()
  await expect(linha(novo)).toHaveCount(0)
  await page.getByRole('button', { name: /^Incluir 1 novo/ }).click()
  await expect(linha(novo)).toBeVisible(); await expect(linha(unissex).getByRole('checkbox')).not.toBeChecked()
  await outra.evaluate(async ({ produtoId, clienteId }) => {
    const r = await window.laboratorio?.operacoesEstoque.lancarVenda({ clienteId, pagamento: 'fiado', data: '2026-10-25', desconto: 0n,
      parcelas: [{ vencimento: '2026-11-25', valor: 100n }], itens: [{ produtoId, descricao: 'Venda que retira disponibilidade', quantidade: 1, entregue: 1, precoUnitario: 100n }] })
    if (!r?.ok) throw new Error('venda não gravou')
  }, { produtoId: primeiro, clienteId: ids.cliente })
  await expect(linha(primeiro)).toHaveCount(0)
  await outra.close()
  await page.reload(); await page.waitForFunction(() => !!window.laboratorio); await abrirDivulgacao(page)
  await expect(linha(incompleto)).toContainText('R$ 0,00 (gratuito)')
  await expect(page.getByRole('button', { name: 'Preparar PDF', exact: true })).toBeDisabled()
})

test('E-28C lista vazia e 400 produtos completos geram PDF único offline sem omissões', async ({ page, context }, info) => {
  await observarCompartilhamento(page); await abrirApp(page); await context.setOffline(true)
  await abrirDivulgacao(page)
  await expect(page.getByText(P.vazio, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Preparar PDF', exact: true })).toBeDisabled()
  const bytes = [...await readFile(new URL('../arquivos/foto-teste.jpeg', import.meta.url))]
  const clienteId = await page.evaluate(async (bytes) => {
    const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
    const f = await l.prepararFoto(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
    const b = l.banco, categoriaId = crypto.randomUUID(), clienteId = crypto.randomUUID(), atualizadoEm = new Date().toISOString()
    // Volume fictício isolado: IndexedDB real, sem envio nem operação na nuvem.
    await b.transaction('rw', [b.categorias, b.clientes, b.produtos, b.movimentos, b.fotos], async () => {
      await b.categorias.put({ id: categoriaId, nome: 'Volume E-28C' })
      await b.clientes.put({ id: clienteId, nome: 'Cliente volume', telefone: '85999999999', atualizadoEm })
      for (let i = 1; i <= 400; i++) {
        const id = crypto.randomUUID(), fotoId = crypto.randomUUID()
        await b.produtos.put({ id, nome: `Produto ${String(i).padStart(3, '0')}`, categoriaId, fotoId, precoVenda: i === 400 ? 900719925474099312345n : 1n, atualizadoEm })
        await b.fotos.put({ id: fotoId, produtoId: id, cadastroEm: atualizadoEm, copiaId: crypto.randomUUID(), geracaoEnvio: crypto.randomUUID(), sha256: f.sha256, bytes: f.binario.length, largura: f.largura, altura: f.altura, miniatura: f.miniatura, situacao: 'disponivel' })
        await b.movimentos.put({ tipo: 'compra', id: crypto.randomUUID(), produtoId: id, operacaoId: crypto.randomUUID(), revisao: 1, data: '2026-10-25', quantidade: 1, ordemCadastro: BigInt(i), conhecidos: [] })
      }
    })
    return clienteId
  }, bytes)
  await expect(page.getByRole('button', { name: /^Incluir 400 novos/ })).toBeVisible()
  await page.getByRole('button', { name: /^Incluir 400 novos/ }).click()
  await expect(page.locator('[data-divulgacao-id]')).toHaveCount(400)
  await page.getByLabel('Para qual fichinha?', { exact: true }).selectOption(clienteId)
  await page.getByRole('button', { name: 'Preparar PDF', exact: true }).click()
  await expect(page.getByText(/^PDF pronto com 400 produtos/)).toBeVisible()
  await page.getByRole('button', { name: 'Compartilhar PDF', exact: true }).click()
  await expect(page.getByText(P.retornou, { exact: true })).toBeVisible()
  const base64 = await page.evaluate(() => window.pdfsDivulgacao?.[0]?.base64)
  if (!base64) throw new Error('sem PDF de volume')
  await writeFile(info.outputPath('produtos-400-ui.pdf'), Buffer.from(base64, 'base64'))
  expect(await page.evaluate(async () => window.laboratorio?.banco.usosFotos.count())).toBe(0)
  await page.evaluate(async () => {
    const b = window.laboratorio?.banco, p = await b?.produtos.toCollection().first()
    if (!b || !p) throw new Error('sem produto')
    await b.produtos.update(p.id, { nome: 'Produto com caractere sem glifo 😁' })
  })
  await expect(page.getByRole('button', { name: 'Compartilhar PDF', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Preparar PDF', exact: true }).click()
  await expect(page.getByText(P.falhaPdf, { exact: true })).toBeVisible()
  await expect(page.locator('[data-divulgacao-id]')).toHaveCount(400)
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(400)
})
