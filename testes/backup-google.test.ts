import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { lerAutorizacaoGoogle } from '../nuvem/backup/cofre-google.ts'
import { configurarGoogle, lerArquivoClienteGoogle } from '../nuvem/backup/configurar-google.ts'
import { consultarContaDrive, criarTentativaGoogle, ESCOPO_DRIVE, FalhaGoogle, lerClienteGoogle, renovarTokensGoogle, trocarCodigoGoogle, urlAutorizacaoGoogle } from '../nuvem/backup/google.ts'
import { abrirRetornoGoogle } from '../nuvem/backup/retorno-google.ts'
import { autorizacaoGoogleFicticia, clienteGoogleFicticio } from './fixtures/backup-google.ts'

afterEach(() => { const r = espiao; espiao = undefined; r?.mockRestore() })
let espiao: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const preconectar = fetch.preconnect
function transporte(impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
  return Object.assign(impl, { preconnect: preconectar })
}

describe('BA-02 configuração Google — protocolo local e guardas, sem consentimento real', () => {
  test('aceita somente cliente Desktop do projeto confirmado e endpoints Google', () => {
    expect(lerClienteGoogle(clienteGoogleFicticio)).toEqual(autorizacaoGoogleFicticia.cliente)
    for (const extra of [{ project_id: 'outro' }, { auth_uri: 'https://fraude.example/autorizar' }, { token_uri: 'https://fraude.example/token' },
      { redirect_uris: ['https://site.example'] }, { client_id: '' }]) {
      expect(() => lerClienteGoogle({ installed: { ...clienteGoogleFicticio.installed, ...extra } })).toThrow(FalhaGoogle)
    }
    expect(() => lerClienteGoogle({ web: clienteGoogleFicticio.installed })).toThrow(FalhaGoogle)
  })
  test('PKCE SHA-256, state e callback efêmeros; segredo/verificador fora da URL', async () => {
    const a = await criarTentativaGoogle(), b = await criarTentativaGoogle()
    expect(a.estado).not.toBe(b.estado); expect(a.verificador).not.toBe(b.verificador)
    const sha = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a.verificador))
    expect(a.desafio).toBe(Buffer.from(sha).toString('base64url'))
    const url = new URL(urlAutorizacaoGoogle(lerClienteGoogle(clienteGoogleFicticio), a, 'http://127.0.0.1:58721/oauth2/retorno'))
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('scope')).toBe(ESCOPO_DRIVE); expect(url.searchParams.get('state')).toBe(a.estado)
    expect(url.searchParams.get('code_challenge')).toBe(a.desafio); expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('access_type')).toBe('offline'); expect(url.searchParams.get('include_granted_scopes')).toBe('false')
    expect(url.href).not.toContain(a.verificador); expect(url.href).not.toContain(clienteGoogleFicticio.installed.client_secret)
    for (const retorno of ['http://0.0.0.0:58721/oauth2/retorno', 'https://site.example/oauth2/retorno', 'http://127.0.0.1:58721/outra']) {
      expect(() => urlAutorizacaoGoogle(lerClienteGoogle(clienteGoogleFicticio), a, retorno)).toThrow(FalhaGoogle)
    }
  })
  test('retorno HTTP real recusa state/Host/duplicação e não reflete código; uma só utilização', async () => {
    const t = await criarTentativaGoogle(), r = abrirRetornoGoogle(t.estado)
    try {
      expect((await fetch(r.url + '?state=errado&code=segredo')).status).toBe(400)
      expect((await fetch(r.url + `?state=${'A'.repeat(43)}&code=segredo`)).status).toBe(400)
      expect((await fetch(r.url + `?state=${t.estado}&code=segredo`, { headers: { host: 'fraude.example' } })).status).toBe(400)
      expect((await fetch(r.url + `?state=${t.estado}&state=${t.estado}&code=segredo`)).status).toBe(400)
      expect((await fetch(r.url + `?state=${t.estado}&code=um&code=dois`)).status).toBe(400)
      expect((await fetch(r.url + `?state=${t.estado}&code=segredo`, { method: 'POST' })).status).toBe(400)
      const ok = await fetch(r.url + `?state=${t.estado}&code=codigo-ficticio`)
      expect(ok.status).toBe(200); expect(ok.headers.get('cache-control')).toBe('no-store')
      expect(await ok.text()).not.toContain('codigo-ficticio'); expect(await r.codigo).toBe('codigo-ficticio')
      expect((await fetch(r.url + `?state=${t.estado}&code=replay`)).status).toBe(410)
    } finally { r.fechar() }
  })
  test('recusa de consentimento e prazo encerram sem devolver código', async () => {
    const t = await criarTentativaGoogle(), r = abrirRetornoGoogle(t.estado)
    try {
      expect((await fetch(r.url + `?state=${t.estado}&error=access_denied&error_description=segredo`)).status).toBe(400)
      await expect(r.codigo).rejects.toThrow('não foi concedida')
    } finally { r.fechar() }
    const curto = abrirRetornoGoogle(t.estado, 10)
    try { await expect(curto.codigo).rejects.toThrow('Prazo') } finally { curto.fechar() }
  })
  test('arquivo JSON fora do repositório; recusa projeto errado, caminho relativo e arquivo da árvore', async () => {
    const pasta = await mkdtemp(join(tmpdir(), 'fichinhas-oauth-ficticio-')), arquivo = join(pasta, 'cliente.json')
    try {
      await Bun.write(arquivo, JSON.stringify(clienteGoogleFicticio))
      expect(await lerArquivoClienteGoogle(arquivo)).toEqual(autorizacaoGoogleFicticia.cliente)
      await Bun.write(arquivo, JSON.stringify({ installed: { ...clienteGoogleFicticio.installed, project_id: 'outro' } }))
      await expect(lerArquivoClienteGoogle(arquivo)).rejects.toThrow(FalhaGoogle)
      await expect(lerArquivoClienteGoogle('cliente.json')).rejects.toThrow(FalhaGoogle)
      await expect(lerArquivoClienteGoogle(resolve('package.json'))).rejects.toThrow(FalhaGoogle)
    } finally { await unlink(arquivo); await rmdir(pasta) }
  })
  test('formato do cofre fecha campos e amarra ambiente/destino/projeto', () => {
    expect(lerAutorizacaoGoogle(autorizacaoGoogleFicticia)).toEqual(autorizacaoGoogleFicticia)
    for (const extra of [{ ambiente: ['local'] }, { destino: 'https://producao.supabase.co' }, { extra: 'segredo' }, { renovacao: '' }, { contaId: 'invalida' },
      { cliente: { ...autorizacaoGoogleFicticia.cliente, projetoId: 'outro' } }]) {
      expect(() => lerAutorizacaoGoogle({ ...autorizacaoGoogleFicticia, ...extra })).toThrow(FalhaGoogle)
    }
  })
  test('código só no corpo POST, PKCE original; escopo adicional ou refresh ausente são recusados', async () => {
    const t = await criarTentativaGoogle(), c = lerClienteGoogle(clienteGoogleFicticio)
    espiao = spyOn(globalThis, 'fetch').mockImplementation(transporte(async (url, opcoes) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token'); expect(opcoes?.method).toBe('POST'); expect(opcoes?.redirect).toBe('error')
      const corpo = new URLSearchParams(String(opcoes?.body))
      expect(corpo.get('code')).toBe('codigo-ficticio'); expect(corpo.get('code_verifier')).toBe(t.verificador)
      return json({ access_token: 'acesso-ficticio', refresh_token: 'renovacao-ficticia', token_type: 'Bearer', expires_in: 3600, scope: ESCOPO_DRIVE })
    }))
    expect((await trocarCodigoGoogle(c, t, 'http://127.0.0.1:58721/oauth2/retorno', 'codigo-ficticio')).renovacao).toBe('renovacao-ficticia')
    espiao.mockImplementation(transporte(async () => json({ access_token: 'x', token_type: 'Bearer', expires_in: 3600, scope: ESCOPO_DRIVE })))
    await expect(trocarCodigoGoogle(c, t, 'http://127.0.0.1:58721/oauth2/retorno', 'codigo-ficticio')).rejects.toThrow('incompleta')
    espiao.mockImplementation(transporte(async () => json({ access_token: 'x', refresh_token: 'y', token_type: 'Bearer', expires_in: 3600, scope: ESCOPO_DRIVE + ' outro' })))
    await expect(trocarCodigoGoogle(c, t, 'http://127.0.0.1:58721/oauth2/retorno', 'codigo-ficticio')).rejects.toThrow('escopo')
  })
  test('renovação pode omitir scope original; erro Google nunca reflete corpo ou exceção de rede', async () => {
    const cliente = lerClienteGoogle(clienteGoogleFicticio)
    espiao = spyOn(globalThis, 'fetch').mockImplementation(transporte(async (_url, opcoes) => {
      const corpo = new URLSearchParams(String(opcoes?.body))
      expect(corpo.get('grant_type')).toBe('refresh_token'); expect(corpo.get('refresh_token')).toBe('renovacao-ficticia')
      return json({ access_token: 'acesso-ficticio', token_type: 'Bearer', expires_in: 3600 })
    }))
    expect((await renovarTokensGoogle(cliente, 'renovacao-ficticia')).acesso).toBe('acesso-ficticio')
    espiao.mockImplementation(transporte(async () => json({ error_description: 'TOKEN-NAO-EXIBIR' }, 400)))
    await expect(renovarTokensGoogle(cliente, 'renovacao-ficticia')).rejects.toThrow('nenhum token foi exibido')
    espiao.mockImplementation(transporte(async () => { throw new Error('TOKEN-NAO-EXIBIR') }))
    await expect(renovarTokensGoogle(cliente, 'renovacao-ficticia')).rejects.toThrow('detalhes sensíveis omitidos')
  })
  test('about recebe token só em cabeçalho e conserva cota acima de Number.MAX_SAFE_INTEGER', async () => {
    espiao = spyOn(globalThis, 'fetch').mockImplementation(transporte(async (url, opcoes) => {
      expect(String(url)).not.toContain('acesso-ficticio'); expect(new Headers(opcoes?.headers).get('authorization')).toBe('Bearer acesso-ficticio')
      return json({ user: { permissionId: '1234567890', emailAddress: 'teste@example.test' }, storageQuota: { usage: '9007199254740993', limit: '9007199254740999' } })
    }))
    expect((await consultarContaDrive('acesso-ficticio')).uso).toBe(9007199254740993n)
    espiao.mockImplementation(transporte(async () => json({ user: { permissionId: '1', emailAddress: 'teste@example.test' }, storageQuota: { usage: 100 } })))
    await expect(consultarContaDrive('acesso-ficticio')).rejects.toThrow('inválida')
  })
  test('comando direto sem destino D-050 falha antes de OAuth/SQL', async () => {
    if (process.env.AMBIENTE_DE_TESTE) return
    espiao = spyOn(globalThis, 'fetch').mockImplementation(transporte(async () => { throw new Error('Não deveria fazer rede') }))
    await expect(configurarGoogle('autorizar')).rejects.toThrow('Produção não recebe suítes')
    expect(espiao).not.toHaveBeenCalled()
  })
})
