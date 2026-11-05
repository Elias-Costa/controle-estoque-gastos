import { carregarFontesBackup, dadosDaCaptura, lerCapturaServidor, materialDaCaptura, pacoteDaCaptura, type RpcBackup } from './captura.ts'
import { lerAutorizacaoGoogle } from './cofre-google.ts'
import { consultarContaDrive, renovarTokensGoogle } from './google.ts'
import { criarDriveBackup } from './drive.ts'
import { exigirCopia, objetoCopia } from '../../src/dados/formato-copia.ts'
import { hashDaFoto } from '../../src/plataforma/fotos.ts'

/** Etapas técnicas do executor, sem carregar conteúdo privado. */
export type EtapaBackupServidor = 'autorizacao' | 'captura' | 'leitura' | 'montagem' | 'pasta' | 'sessao' | 'envio' | 'conferencia' | 'retencao'
/** A observação de etapa não recebe dados, token, caminho ou capacidade de upload. */
export type PortasBackupServidor = { readonly rpc: RpcBackup; readonly destino: string; readonly baixarOriginal: (ref: Readonly<Record<string, unknown>>) => Promise<Uint8Array>
  readonly aoAvancar?: (etapa: EtapaBackupServidor) => void }
/** Resultado sem credenciais/capacidades de upload; pronta exige conferência do arquivo salvo. */
export type ResultadoBackupServidor = { readonly estado: 'pronta' | 'pendente'; readonly capturaId: string; readonly arquivoId?: string; readonly bytes?: number }

function registro(v: unknown): Record<string, unknown> { exigirCopia(objetoCopia(v)); return v }
function texto(v: unknown): string { exigirCopia(typeof v === 'string' && v.length > 0); return v }

/** Executa um passo durável: falha mantém captura/proteções e a cópia anterior, sem nova escrita no negócio. */
export async function executarBackupServidor(portas: PortasBackupServidor, agora: string, limiteBlocos = Number.MAX_SAFE_INTEGER, tamanhoBloco = 4 * 1024 * 1024): Promise<ResultadoBackupServidor> {
  const inicio = performance.now(), { rpc } = portas
  portas.aoAvancar?.('autorizacao')
  const autorizacao = lerAutorizacaoGoogle(await rpc('obter_autorizacao_backup', {}))
  exigirCopia(autorizacao.destino === portas.destino, 'conta')
  const conta = autorizacao.contaId, vinculo = { contaId: conta, destino: autorizacao.destino }
  const tokens = await renovarTokensGoogle(autorizacao.cliente, autorizacao.renovacao)
  if (tokens.renovacao && tokens.renovacao !== autorizacao.renovacao) {
    await rpc('atualizar_renovacao_backup', { conta, anterior: autorizacao.renovacao, renovacao: tokens.renovacao })
  }
  const google = await consultarContaDrive(tokens.acesso)
  exigirCopia(google.id === autorizacao.contaGoogleId, 'conta')
  const drive = criarDriveBackup(tokens.acesso, google.id, autorizacao.destino, conta)
  portas.aoAvancar?.('captura')
  const hoje = registro(await rpc('capturar_backup_servidor', { conta, captura: crypto.randomUUID(), destino: vinculo.destino, agora }))
  const proxima = await rpc('proxima_captura_backup', { conta })
  let cabecalho = hoje
  if (proxima !== null) {
    const pendente = lerCapturaServidor(proxima, vinculo)
    cabecalho = registro(await rpc('capturar_backup_servidor', { conta, captura: pendente.id, destino: vinculo.destino, agora: pendente.capturadoEm }))
  }
  if (cabecalho['estado'] === 'aguardando') return { estado: 'pendente', capturaId: texto(cabecalho['id']) }
  const captura = lerCapturaServidor(cabecalho, vinculo)
  let envio = registro(await rpc('consultar_upload_backup', { conta, captura: captura.id }))
  let arquivoId = typeof envio['arquivoId'] === 'string' ? envio['arquivoId'] : null
  let pasta = typeof envio['pastaId'] === 'string' ? envio['pastaId'] : null
  let conferido = false
  if (arquivoId && pasta) {
    const remoto = await drive.consultar(arquivoId, pasta, captura.id)
    conferido = !!remoto && !remoto.apagado && remoto.tamanho === envio['tamanho'] && remoto.sha256 === envio['sha256']
  }
  if (!conferido) {
    exigirCopia(cabecalho['estado'] !== 'pronta')
    portas.aoAvancar?.('leitura')
    const fontes = await carregarFontesBackup(rpc, captura)
    const dados = await dadosDaCaptura(captura, fontes, portas.baixarOriginal)
    portas.aoAvancar?.('montagem')
    const material = await materialDaCaptura(dados), arquivo = await pacoteDaCaptura(captura, dados)
    const sha256 = await hashDaFoto(new Uint8Array(await arquivo.arrayBuffer()))
    if (!arquivoId && google.limite !== undefined) exigirCopia(google.limite - google.uso >= BigInt(arquivo.size), 'limite')
    portas.aoAvancar?.('pasta')
    if (!pasta) pasta = texto(await rpc('reservar_pasta_backup', { conta, destino: vinculo.destino, pasta: await drive.gerarId() }))
    await drive.prepararPasta(pasta)
    if (!arquivoId) arquivoId = await drive.gerarId()
    let sessao = typeof envio['sessao'] === 'string' ? envio['sessao'] : null
    const registrar = async (uri: string | null) => {
      await rpc('registrar_upload_backup', { conta, captura: captura.id, arquivo: arquivoId, pasta, sessao: uri,
        tamanho: String(arquivo.size), sha256, material, exclusivos: [] })
    }
    // Reservar id/hash antes do HTTP impede duplicação mesmo perdendo a resposta do provedor.
    await registrar(sessao)
    portas.aoAvancar?.('sessao')
    let posicao = sessao ? await drive.consultarPosicao(sessao, arquivo.size) : null
    if (posicao === null) { sessao = await drive.iniciarSessao(arquivoId, pasta, captura, arquivo.size); await registrar(sessao); posicao = 0 }
    exigirCopia(sessao)
    let blocos = 0
    while (posicao < arquivo.size) {
      if (blocos >= limiteBlocos || performance.now() - inicio > 110_000) return { estado: 'pendente', capturaId: captura.id }
      portas.aoAvancar?.('envio')
      posicao = await drive.enviarBloco(sessao, arquivo, posicao, tamanhoBloco); blocos++
    }
    envio = registro(await rpc('consultar_upload_backup', { conta, captura: captura.id }))
    const remoto = await drive.consultar(arquivoId, pasta, captura.id)
    exigirCopia(remoto && !remoto.apagado && remoto.tamanho === String(arquivo.size) && remoto.sha256 === sha256)
  }
  exigirCopia(arquivoId && pasta)
  portas.aoAvancar?.('conferencia')
  await rpc('confirmar_backup', { conta, captura: captura.id, arquivo: arquivoId, tamanho: texto(envio['tamanho']), sha256: texto(envio['sha256']) })
  portas.aoAvancar?.('retencao')
  const rotacao = await rpc('planejar_rotacao_backup', { conta })
  exigirCopia(Array.isArray(rotacao))
  for (const item of rotacao) {
    const r = registro(item), id = texto(r['id']), arquivo = texto(r['arquivoId']), pastaAntiga = texto(r['pastaId'])
    await drive.remover(arquivo, pastaAntiga, id)
    await rpc('concluir_rotacao_backup', { conta, captura: id, arquivo })
  }
  return { estado: 'pronta', capturaId: captura.id, arquivoId, bytes: Number(texto(envio['tamanho'])) }
}
