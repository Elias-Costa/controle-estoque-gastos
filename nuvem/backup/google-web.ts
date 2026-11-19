import { FalhaGoogle, PROJETO_GOOGLE_DE_PRODUCAO, PROJETO_GOOGLE_DE_TESTE, ESCOPO_DRIVE, RETORNO_GOOGLE_PRODUCAO, RETORNO_GOOGLE_TESTE, type ClienteGoogle, type TentativaGoogle } from './google.ts'

/** Cliente Web confirmado pelo mantenedor; seu segredo permanece no servidor. */
export function lerClienteGoogleWeb(v: unknown, producao: boolean): ClienteGoogle {
  const c = typeof v === 'object' && v !== null && !Array.isArray(v) && 'web' in v ? v.web : null
  if (typeof c !== 'object' || c === null || Array.isArray(c) || !('project_id' in c) ||
    c.project_id !== (producao ? PROJETO_GOOGLE_DE_PRODUCAO : PROJETO_GOOGLE_DE_TESTE) ||
    !('client_id' in c) || typeof c.client_id !== 'string' || !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(c.client_id) ||
    !('client_secret' in c) || typeof c.client_secret !== 'string' || c.client_secret.length < 1 || c.client_secret.length > 512 ||
    !('auth_uri' in c) || !['https://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/o/oauth2/auth'].includes(String(c.auth_uri)) ||
    !('token_uri' in c) || c.token_uri !== 'https://oauth2.googleapis.com/token' ||
    !('redirect_uris' in c) || !Array.isArray(c.redirect_uris) ||
    !c.redirect_uris.includes(producao ? RETORNO_GOOGLE_PRODUCAO : RETORNO_GOOGLE_TESTE)) {
    throw new FalhaGoogle('JSON precisa ser do cliente Aplicativo da Web deste ambiente, com o retorno confirmado.')
  }
  return { projetoId: producao ? PROJETO_GOOGLE_DE_PRODUCAO : PROJETO_GOOGLE_DE_TESTE, clienteId: c.client_id, segredo: c.client_secret }
}

/** Seleção explícita da conta e consentimento inicial, com PKCE e acesso persistente. */
export function urlAutorizacaoGoogleWeb(cliente: ClienteGoogle, tentativa: TentativaGoogle, retorno: string, estado: string): string {
  const producao = cliente.projetoId === PROJETO_GOOGLE_DE_PRODUCAO
  if (retorno !== (producao ? RETORNO_GOOGLE_PRODUCAO : RETORNO_GOOGLE_TESTE) ||
    (producao ? !estado.startsWith('producao.') : estado.startsWith('producao.')) ||
    !/^(producao|homologacao|local)\.[A-Za-z0-9_-]{43}$/.test(estado) ||
    !/^[A-Za-z0-9_-]{43}$/.test(tentativa.desafio)) throw new FalhaGoogle('Tentativa de conexão inválida.')
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({ client_id: cliente.clienteId, redirect_uri: retorno, response_type: 'code',
    scope: ESCOPO_DRIVE, state: estado, code_challenge: tentativa.desafio, code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false' }).toString()
  return url.href
}
