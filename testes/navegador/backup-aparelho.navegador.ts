import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { abrirApp, entrar, recarregar, USUARIO_DE_TESTE } from './apoio.ts'

test.use({ trace: 'off', video: 'off', screenshot: 'off' })

test('BA-03: Edge de homologação recusa a conta sem vínculo com o Drive', async () => {
  test.skip(process.env.AMBIENTE_DE_TESTE !== 'homologacao' || process.env.PROVAR_BACKUP_APARELHO === '1',
    'A suíte comum de homologação usa uma conta fictícia nova, fora da autorização Google.')
  expect(exigirDestinoDeTeste()).toBe('homologacao')
  const api = new URL(process.env.VITE_SUPABASE_URL ?? '').origin, chave = process.env.VITE_SUPABASE_ANON_KEY ?? ''
  const cliente = createClient(api, chave, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await cliente.auth.signInWithPassword({ email: USUARIO_DE_TESTE.email, password: USUARIO_DE_TESTE.senha })
  if (error || !data.session) throw new Error('Conta fictícia indisponível.')
  try {
    const pedir = (body: object) => fetch(api + '/functions/v1/enviar-backup/aparelho', {
      method: 'POST', redirect: 'error', headers: { apikey: chave, authorization: 'Bearer ' + data.session?.access_token,
        'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const estado = await pedir({ acao: 'estado' })
    expect(estado.status).toBe(200)
    expect(await estado.json()).toEqual({ estado: 'configuracao', habilitado: false, ultima: null })
    const confirmar = await pedir({ acao: 'confirmar', captura: crypto.randomUUID(), aparelho: crypto.randomUUID() })
    expect(confirmar.status).toBe(403)
    expect(await confirmar.json()).toEqual({ erro: 'nao_autorizado' })
  } finally { await cliente.auth.signOut({ scope: 'local' }) }
})

test('BA-03: Drive real retoma o mesmo ZIP após recarga offline', async ({ page, context }, info) => {
  test.skip(process.env.PROVAR_BACKUP_APARELHO !== '1', 'Executar com o comando da homologação autorizada no Drive.')
  test.setTimeout(150_000)
  expect(exigirDestinoDeTeste()).toBe('homologacao')
  const destino = new URL(process.env.VITE_SUPABASE_URL ?? '').origin
  const rota = destino + '/functions/v1/enviar-backup/aparelho'
  const anonimo = await fetch(rota, { method: 'POST', body: '{"acao":"estado"}' })
  expect(anonimo.status).toBe(401)
  const candidatos: string[] = [], blocos: string[] = [], erros: string[] = []
  const eventos: { origem: 'drive' | 'edge'; http: number; posicao?: number }[] = []
  let interromper = true, soltarPrimeiro!: () => void
  const primeiro = new Promise<void>((resolve) => { soltarPrimeiro = resolve })
  page.on('pageerror', (e) => erros.push(e.name))
  page.on('response', async (r) => {
    const u = new URL(r.url())
    if (u.origin === 'https://www.googleapis.com' && u.pathname.startsWith('/upload/drive/v3/files')) eventos.push({ origem: 'drive', http: r.status() })
    if (r.url() === rota) {
      const v: unknown = await r.json().catch(() => null)
      const posicao = v && typeof v === 'object' && 'posicao' in v && typeof v.posicao === 'number' ? v.posicao : undefined
      eventos.push({ origem: 'edge', http: r.status(), posicao })
    }
  })
  // Mantém as anotações fictícias no aparelho para provar que o ZIP é independente da sincronização.
  await page.route((u) => u.origin === destino && /^\/(rest|storage)\/v1\//.test(u.pathname), (r) => r.abort())
  await page.route(rota, (r) => {
    if (r.request().method() !== 'POST') return r.continue()
    const pedido: unknown = r.request().postDataJSON()
    if (pedido && typeof pedido === 'object' && 'acao' in pedido && pedido.acao === 'abrir' &&
      'captura' in pedido && typeof pedido.captura === 'string') candidatos.push(pedido.captura)
    return r.continue()
  })
  await page.route((u) => u.origin === 'https://www.googleapis.com' && u.pathname.startsWith('/upload/drive/v3/files'), async (r) => {
    if (r.request().method() !== 'PUT') return r.continue()
    blocos.push(r.request().headers()['content-range'] ?? '')
    if (blocos.length === 1) await primeiro
    if (interromper && blocos.length > 1) return r.abort()
    return r.continue()
  })
  await page.setViewportSize({ width: 375, height: 812 })
  await abrirApp(page)
  await context.setOffline(true)
  const bytes = [...await readFile('testes/arquivos/foto-exif-6.jpeg')]
  const ficha = await page.evaluate(async (dados) => {
    const l = window.laboratorio
    if (!l || navigator.onLine) throw new Error('Preparação fora da prova offline')
    const cliente = await l.cadastrarCliente({ nome: 'Ficha fictícia do backup do aparelho' })
    const categoria = await l.operacoesEstoque.cadastrarCategoria('Prova de originais do aparelho')
    if (!cliente.ok || !categoria.ok) throw new Error('Fixture recusada')
    const foto = await l.prepararFoto(new Blob([new Uint8Array(dados)], { type: 'image/jpeg' }))
    const n = Math.ceil(4.25 * 1024 * 1024 / foto.binario.byteLength)
    if (n > 400) throw new Error('Fixture acima de RNF-05')
    for (let i = 0; i < n; i++) {
      const produto = await l.operacoesEstoque.cadastrarProduto({ nome: `Original fictício ${i + 1}`, categoriaId: categoria.valor.id }, foto)
      if (!produto.ok) throw new Error('Produto fictício recusado')
    }
    const venda = await l.lancarVendaFiado({ clienteId: cliente.valor.id, data: '2026-10-02',
      itens: [{ descricao: 'Anotação fictícia', preco: 9007199254740993n }], parcelas: [{ vencimento: '2026-10-24', valor: 9007199254740993n }] })
    if (!venda.ok) throw new Error('Venda fictícia recusada')
    return { clienteId: cliente.valor.id, fotos: n }
  }, bytes)
  const abrirCopia = () => page.getByRole('button', { name: 'Cópia das anotações ›', exact: true }).click()
  await abrirCopia()
  await context.setOffline(false)
  await entrar(page)
  try {
    await expect(page.getByText(/^A cópia do aparelho está pendente/)).toBeVisible()
    await page.screenshot({ path: info.outputPath('pendente-claro-375.png'), fullPage: true })
  } finally { soltarPrimeiro() }
  await expect(page.getByText(/^Não deu para terminar a cópia do aparelho/)).toBeVisible({ timeout: 60_000 })
  expect(blocos[0]).toMatch(/^bytes 0-4194303\//)
  expect(blocos[1]).toMatch(/^bytes 4194304-/)
  expect(candidatos).toHaveLength(1)
  await context.setOffline(true)
  await recarregar(page)
  const saldo = await page.evaluate(async (clienteId) => {
    const l = window.laboratorio
    if (!l || !navigator.serviceWorker.controller || navigator.onLine) throw new Error('Recarga fora da prova offline')
    const r = await l.receber({ clienteId, data: '2026-10-03', valor: 10n, forma: 'pix' })
    if (!r.ok) throw new Error('Recebimento offline recusado')
    return String(l.saldo(await l.repositorio.lerFicha(clienteId)))
  }, ficha.clienteId)
  expect(saldo).toBe('9007199254740983')
  await page.setViewportSize({ width: 320, height: 812 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addStyleTag({ content: 'html { font-size: 32px } body { font-size: 36px }' })
  await abrirCopia()
  await expect(page.getByText(/^Não deu para terminar a cópia do aparelho/)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  await page.screenshot({ path: info.outputPath('falha-escuro-320-ampliado.png'), fullPage: true })
  interromper = false
  await context.setOffline(false)
  try {
    await expect.poll(() => page.evaluate(async () => {
      const estado = await window.laboratorio?.banco.controleCopia.get('backup-aparelho')
      return estado?.chave === 'backup-aparelho' && !!estado.concluido && !estado.tentativa
    }), { timeout: 65_000 }).toBe(true)
    await expect(page.getByText('Feita a partir das anotações de um aparelho.', { exact: true })).toBeVisible({ timeout: 65_000 })
  } finally { console.log(JSON.stringify({ candidatos, blocos, eventos, segredosImpressos: false })) }
  await expect(page.getByText(/^Não deu para terminar a cópia do aparelho/)).toHaveCount(0)
  expect(blocos[2]).toBe(blocos[1])
  expect(candidatos.length).toBeGreaterThanOrEqual(2)
  expect(new Set(candidatos).size).toBe(1)
  expect(erros).toEqual([])
  await page.screenshot({ path: info.outputPath('confirmada-escuro-320-ampliado.png'), fullPage: true })
  console.log(JSON.stringify({ etapa: 'BA-03', captura: candidatos[0], fotos: ficha.fotos, retomouDeBytes: 4194304, saldoAposReceberOffline: saldo,
    segredosImpressos: false }))
})
