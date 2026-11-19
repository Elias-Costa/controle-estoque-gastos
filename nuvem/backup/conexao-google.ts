import { exigirCopia, objetoCopia } from '../../src/dados/formato-copia.ts'
import { hashDaFoto } from '../../src/plataforma/fotos.ts'
import type { RpcBackup } from './captura.ts'
import { lerAutorizacaoGoogle } from './cofre-google.ts'
import { ORIGEM_BACKUP_PRODUCAO } from './destino.ts'
import { PROJETO_DE_HOMOLOGACAO } from '../destinos-de-teste.ts'
import { consultarContaDrive, criarTentativaGoogle, renovarTokensGoogle, RETORNO_GOOGLE_PRODUCAO, RETORNO_GOOGLE_TESTE, trocarCodigoGoogleWeb } from './google.ts'
import { lerClienteGoogleWeb, urlAutorizacaoGoogleWeb } from './google-web.ts'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
function registro(v: unknown): Record<string, unknown> { exigirCopia(objetoCopia(v)); return v }
function texto(v: unknown): string { exigirCopia(typeof v === 'string'); return v }
async function lerCorpo(req: Request): Promise<Record<string, unknown>> {
  exigirCopia(req.body)
  const leitor = req.body.getReader(), partes: Uint8Array[] = []
  let tamanho = 0
  try {
    while (true) {
      const parte = await leitor.read()
      if (parte.done) break
      tamanho += parte.value.length; exigirCopia(tamanho <= 8192); partes.push(parte.value)
    }
  } finally { await leitor.cancel() }
  const bytes = new Uint8Array(tamanho)
  let inicio = 0
  for (const parte of partes) { bytes.set(parte, inicio); inicio += parte.length }
  return registro(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
}
function lerConfiguracao(v: unknown, destino: string) {
  const c = registro(v), ambiente = c['ambiente']
  exigirCopia((ambiente === 'local' || ambiente === 'homologacao' || ambiente === 'producao') && c['destino'] === destino &&
    destino === (ambiente === 'producao' ? ORIGEM_BACKUP_PRODUCAO : ambiente === 'local' ? 'http://127.0.0.1:54321' : `https://${PROJETO_DE_HOMOLOGACAO}.supabase.co`))
  const retorno = ambiente === 'producao' ? RETORNO_GOOGLE_PRODUCAO : RETORNO_GOOGLE_TESTE
  exigirCopia(c['retorno'] === retorno && (c['anterior'] === null || typeof c['anterior'] === 'string' && UUID.test(c['anterior'])))
  const cliente = registro(c['cliente'])
  return { ambiente, retorno, anterior: c['anterior'], email: c['email'], googleId: c['googleId'], conectadoEm: c['conectadoEm'], cliente: lerClienteGoogleWeb({ web: {
    project_id: cliente['projetoId'], client_id: cliente['clienteId'], client_secret: cliente['segredo'],
    auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: [retorno],
  } }, ambiente === 'producao') }
}

/** D-085: conexão iniciada pela sessão Fichinhas; callback de uso único não transporta sessão/segredos ao navegador. */
export function criarHandlerConexaoGoogle({ rpc, destino, autenticar }: {
  readonly rpc: RpcBackup; readonly destino: string; readonly autenticar: (token: string) => Promise<string | null>
}) {
  return async (req: Request): Promise<Response> => {
    const origem = req.headers.get('origin') ?? ''
    const permitidas = destino === ORIGEM_BACKUP_PRODUCAO ? [new URL(RETORNO_GOOGLE_PRODUCAO).origin] : [new URL(RETORNO_GOOGLE_TESTE).origin, 'http://localhost:4174']
    const headers = { 'access-control-allow-origin': permitidas.includes(origem) ? origem : 'null',
      'access-control-allow-headers': 'authorization,apikey,content-type,x-client-info', 'access-control-allow-methods': 'POST,OPTIONS',
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer', vary: 'Origin' }
    const responder = (v: unknown, status = 200) => Response.json(v, { status, headers })
    if (!permitidas.includes(origem)) return responder({ erro: 'origem_invalida' }, 403)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (req.method !== 'POST') return responder({ erro: 'metodo_invalido' }, 405)
    let pedido: Record<string, unknown>
    try { pedido = await lerCorpo(req) }
    catch { return responder({ erro: 'pedido_invalido' }, 400) }
    const acao = pedido['acao'], campos = Object.keys(pedido).sort().join(',')
    if (acao === 'estado' || acao === 'conectar') {
      if (campos !== 'acao') return responder({ erro: 'pedido_invalido' }, 400)
      const token = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(req.headers.get('authorization') ?? '')?.[1]
      const conta = token ? await autenticar(token) : null
      if (!conta || !UUID.test(conta)) return responder({ erro: 'nao_autorizado' }, 401)
      try {
        const valor = await rpc('configuracao_google_web', { conta })
        if (valor === null) return acao === 'estado' ? responder({ preparado: false, vinculoId: null, email: null, conectadoEm: null }) : responder({ erro: 'configuracao_pendente' }, 409)
        const c = lerConfiguracao(valor, destino)
        if (acao === 'estado') return responder({ preparado: true, vinculoId: c.anterior, email: c.email, conectadoEm: c.conectadoEm })
        const tentativa = await criarTentativaGoogle(), estado = `${c.ambiente}.${tentativa.estado}`
        await rpc('abrir_tentativa_google', { conta, estado_hash: await hashDaFoto(new TextEncoder().encode(estado)), verificador: tentativa.verificador, anterior: c.anterior })
        return responder({ url: urlAutorizacaoGoogleWeb(c.cliente, tentativa, c.retorno, estado) })
      } catch { return responder({ erro: 'conexao_indisponivel' }, 503) }
    }
    if ((acao !== 'concluir' && acao !== 'cancelar') || campos !== (acao === 'concluir' ? 'acao,codigo,estado' : 'acao,estado') ||
      typeof pedido['estado'] !== 'string' || !/^(producao|homologacao|local)\.[A-Za-z0-9_-]{43}$/.test(pedido['estado']) ||
      (acao === 'concluir' && (typeof pedido['codigo'] !== 'string' || pedido['codigo'].length < 1 || pedido['codigo'].length > 4096))) return responder({ erro: 'pedido_invalido' }, 400)
    try {
      const t = registro(await rpc('consumir_tentativa_google', { impressao: await hashDaFoto(new TextEncoder().encode(pedido['estado'])) }))
      const c = lerConfiguracao(t, destino)
      exigirCopia(pedido['estado'].startsWith(`${c.ambiente}.`))
      if (acao === 'cancelar') return responder({ cancelado: true })
      const tokens = await trocarCodigoGoogleWeb(c.cliente, texto(t['verificador']), c.retorno, texto(pedido['codigo']))
      exigirCopia(tokens.renovacao)
      const renovado = await renovarTokensGoogle(c.cliente, tokens.renovacao), google = await consultarContaDrive(renovado.acesso)
      const conta = texto(t['conta'])
      exigirCopia(UUID.test(conta))
      const vinculoId = c.anterior && c.googleId === google.id ? c.anterior : crypto.randomUUID()
      const documento = lerAutorizacaoGoogle({ formato: 2, ambiente: c.ambiente, destino, contaId: conta,
        contaGoogleId: google.id, cliente: c.cliente, renovacao: renovado.renovacao ?? tokens.renovacao,
        autorizadoEm: new Date().toISOString(), vinculoId, emailGoogle: google.email })
      await rpc('concluir_conexao_google', { conta, anterior: c.anterior, documento })
      return responder({ conectado: true, email: google.email })
    } catch { return responder({ erro: 'conexao_nao_concluida' }, 409) }
  }
}
