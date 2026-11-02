import { ApplicationServer, importVapidKeys, PushMessageError, Urgency } from 'jsr:@negrel/webpush@0.5.0'
import { criarHandlerLembretes, criarRpcEmissor, ErroConfiguracaoEmissor } from './emissor.ts'

// A biblioteca fixada usa fetch global sem opção de transporte. Este invólucro exclusivo
// do Edge também impede redirects nas RPCs; nenhum endpoint pode redirecionar credenciais.
const transporte = globalThis.fetch.bind(globalThis)
globalThis.fetch = (entrada, opcoes) => transporte(entrada, { ...opcoes, redirect: 'error',
  signal: opcoes?.signal ?? AbortSignal.timeout(15_000) })

let servidor
async function preparar() {
  if (servidor) return
  const texto = Deno.env.get('LEMBRETES_VAPID_CHAVES') ?? ''
  if (!texto.trim()) throw new ErroConfiguracaoEmissor('chaves_ausentes')
  let chaves
  try { chaves = JSON.parse(texto) } catch { throw new ErroConfiguracaoEmissor('json_chaves') }
  if (typeof chaves !== 'object' || chaves === null || !chaves.publicKey || !chaves.privateKey) throw new ErroConfiguracaoEmissor('formato_chaves')
  let vapidKeys
  try { vapidKeys = await importVapidKeys(chaves, { extractable: false }) }
  catch { throw new ErroConfiguracaoEmissor('importacao_chaves') }
  try { servidor = await ApplicationServer.new({ contactInformation: Deno.env.get('LEMBRETES_VAPID_CONTATO') ?? '', vapidKeys }) }
  catch { throw new ErroConfiguracaoEmissor('servidor_push') }
}

const handler = criarHandlerLembretes({
  hashToken: Deno.env.get('LEMBRETES_TOKEN_SHA256') ?? '',
  agora: () => new Date().toISOString(),
  preparar,
  rpc: criarRpcEmissor(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''),
  async enviar(inscricao, mensagem, validade, topico) {
    try {
      await servidor.subscribe({ endpoint: inscricao.endpoint, keys: { p256dh: inscricao.p256dh, auth: inscricao.auth } })
        .pushTextMessage(mensagem, { ttl: validade, urgency: Urgency.Normal, topic: topico })
      return { estado: 'aceito' }
    } catch (erro) {
      if (!(erro instanceof PushMessageError)) return { estado: 'incerto' }
      const codigo = erro.response.status
      if (codigo === 404 || codigo === 410) return { estado: 'invalida' }
      if (codigo === 429 || codigo === 503) {
        const cabecalho = erro.response.headers.get('retry-after') ?? ''
        const data = /^\d+$/.test(cabecalho) ? Date.now() + Number(cabecalho) * 1000 : Date.parse(cabecalho)
        const retentarApos = new Date(Number.isFinite(data) && data >= Date.now() ? data : Date.now() + 15 * 60 * 1000).toISOString()
        return { estado: 'retentavel', retentarApos }
      }
      return { estado: 'problema' }
    }
  },
})

Deno.serve(handler)
