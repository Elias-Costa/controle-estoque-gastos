import { describe, expect, spyOn, test } from 'bun:test'
import { criarTentativaGoogle, ESCOPO_DRIVE, RETORNO_GOOGLE_PRODUCAO, RETORNO_GOOGLE_TESTE } from '../nuvem/backup/google.ts'
import { lerClienteGoogleWeb, urlAutorizacaoGoogleWeb } from '../nuvem/backup/google-web.ts'
import { lerAutorizacaoGoogle } from '../nuvem/backup/cofre-google.ts'
import { autorizacaoGoogleFicticia } from './fixtures/backup-google.ts'
import { criarHandlerConexaoGoogle } from '../nuvem/backup/conexao-google.ts'
import { criarTransporteBackup } from '../nuvem/backup/transporte.ts'
import { criarConexaoDrive } from '../src/sincronizacao/conexao-drive.ts'
import { comandoBackupProducao } from '../nuvem/backup/producao.ts'
import { criarHandlerBackupAparelho } from '../nuvem/backup/aparelho.ts'

const web = { web: { project_id: 'fichinhas-backup-homologacao', client_id: '123456-cliente.apps.googleusercontent.com', client_secret: 'ficticio',
  auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: [RETORNO_GOOGLE_TESTE] } }
describe('D-085 conexão pelo app — guardas do protocolo, sem consentimento real', () => {
  test('Web confere tipo/projeto/retorno e não amplia o parser Desktop', async () => {
    expect(comandoBackupProducao(['web', '--projeto=awmesexptpalzonbucwc', `--conta=${autorizacaoGoogleFicticia.contaId}`, 'C:\\privado\\cliente-web.json']))
      .toMatchObject({ acao: 'web', contaId: autorizacaoGoogleFicticia.contaId, caminho: 'C:\\privado\\cliente-web.json' })
    const cliente = lerClienteGoogleWeb(web, false)
    expect(() => lerClienteGoogleWeb(web, true)).toThrow()
    expect(() => lerClienteGoogleWeb({ installed: web.web }, false)).toThrow()
    expect(() => lerClienteGoogleWeb({ web: { ...web.web, redirect_uris: ['https://outro.example/retorno'] } }, false)).toThrow()
    const tentativa = await criarTentativaGoogle(), estado = `homologacao.${tentativa.estado}`
    const url = new URL(urlAutorizacaoGoogleWeb(cliente, tentativa, RETORNO_GOOGLE_TESTE, estado))
    expect(url.searchParams.get('prompt')).toBe('consent select_account')
    expect(url.searchParams.get('state')).toBe(estado)
    expect(url.searchParams.has('client_secret')).toBe(false)
    expect(url.searchParams.has('code_verifier')).toBe(false)
    expect(() => urlAutorizacaoGoogleWeb(cliente, tentativa, 'https://outro.example/retorno', estado)).toThrow()
  })
  test('formato Web exige e-mail/vínculo e formato Desktop permanece fechado', () => {
    const documento = { ...autorizacaoGoogleFicticia, formato: 2 as const, vinculoId: crypto.randomUUID(), emailGoogle: 'ficticio@example.invalid' }
    expect(lerAutorizacaoGoogle(documento)).toEqual(documento)
    expect(() => lerAutorizacaoGoogle({ ...documento, vinculoId: 'incorreto' })).toThrow()
    expect(() => lerAutorizacaoGoogle({ ...documento, emailGoogle: 'ficticio\n@example.invalid' })).toThrow()
    expect(() => lerAutorizacaoGoogle({ ...autorizacaoGoogleFicticia, vinculoId: documento.vinculoId })).toThrow()
  })
  test('iniciar exige sessão; UUID enviado pelo navegador e origem estranha são recusados antes de RPC', async () => {
    let chamadas = 0
    const handler = criarHandlerConexaoGoogle({ destino: autorizacaoGoogleFicticia.destino, autenticar: async () => null,
      rpc: async () => { chamadas++; throw new Error() } })
    const pedir = (body: unknown, origin = 'http://127.0.0.1:4174') => handler(new Request('https://servico.example/conexao', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect((await pedir({ acao: 'conectar' })).status).toBe(401)
    expect((await pedir({ acao: 'conectar', conta: crypto.randomUUID() })).status).toBe(400)
    expect((await pedir({ acao: 'conectar' }, 'https://fraude.example')).status).toBe(403)
    expect(chamadas).toBe(0)
  })
  test('cancelamento consome somente a tentativa e não grava autorização', async () => {
    const chamadas: string[] = []
    const handler = criarHandlerConexaoGoogle({ destino: autorizacaoGoogleFicticia.destino, autenticar: async () => null,
      rpc: async (nome) => { chamadas.push(nome); return { ambiente: 'local', destino: autorizacaoGoogleFicticia.destino, retorno: RETORNO_GOOGLE_TESTE,
        cliente: autorizacaoGoogleFicticia.cliente, anterior: null, email: null, googleId: null, conectadoEm: null } } })
    const r = await handler(new Request('https://servico.example/conexao', { method: 'POST', headers: { origin: 'http://127.0.0.1:4174', 'content-type': 'application/json' },
      body: JSON.stringify({ acao: 'cancelar', estado: `local.${'v'.repeat(43)}` }) }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ cancelado: true })
    expect(chamadas).toEqual(['consumir_tentativa_google'])
  })
  test('transporte mantém geração por instância e usa dispatcher apenas após ler autorização Web', async () => {
    const documento = { ...autorizacaoGoogleFicticia, formato: 2, vinculoId: crypto.randomUUID(), emailGoogle: 'ficticio@example.invalid' }
    const pedidos: { url: string; corpo: unknown }[] = []
    const transporte = criarTransporteBackup(autorizacaoGoogleFicticia.destino, 'chave-ficticia', async (url, opcoes) => {
      pedidos.push({ url, corpo: JSON.parse(String(opcoes.body)) })
      return Response.json(url.endsWith('obter_autorizacao_backup') ? documento : null)
    })
    await transporte.rpc('obter_autorizacao_backup', {})
    await transporte.rpc('ultimo_backup_confirmado', { conta: documento.contaId, destino: documento.destino })
    expect(pedidos[1]?.url).toEndWith('/rpc/rpc_backup_vinculado')
    expect(pedidos[1]?.corpo).toMatchObject({ vinculo: documento.vinculoId, nome: 'ultimo_backup_confirmado' })
  })
  test('cliente do app não aceita URL de autorização em domínio arbitrário', async () => {
    await expect(criarConexaoDrive(async () => ({ url: 'https://fraude.example/autorizar' })).conectar()).rejects.toThrow()
    await expect(criarConexaoDrive(async () => ({ preparado: true, vinculoId: crypto.randomUUID(), email: null, conectadoEm: null })).estado()).rejects.toThrow()
    expect(RETORNO_GOOGLE_PRODUCAO).toBe('https://controle-estoque-gastos.vercel.app/google-drive-retorno.html')
  })
  test('estado do aparelho usa a hora do banco, mesmo que o relógio do Edge esteja adiantado', async () => {
    const vinculoId = crypto.randomUUID(), conectadoEm = '2026-11-18T18:00:00.000Z'
    const documento = { ...autorizacaoGoogleFicticia, formato: 2, vinculoId, emailGoogle: 'ficticio@example.invalid', autorizadoEm: '2026-11-18T19:00:00.000Z' }
    const handler = criarHandlerBackupAparelho({ destino: documento.destino, autenticar: async () => documento.contaId,
      rpc: async (nome) => {
        if (nome === 'obter_autorizacao_backup') return documento
        if (nome === 'configuracao_google_web') return { anterior: vinculoId, conectadoEm }
        if (nome === 'ultimo_backup_confirmado') return null
        throw new Error('RPC inesperada')
      } })
    const r = await handler(new Request('https://servico.example/aparelho', { method: 'POST', headers: { authorization: 'Bearer sessao-ficticia' }, body: '{"acao":"estado"}' }))
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ vinculoId, conexaoEm: conectadoEm, ultima: null })
  })
  test('retorno confere renovação/conta antes de gravar e devolve somente e-mail, sem credenciais', async () => {
    let verificador: unknown, impressao: unknown, guardada: unknown
    const configuracao = { ambiente: 'local', destino: autorizacaoGoogleFicticia.destino, retorno: RETORNO_GOOGLE_TESTE,
      cliente: autorizacaoGoogleFicticia.cliente, anterior: null, email: null, googleId: null, conectadoEm: null }
    const handler = criarHandlerConexaoGoogle({ destino: autorizacaoGoogleFicticia.destino, autenticar: async () => autorizacaoGoogleFicticia.contaId,
      rpc: async (nome, p) => {
        if (nome === 'configuracao_google_web') return configuracao
        if (nome === 'abrir_tentativa_google') { verificador = p['verificador']; impressao = p['estado_hash']; return null }
        if (nome === 'consumir_tentativa_google') { expect(p['impressao']).toBe(impressao); return { ...configuracao, conta: autorizacaoGoogleFicticia.contaId, verificador } }
        if (nome === 'concluir_conexao_google') { guardada = p['documento']; return null }
        throw new Error('RPC inesperada')
      } })
    const pedir = (body: unknown, autenticada = false) => handler(new Request('https://servico.example/conexao', { method: 'POST',
      headers: { origin: 'http://127.0.0.1:4174', 'content-type': 'application/json', ...(autenticada ? { authorization: 'Bearer sessao-ficticia' } : {}) }, body: JSON.stringify(body) }))
    const inicio = await pedir({ acao: 'conectar' }, true)
    const { url }: { url: string } = await inicio.json()
    expect(url).not.toContain(String(verificador))
    const estado = new URL(url).searchParams.get('state')
    let renovacoes = 0
    const espiao = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], opcoes?: RequestInit) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        renovacoes++
        const campos = new URLSearchParams(String(opcoes?.body))
        if (renovacoes === 1) expect(campos.get('code_verifier')).toBe(String(verificador))
        return Response.json({ access_token: 'acesso-ficticio', refresh_token: 'renovacao-ficticia', token_type: 'Bearer', expires_in: 3600, scope: ESCOPO_DRIVE })
      }
      return Response.json({ user: { permissionId: 'google-ficticio', emailAddress: 'drive@example.invalid' }, storageQuota: { usage: '0', limit: '16106127360' } })
    }, { preconnect: fetch.preconnect }))
    try {
      const resposta = await pedir({ acao: 'concluir', estado, codigo: 'codigo-ficticio' })
      expect(resposta.status).toBe(200)
      expect(await resposta.json()).toEqual({ conectado: true, email: 'drive@example.invalid' })
      expect(renovacoes).toBe(2)
      expect(guardada).toMatchObject({ formato: 2, contaId: autorizacaoGoogleFicticia.contaId, contaGoogleId: 'google-ficticio', emailGoogle: 'drive@example.invalid' })
    } finally { espiao.mockRestore() }
  })
})
