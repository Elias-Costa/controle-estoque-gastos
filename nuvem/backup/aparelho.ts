import { exigirCopia, objetoCopia } from '../../src/dados/formato-copia.ts'
import { LIMITES_COPIA } from '../../src/dados/tipos-copia.ts'
import type { PedidoBackupAparelho, RespostaBackupAparelho } from '../../src/plataforma/protocolo-backup.ts'
import type { RpcBackup } from './captura.ts'
import { lerAutorizacaoGoogle } from './cofre-google.ts'
import { criarDriveBackup } from './drive.ts'
import { consultarContaDrive, renovarTokensGoogle } from './google.ts'

const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const LIMITE_PEDIDO = LIMITES_COPIA.registros * 2 * 67 + 4096
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info', 'cache-control': 'no-store' }

function texto(v: unknown): string { exigirCopia(typeof v === 'string' && v.length > 0); return v }
function registro(v: unknown): Record<string, unknown> { exigirCopia(objetoCopia(v)); return v }

async function lerPedido(req: Request): Promise<PedidoBackupAparelho> {
  exigirCopia(req.body && Number(req.headers.get('content-length')) <= LIMITE_PEDIDO)
  const leitor = req.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  const partes: string[] = []
  let bytes = 0
  try {
    for (;;) {
      const bloco = await leitor.read()
      if (bloco.done) break
      bytes += bloco.value.byteLength
      exigirCopia(bytes <= LIMITE_PEDIDO)
      partes.push(decoder.decode(bloco.value, { stream: true }))
    }
  } finally { await leitor.cancel() }
  partes.push(decoder.decode())
  const v = registro(JSON.parse(partes.join(''))), campos = Object.keys(v).sort().join(',')
  const acao = v['acao']
  if (acao === 'estado' && campos === 'acao') return { acao }
  const captura = texto(v['captura']), aparelho = texto(v['aparelho'])
  exigirCopia(ID.test(captura) && ID.test(aparelho))
  if (acao === 'confirmar' && campos === 'acao,aparelho,captura') return { acao, captura, aparelho }
  const instante = texto(v['instante']), tamanho = v['tamanho'], sha256 = texto(v['sha256'])
  const material = v['material'], exclusivos = v['exclusivos']
  const hashes = (lista: unknown): lista is string[] => Array.isArray(lista) && lista.length <= LIMITES_COPIA.registros &&
    lista.every((h: unknown) => typeof h === 'string' && HASH.test(h))
  exigirCopia(acao === 'abrir' && campos === 'acao,aparelho,captura,exclusivos,instante,material,sha256,tamanho' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instante) && new Date(instante).toISOString() === instante &&
    typeof tamanho === 'number' && Number.isSafeInteger(tamanho) && tamanho > 0 && tamanho <= LIMITES_COPIA.arquivo &&
    HASH.test(sha256) && hashes(material) && hashes(exclusivos) && exclusivos.length <= material.length)
  return { acao, captura, aparelho, instante, tamanho, sha256, material, exclusivos }
}

/** Endpoint do app. O token do Cron e a autorização Google continuam confinados ao servidor. */
export function criarHandlerBackupAparelho({ rpc, destino, autenticar }: {
  readonly rpc: RpcBackup; readonly destino: string; readonly autenticar: (token: string) => Promise<string | null>
}) {
  function responder(v: unknown, status = 200): Response { return Response.json(v, { status, headers: CORS }) }
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (req.method !== 'POST') return responder({ erro: 'metodo_invalido' }, 405)
    const token = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(req.headers.get('authorization') ?? '')?.[1]
    const conta = token ? await autenticar(token) : null
    if (!conta || !ID.test(conta)) return responder({ erro: 'nao_autorizado' }, 401)
    let pedido: PedidoBackupAparelho
    try { pedido = await lerPedido(req) }
    catch { return responder({ erro: 'pedido_invalido' }, 400) }
    try {
      const guardada = await rpc('obter_autorizacao_backup', {})
      const auth = guardada === null ? null : lerAutorizacaoGoogle(guardada)
      const habilitado = auth !== null && auth.contaId === conta && auth.destino === destino
      if (pedido.acao === 'estado') return responder({ estado: 'configuracao', habilitado,
        ultima: habilitado ? await rpc('ultimo_backup_confirmado', { conta, destino }) : null })
      if (!habilitado) return responder({ erro: 'nao_autorizado' }, 403)

      const { captura, aparelho } = pedido
      const chave = { conta, destino, captura, aparelho }
      const atual = await rpc('consultar_backup_aparelho', chave)
      let envio = atual === null ? null : registro(atual)
      if (!envio && pedido.acao === 'confirmar') return responder({ erro: 'candidata_indisponivel' }, 404)
      if (envio && pedido.acao === 'abrir') {
        envio = registro(await rpc('reservar_backup_aparelho', { ...chave, instante: pedido.instante,
          arquivo: envio['arquivoId'], pasta: envio['pastaId'], tamanho: String(pedido.tamanho),
          sha256: pedido.sha256, material: pedido.material, exclusivos: pedido.exclusivos }))
      }
      function confirmada(reg: Record<string, unknown>): RespostaBackupAparelho {
        return { estado: 'pronta', confirmada: { origem: 'aparelho', capturadoEm: texto(reg['capturadoEm']) } }
      }
      if (envio && ['pronta', 'removendo', 'removida'].includes(texto(envio['estado']))) return responder(confirmada(envio))

      const tokens = await renovarTokensGoogle(auth.cliente, auth.renovacao)
      if (tokens.renovacao && tokens.renovacao !== auth.renovacao) {
        await rpc('atualizar_renovacao_backup', { conta, anterior: auth.renovacao, renovacao: tokens.renovacao })
      }
      const google = await consultarContaDrive(tokens.acesso)
      exigirCopia(google.id === auth.contaGoogleId, 'conta')
      const drive = criarDriveBackup(tokens.acesso, google.id, destino, conta)
      if (!envio) {
        exigirCopia(pedido.acao === 'abrir')
        if (google.limite !== undefined) exigirCopia(google.limite - google.uso >= BigInt(pedido.tamanho), 'limite')
        const pasta = texto(await rpc('reservar_pasta_backup', { conta, destino, pasta: await drive.gerarId() }))
        await drive.prepararPasta(pasta)
        envio = registro(await rpc('reservar_backup_aparelho', { ...chave, instante: pedido.instante,
          arquivo: await drive.gerarId(), pasta, tamanho: String(pedido.tamanho), sha256: pedido.sha256,
          material: pedido.material, exclusivos: pedido.exclusivos }))
      }
      const arquivo = texto(envio['arquivoId']), pasta = texto(envio['pastaId'])
      const tamanho = texto(envio['tamanho']), sha256 = texto(envio['sha256'])
      const remoto = await drive.consultar(arquivo, pasta, captura)
      if (remoto && !remoto.apagado && remoto.tamanho === tamanho && remoto.sha256 === sha256) {
        await rpc('confirmar_backup', { conta, captura, arquivo, tamanho, sha256 })
        // A rotação é retomada pelo Cron. A confirmação não depende da limpeza.
        return responder(confirmada(envio))
      }
      if (pedido.acao === 'confirmar' || remoto) return responder({ erro: 'copia_nao_conferida' }, 409)
      let sessao = typeof envio['sessao'] === 'string' ? envio['sessao'] : null
      let posicao = sessao ? await drive.consultarPosicao(sessao, Number(tamanho)) : null
      if (posicao === null) {
        const nova = await drive.iniciarSessao(arquivo, pasta, { id: captura, dia: texto(envio['dia']) }, Number(tamanho), 'aparelho')
        const depois = registro(await rpc('trocar_sessao_backup_aparelho', { ...chave, anterior: sessao, nova }))
        if (['pronta', 'removendo', 'removida'].includes(texto(depois['estado']))) return responder(confirmada(depois))
        sessao = texto(depois['sessao'])
        posicao = sessao === nova ? 0 : await drive.consultarPosicao(sessao, Number(tamanho))
      }
      exigirCopia(sessao && posicao !== null)
      return responder({ estado: 'enviando', sessao, posicao })
    } catch {
      return responder({ erro: 'backup_nao_concluido' }, 503)
    }
  }
}
