// D-085: retorno isolado, sem sessão Fichinhas, cookies, tokens ou recursos externos.
const parametros = new URLSearchParams(location.search)
history.replaceState(null, '', location.pathname)
const resultado = document.getElementById('resultado')
const estado = parametros.get('state') ?? ''
const codigo = parametros.get('code') ?? ''
const cancelado = parametros.has('error')
const destinos = {
  producao: 'https://awmesexptpalzonbucwc.supabase.co',
  homologacao: 'https://cfojhuvkiqcdnjhfstsj.supabase.co',
  local: 'http://127.0.0.1:54321',
}
const ambiente = /^(producao|homologacao|local)\.[A-Za-z0-9_-]{43}$/.exec(estado)?.[1]
const origemEsperada = ambiente === 'producao' ? 'https://controle-estoque-gastos.vercel.app' : 'http://127.0.0.1:4174'
async function concluir() {
  if (!resultado) return
  if (!ambiente || location.origin !== origemEsperada || (!cancelado && (!codigo || codigo.length > 4096)) || parametros.getAll('state').length !== 1 || parametros.getAll('code').length > 1) {
    resultado.textContent = 'Não deu para conferir esta autorização. Volte ao app e toque em Conectar Google Drive para tentar novamente.'
    return
  }
  try {
    const resposta = await fetch(`${destinos[ambiente]}/functions/v1/enviar-backup/conexao`, {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cancelado ? { acao: 'cancelar', estado } : { acao: 'concluir', estado, codigo }),
    })
    if (!resposta.ok) throw new Error()
    const valor = await resposta.json()
    if (cancelado && valor.cancelado === true) {
      resultado.textContent = 'A conexão foi cancelada. O Drive anterior continua como estava. Você pode tentar novamente pelo app.'
    } else if (valor.conectado === true && typeof valor.email === 'string') {
      resultado.textContent = `Google Drive conectado: ${valor.email}. As próximas cópias serão feitas nessa conta. Volte ao app para conferir a primeira cópia.`
    } else throw new Error()
  } catch {
    resultado.textContent = 'Não deu para concluir a conexão aqui. Volte ao app para conferir a conta conectada ou tentar novamente.'
  }
}
void concluir()
