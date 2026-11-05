/** Projeto público de teste confirmado pelo mantenedor em 05/11/2026; não inferir de um segredo. */
export const PROJETO_GOOGLE_DE_TESTE = 'fichinhas-backup-homologacao'
/** D-084: acesso somente aos arquivos criados/abertos pela aplicação. */
export const ESCOPO_DRIVE = 'https://www.googleapis.com/auth/drive.file'
const AUTORIZACAO = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'

/** Mensagem própria e fechada; erros HTTP/SQL originais podem conter credenciais. */
export class FalhaGoogle extends Error {}
/** Cliente Desktop: permanece fora do app e de qualquer pacote de backup. */
export type ClienteGoogle = { readonly projetoId: string; readonly clienteId: string; readonly segredo: string }
/** Par PKCE novo por tentativa; o verificador nunca vai na URL do navegador. */
export type TentativaGoogle = { readonly estado: string; readonly verificador: string; readonly desafio: string }
/** Tokens transitórios; somente a autorização de renovação será guardada no servidor. */
export type TokensGoogle = { readonly acesso: string; readonly renovacao?: string; readonly validadeSegundos: number }
/** Identidade do Drive e cota em bytes exatos, sem supor espaço suficiente para o backup. */
export type ContaDrive = { readonly id: string; readonly email: string; readonly uso: bigint; readonly limite?: bigint }

function objeto(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v) }
function texto(v: unknown, limite = 4096): v is string { return typeof v === 'string' && v.length > 0 && v.length <= limite }
function base64url(v: Uint8Array): string { return btoa(String.fromCharCode(...v)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }

/** Recusa cliente Web, outro projeto e endpoints fornecidos pelo arquivo antes de fazer rede. */
export function lerClienteGoogle(v: unknown): ClienteGoogle {
  const c = objeto(v) && !Object.hasOwn(v, 'web') ? v['installed'] : null
  if (!objeto(c) || c['project_id'] !== PROJETO_GOOGLE_DE_TESTE ||
    !texto(c['client_id'], 256) || !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(c['client_id']) ||
    !texto(c['client_secret'], 512) || ![AUTORIZACAO, 'https://accounts.google.com/o/oauth2/auth'].includes(String(c['auth_uri'])) || c['token_uri'] !== TOKEN ||
    !Array.isArray(c['redirect_uris']) || !c['redirect_uris'].includes('http://localhost')) {
    throw new FalhaGoogle('JSON precisa ser do cliente Desktop do projeto Google de teste confirmado.')
  }
  return { projetoId: c['project_id'], clienteId: c['client_id'], segredo: c['client_secret'] }
}

/** Usa SHA-256/entropia do sistema conforme OAuth Desktop, sem segredo ou senha na URL. */
export async function criarTentativaGoogle(): Promise<TentativaGoogle> {
  const verificador = base64url(crypto.getRandomValues(new Uint8Array(32)))
  return { estado: base64url(crypto.getRandomValues(new Uint8Array(32))), verificador,
    desafio: base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador)))) }
}

/** Autoriza apenas callback HTTP de loopback com porta efêmera; produção não é callback Desktop. */
export function urlAutorizacaoGoogle(cliente: ClienteGoogle, tentativa: TentativaGoogle, retorno: string): string {
  const uri = new URL(retorno)
  if (uri.origin !== `http://127.0.0.1:${uri.port}` || !uri.port || uri.pathname !== '/oauth2/retorno' || uri.search || uri.hash || uri.username || uri.password ||
    !/^[A-Za-z0-9_-]{43}$/.test(tentativa.estado) || !/^[A-Za-z0-9_-]{43}$/.test(tentativa.verificador) || !/^[A-Za-z0-9_-]{43}$/.test(tentativa.desafio)) {
    throw new FalhaGoogle('Retorno OAuth precisa ser o loopback privado desta tentativa.')
  }
  const url = new URL(AUTORIZACAO)
  url.search = new URLSearchParams({ client_id: cliente.clienteId, redirect_uri: retorno, response_type: 'code',
    scope: ESCOPO_DRIVE, state: tentativa.estado, code_challenge: tentativa.desafio, code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false' }).toString()
  return url.href
}

async function respostaGoogle(resposta: Response): Promise<unknown> {
  // Não propagar corpos de erro do provedor, que podem refletir código, token ou cabeçalhos.
  if (!resposta.ok || !resposta.body) { await resposta.body?.cancel(); throw new FalhaGoogle('Google recusou a operação; nenhum token foi exibido.') }
  const leitor = resposta.body.getReader(), partes: Uint8Array[] = []
  let tamanho = 0
  try {
    while (true) {
      const parte = await leitor.read()
      if (parte.done) break
      tamanho += parte.value.byteLength
      if (tamanho > 65_536) throw new FalhaGoogle('Resposta Google fora do formato esperado.')
      partes.push(parte.value)
    }
    const bytes = new Uint8Array(tamanho)
    let inicio = 0
    for (const parte of partes) { bytes.set(parte, inicio); inicio += parte.byteLength }
    return JSON.parse(new TextDecoder().decode(bytes))
  } finally { await leitor.cancel() }
}

async function pedirTokens(campos: Record<string, string>, renovar = false): Promise<TokensGoogle> {
  try {
    const v = await respostaGoogle(await fetch(TOKEN, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(campos) }))
    if (!objeto(v) || !texto(v['access_token']) || v['token_type'] !== 'Bearer' ||
      !Number.isSafeInteger(v['expires_in']) || typeof v['expires_in'] !== 'number' || v['expires_in'] <= 0 ||
      (v['scope'] !== undefined ? v['scope'] !== ESCOPO_DRIVE : !renovar) ||
      (!renovar && !texto(v['refresh_token'])) || (v['refresh_token'] !== undefined && !texto(v['refresh_token']))) {
      throw new FalhaGoogle('Resposta OAuth incompleta ou com escopo diferente de drive.file.')
    }
    return { acesso: v['access_token'], validadeSegundos: v['expires_in'],
      ...(typeof v['refresh_token'] === 'string' ? { renovacao: v['refresh_token'] } : {}) }
  } catch (e) { throw e instanceof FalhaGoogle ? e : new FalhaGoogle('Falha ao conversar com o Google; detalhes sensíveis omitidos.') }
}

/** Troca o código uma vez usando o verificador PKCE original e o mesmo callback. */
export function trocarCodigoGoogle(cliente: ClienteGoogle, tentativa: TentativaGoogle, retorno: string, codigo: string): Promise<TokensGoogle> {
  urlAutorizacaoGoogle(cliente, tentativa, retorno)
  return pedirTokens({ client_id: cliente.clienteId, client_secret: cliente.segredo, code: codigo,
    code_verifier: tentativa.verificador, redirect_uri: retorno, grant_type: 'authorization_code' })
}

/** Renovação somente no servidor/configurador, nunca na aplicação da usuária (D-084). */
export function renovarTokensGoogle(cliente: ClienteGoogle, renovacao: string): Promise<TokensGoogle> {
  return pedirTokens({ client_id: cliente.clienteId, client_secret: cliente.segredo, refresh_token: renovacao, grant_type: 'refresh_token' }, true)
}

/** Lê identidade/cota com drive.file; não cria pasta nem envia arquivos durante a autorização. */
export async function consultarContaDrive(acesso: string): Promise<ContaDrive> {
  try {
    const url = new URL('https://www.googleapis.com/drive/v3/about')
    url.searchParams.set('fields', 'user(permissionId,emailAddress),storageQuota(limit,usage)')
    const v = await respostaGoogle(await fetch(url, { headers: { authorization: `Bearer ${acesso}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) }))
    if (!objeto(v) || !objeto(v['user']) || !objeto(v['storageQuota'])) throw new FalhaGoogle('Conta/cota do Drive ausente.')
    const u = v['user'], q = v['storageQuota'], inteiro = (n: unknown): n is string => typeof n === 'string' && /^\d{1,30}$/.test(n)
    if (!texto(u['permissionId'], 256) || !texto(u['emailAddress'], 320) || [...u['emailAddress']].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      !inteiro(q['usage']) || (q['limit'] !== undefined && !inteiro(q['limit']))) throw new FalhaGoogle('Conta/cota do Drive inválida.')
    return { id: u['permissionId'], email: u['emailAddress'], uso: BigInt(q['usage']),
      ...(typeof q['limit'] === 'string' ? { limite: BigInt(q['limit']) } : {}) }
  } catch (e) { throw e instanceof FalhaGoogle ? e : new FalhaGoogle('Falha ao conferir conta/cota do Drive; detalhes sensíveis omitidos.') }
}
