import { exigirCopia, objetoCopia } from '../../src/dados/formato-copia.ts'
import { sessaoDoDrive } from '../../src/plataforma/protocolo-backup.ts'

/** Erro fechado: não carrega corpo HTTP, URI de upload ou token na mensagem. */
export class FalhaDrive extends Error {
  readonly status: number
  constructor(status: number) { super(`Drive indisponível ou resposta não conferida (HTTP ${status}).`); this.status = status }
}
/** Porta HTTP injetável só no instrumento; o cliente real recusa redirects de credenciais. */
export type TransporteDrive = (url: string, opcoes: RequestInit) => Promise<Response>
/** Metadados mínimos para confirmar propriedade, privacidade e os bytes do candidato gerenciado. */
export type ArquivoDrive = { readonly id: string; readonly pastaId?: string; readonly tamanho?: string; readonly sha256?: string; readonly apagado: boolean }
const API = 'https://www.googleapis.com/drive/v3/files'
const CAMPOS = 'id,mimeType,parents,size,sha256Checksum,ownedByMe,shared,trashed,appProperties,permissions(id,type,role)'
const idValido = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(v)

/** Cliente restrito ao catálogo do backup; nem nome/pasta sozinhos autorizam substituir/remover arquivo. */
export function criarDriveBackup(acesso: string, contaGoogleId: string, destino: string, contaId: string,
  transporte: TransporteDrive = (url, opcoes) => fetch(url, opcoes)) {
  const propriedades = { fichinhas: 'backup-v1', destino, conta: contaId }
  async function pedir(url: string, opcoes: RequestInit = {}, retomavel = false): Promise<Response> {
    let resposta: Response
    try {
      const headers = new Headers(opcoes.headers); headers.set('authorization', `Bearer ${acesso}`)
      // Drive usa 308 sem Location como confirmação parcial. Ler o status sem seguir redirects.
      resposta = await transporte(url, { ...opcoes, headers, redirect: retomavel ? 'manual' : 'error', signal: AbortSignal.timeout(20_000) })
    } catch { throw new FalhaDrive(0) }
    if (retomavel && resposta.status >= 300 && resposta.status < 400 && (resposta.status !== 308 || resposta.headers.has('location'))) {
      await resposta.body?.cancel(); throw new FalhaDrive(resposta.status)
    }
    return resposta
  }
  async function lerJson(r: Response): Promise<unknown> {
    if (!r.ok) { await r.body?.cancel(); throw new FalhaDrive(r.status) }
    try {
      const t = await r.text()
      if (new TextEncoder().encode(t).byteLength > 262144) throw new Error()
      return JSON.parse(t)
    } catch { throw new FalhaDrive(r.status) }
  }
  function conferir(v: unknown, id: string, pasta?: string, captura?: string): ArquivoDrive {
    exigirCopia(objetoCopia(v) && v['id'] === id && v['ownedByMe'] === true && v['shared'] !== true && typeof v['trashed'] === 'boolean')
    const props = v['appProperties'], permissoes = v['permissions']
    exigirCopia(objetoCopia(props) && Object.entries(propriedades).every(([k, valor]) => props[k] === valor))
    exigirCopia(Array.isArray(permissoes) && permissoes.length === 1 && permissoes.every((p: unknown) =>
      objetoCopia(p) && p['type'] === 'user' && p['role'] === 'owner' && p['id'] === contaGoogleId))
    if (pasta) {
      exigirCopia(v['mimeType'] === 'application/zip' && Array.isArray(v['parents']) && v['parents'].length === 1 && v['parents'][0] === pasta && props['captura'] === captura)
    } else exigirCopia(v['mimeType'] === 'application/vnd.google-apps.folder')
    exigirCopia(v['size'] === undefined || typeof v['size'] === 'string' && /^\d+$/.test(v['size']))
    exigirCopia(v['sha256Checksum'] === undefined || typeof v['sha256Checksum'] === 'string' && /^[a-f0-9]{64}$/.test(v['sha256Checksum']))
    return { id, apagado: v['trashed'], ...(pasta ? { pastaId: pasta } : {}),
      ...(typeof v['size'] === 'string' ? { tamanho: v['size'] } : {}), ...(typeof v['sha256Checksum'] === 'string' ? { sha256: v['sha256Checksum'] } : {}) }
  }
  async function consultar(id: string, pasta?: string, captura?: string): Promise<ArquivoDrive | null> {
    exigirCopia(idValido(id) && (!pasta || idValido(pasta)))
    const r = await pedir(`${API}/${id}?fields=${encodeURIComponent(CAMPOS)}`)
    if (r.status === 404) { await r.body?.cancel(); return null }
    return conferir(await lerJson(r), id, pasta, captura)
  }
  function posicao(r: Response, tamanho: number): number {
    const range = r.headers.get('range')
    if (r.status === 200 || r.status === 201) return tamanho
    if (r.status !== 308) throw new FalhaDrive(r.status)
    if (!range) return 0
    const partes = /^bytes=0-(\d+)$/.exec(range)
    exigirCopia(partes?.[1] && Number.isSafeInteger(Number(partes[1])) && Number(partes[1]) < tamanho)
    return Number(partes[1]) + 1
  }
  return {
    /** Identidade é reservada no SQL antes do POST, resolvendo resposta perdida sem arquivo duplicado. */
    async gerarId(): Promise<string> {
      const v = await lerJson(await pedir(`${API}/generateIds?count=1&space=drive`))
      exigirCopia(objetoCopia(v) && Array.isArray(v['ids']) && v['ids'].length === 1 && idValido(v['ids'][0]))
      return v['ids'][0]
    },
    consultar,
    /** Somente pasta criada pela aplicação, privada e de propriedade da conta OAuth conferida. */
    async prepararPasta(id: string): Promise<void> {
      let atual = await consultar(id)
      if (!atual) {
        const r = await pedir(`${API}?fields=id`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, name: `Fichinhas — backup de teste — ${contaId.slice(0, 8)}`, mimeType: 'application/vnd.google-apps.folder', appProperties: propriedades }) })
        if (!r.ok && r.status !== 409) { await r.body?.cancel(); throw new FalhaDrive(r.status) }
        await r.body?.cancel(); atual = await consultar(id)
      }
      exigirCopia(atual && !atual.apagado)
    },
    /** Cria/retoma somente a candidata identificada; a cópia anterior nunca é sobrescrita. */
    async iniciarSessao(id: string, pasta: string, c: { id: string; dia: string }, tamanho: number, origem: 'servidor' | 'aparelho' = 'servidor'): Promise<string> {
      const existente = await consultar(id, pasta, c.id)
      exigirCopia(!existente?.apagado)
      const url = `https://www.googleapis.com/upload/drive/v3/files${existente ? '/' + id : ''}?uploadType=resumable&fields=id`
      const r = await pedir(url, { method: existente ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json',
        'x-upload-content-type': 'application/zip', 'x-upload-content-length': String(tamanho) },
      body: JSON.stringify(existente ? { mimeType: 'application/zip' } : { id,
        name: `fichinhas-${c.dia}-${origem}-${c.id.slice(0, 8)}.zip`, mimeType: 'application/zip', parents: [pasta],
        appProperties: { ...propriedades, captura: c.id, origem, dia: c.dia } }) })
      if (!r.ok) { await r.body?.cancel(); throw new FalhaDrive(r.status) }
      const uri = r.headers.get('location'); await r.body?.cancel(); exigirCopia(uri)
      return sessaoDoDrive(uri)
    },
    /** Pergunta a posição recebida; não presume aceite pela quantidade enviada antes da interrupção. */
    async consultarPosicao(uri: string, tamanho: number): Promise<number | null> {
      const r = await pedir(sessaoDoDrive(uri), { method: 'PUT', headers: { 'content-range': `bytes */${tamanho}`, 'content-length': '0' } }, true)
      if (r.status === 404 || r.status === 410) { await r.body?.cancel(); return null }
      const recebida = posicao(r, tamanho); await r.body?.cancel(); return recebida
    },
    /** Blocos de 256 KiB, exceto o último; retorno é a posição efetivamente informada pelo Drive. */
    async enviarBloco(uri: string, arquivo: Blob, inicio: number, comprimento = 4 * 1024 * 1024): Promise<number> {
      exigirCopia(Number.isSafeInteger(inicio) && inicio >= 0 && inicio < arquivo.size && comprimento > 0 && comprimento % 262144 === 0)
      const fim = Math.min(inicio + comprimento, arquivo.size)
      const r = await pedir(sessaoDoDrive(uri), { method: 'PUT', headers: { 'content-type': 'application/zip', 'content-length': String(fim - inicio),
        'content-range': `bytes ${inicio}-${fim - 1}/${arquivo.size}` }, body: arquivo.slice(inicio, fim) }, true)
      const recebida = posicao(r, arquivo.size); await r.body?.cancel()
      exigirCopia(recebida > inicio && recebida <= fim)
      return recebida
    },
    /** Baixa somente o ZIP gerenciado conferido; usado na prova real de restauração. */
    async baixar(id: string, pasta: string, captura: string): Promise<Blob> {
      const atual = await consultar(id, pasta, captura); exigirCopia(atual && !atual.apagado)
      const r = await pedir(`${API}/${id}?alt=media`)
      if (!r.ok) { await r.body?.cancel(); throw new FalhaDrive(r.status) }
      const arquivo = await r.blob(); exigirCopia(arquivo.size <= 268435456)
      return arquivo
    },
    /** D-084 autoriza somente exclusão dos arquivos gerenciados já liberados pelo plano de rotação. */
    async remover(id: string, pasta: string, captura: string): Promise<void> {
      const atual = await consultar(id, pasta, captura)
      if (!atual) return
      const r = await pedir(`${API}/${id}`, { method: 'DELETE' })
      if (!r.ok && r.status !== 404) { await r.body?.cancel(); throw new FalhaDrive(r.status) }
      await r.body?.cancel()
      exigirCopia(await consultar(id, pasta, captura) === null)
    },
  }
}
