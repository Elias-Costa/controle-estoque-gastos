import { timingSafeEqual } from 'node:crypto'
import { FalhaGoogle } from './google.ts'

/** Retorno temporário restrito ao próprio Windows, sem código/token nas respostas ou logs. */
export function abrirRetornoGoogle(estado: string, prazoMs = 300_000) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(estado)) throw new FalhaGoogle('Estado OAuth inválido.')
  const pendente = Promise.withResolvers<string>()
  // A abertura do navegador pode falhar antes de o chamador aguardar a promessa.
  void pendente.promise.catch(() => {})
  let encerrada = false
  const resposta = (texto: string, status: number) => new Response(texto, { status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' } })
  const servidor = Bun.serve({ hostname: '127.0.0.1', port: 0, development: false, maxRequestBodySize: 1024,
    fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'GET' || url.origin !== `http://127.0.0.1:${servidor.port}` || req.headers.get('host') !== url.host || url.pathname !== '/oauth2/retorno') {
        return resposta('Retorno inválido.', 400)
      }
      if (encerrada) return resposta('Esta tentativa já foi encerrada.', 410)
      const recebido = url.searchParams.get('state')
      if (url.searchParams.getAll('state').length !== 1 || !recebido || !/^[A-Za-z0-9_-]{43}$/.test(recebido) ||
        !timingSafeEqual(Buffer.from(recebido), Buffer.from(estado))) return resposta('Retorno inválido.', 400)
      const codigo = url.searchParams.get('code')
      if (url.searchParams.has('error')) {
        encerrada = true; clearTimeout(prazo)
        pendente.reject(new FalhaGoogle('Autorização Google não foi concedida.'))
        return resposta('Autorização não concluída. Volte ao terminal.', 400)
      }
      if (url.searchParams.getAll('code').length !== 1 || !codigo || codigo.length > 4096) return resposta('Retorno inválido.', 400)
      encerrada = true; clearTimeout(prazo); pendente.resolve(codigo)
      return resposta('Resposta recebida. Volte ao terminal para conferir a conta e concluir.', 200)
    },
    error() { return resposta('Retorno inválido.', 400) },
  })
  const prazo = setTimeout(() => { encerrada = true; pendente.reject(new FalhaGoogle('Prazo de autorização encerrado; tente novamente.')); void servidor.stop(true) }, prazoMs)
  return { url: `http://127.0.0.1:${servidor.port}/oauth2/retorno`, codigo: pendente.promise,
    fechar() { encerrada = true; clearTimeout(prazo); pendente.reject(new FalhaGoogle('Tentativa encerrada.')); void servidor.stop() } }
}
