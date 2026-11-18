import { PROJETO_DE_HOMOLOGACAO } from '../destinos-de-teste.ts'
import { exigirCopia, objetoCopia } from '../../src/dados/formato-copia.ts'
import type { RpcBackup } from './captura.ts'
import { BYTES_PARTE, caminhoDeLote, type ArmazemDeLotes } from './lotes.ts'

/** Diagnóstico sem URL, cabeçalho, corpo do PostgREST ou credencial. */
export class FalhaTransporteBackup extends Error {
  readonly status: number
  constructor(status: number) { super(`Transporte de backup indisponível (HTTP ${status}).`); this.status = status }
}
const RPCS_SEM_CORPO = new Set(['registrar_upload_backup', 'confirmar_backup', 'concluir_rotacao_backup', 'cancelar_captura_backup', 'atualizar_renovacao_backup',
  'reservar_objetos_backup', 'avancar_preparo_backup', 'soltar_preparo_backup'])
const RPCS = new Set([...RPCS_SEM_CORPO, 'capturar_backup_servidor', 'ler_captura_backup', 'consultar_upload_backup',
  'planejar_rotacao_backup', 'proxima_captura_backup', 'reservar_pasta_backup', 'obter_autorizacao_backup',
  'ultimo_backup_confirmado', 'consultar_backup_aparelho', 'reservar_backup_aparelho', 'trocar_sessao_backup_aparelho', 'assumir_preparo_backup'])

/** Exclusivo do servidor de teste; credencial administrativa nunca sai para Google/app/ZIP. */
export function criarTransporteBackup(api: string, chave: string, transportar: (url: string, opcoes: RequestInit) => Promise<Response> = fetch) {
  exigirCopia(['http://127.0.0.1:54321', 'http://kong:8000', `https://${PROJETO_DE_HOMOLOGACAO}.supabase.co`].includes(api) && chave.length > 0)
  async function corpo(r: Response, limite: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!r.ok || !r.body) { await r.body?.cancel(); throw new FalhaTransporteBackup(r.status) }
    const leitor = r.body.getReader(), partes: Uint8Array[] = []; let tamanho = 0
    try {
      while (true) {
        const parte = await leitor.read(); if (parte.done) break
        tamanho += parte.value.byteLength; exigirCopia(tamanho <= limite, 'limite'); partes.push(parte.value)
      }
    } finally { await leitor.cancel() }
    const bytes = new Uint8Array(tamanho); let inicio = 0
    for (const parte of partes) { bytes.set(parte, inicio); inicio += parte.byteLength }
    return bytes
  }
  async function pedir(caminho: string, opcoes: RequestInit = {}): Promise<Response> {
    const headers = new Headers(opcoes.headers)
    headers.set('apikey', chave); headers.set('authorization', `Bearer ${chave}`)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    try { return await transportar(api + caminho, { ...opcoes, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers }) }
    catch { throw new FalhaTransporteBackup(0) }
  }
  const rpc: RpcBackup = async (nome, argumentos) => {
    exigirCopia(RPCS.has(nome))
    const resposta = await pedir(`/rest/v1/rpc/${nome}`, { method: 'POST', body: JSON.stringify(argumentos) })
    // PostgREST devolve 204 para RETURNS void. Só essas mutações aceitam resposta vazia.
    if (resposta.status === 204 && RPCS_SEM_CORPO.has(nome)) return null
    const bytes = await corpo(resposta, 8 * 1024 * 1024)
    if (bytes.byteLength === 0 && RPCS_SEM_CORPO.has(nome)) return null
    try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new FalhaTransporteBackup(200) }
  }
  async function corpoDaParte(r: Response, tamanho: number): Promise<Uint8Array<ArrayBuffer>> {
    exigirCopia(r.body)
    const bytes = new Uint8Array(tamanho), leitor = r.body.getReader()
    let posicao = 0
    try {
      while (true) {
        const parte = await leitor.read(); if (parte.done) break
        exigirCopia(posicao + parte.value.length <= tamanho, 'limite')
        bytes.set(parte.value, posicao); posicao += parte.value.length
      }
    } finally { await leitor.cancel() }
    exigirCopia(posicao === tamanho)
    return bytes
  }
  const partes: ArmazemDeLotes = {
    async gravar(caminho, bytes) {
      exigirCopia(caminhoDeLote(caminho) && bytes.length > 0 && bytes.length <= BYTES_PARTE)
      const r = await pedir('/storage/v1/object/backup-partes/' + caminho, { method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'false' }, body: bytes })
      if (r.status === 400) {
        // A API legada do Storage encapsula o conflito de chave em HTTP 400.
        const resposta: unknown = await r.json().catch(() => undefined)
        if (objetoCopia(resposta) && resposta['statusCode'] === '409' && resposta['code'] === 'KeyAlreadyExists') return
        throw new FalhaTransporteBackup(r.status)
      }
      await r.body?.cancel()
      // O escritor confere tamanho e SHA também quando a tentativa anterior já gravou.
      if (!r.ok && r.status !== 409) throw new FalhaTransporteBackup(r.status)
    },
    async ler(caminho, inicio, fim, total) {
      exigirCopia(caminhoDeLote(caminho) && [inicio, fim, total].every(Number.isSafeInteger) && inicio >= 0 && fim > inicio && fim <= total && total <= BYTES_PARTE)
      const inteiro = inicio === 0 && fim === total
      const r = await pedir('/storage/v1/object/authenticated/backup-partes/' + caminho,
        inteiro ? {} : { headers: { range: `bytes=${inicio}-${fim - 1}` } })
      if (r.status !== (inteiro ? 200 : 206) || !inteiro && r.headers.get('content-range') !== `bytes ${inicio}-${fim - 1}/${total}`) {
        await r.body?.cancel(); throw new FalhaTransporteBackup(r.status)
      }
      return corpoDaParte(r, fim - inicio)
    },
    async apagar(caminhos) {
      exigirCopia(caminhos.length <= 32 && caminhos.every((c) => caminhoDeLote(c)))
      if (!caminhos.length) return
      const r = await pedir('/storage/v1/object/backup-partes', { method: 'DELETE', body: JSON.stringify({ prefixes: caminhos }) })
      await r.body?.cancel()
      if (!r.ok) throw new FalhaTransporteBackup(r.status)
    },
  }
  return { rpc, partes,
    /** Valida o bearer do app no Auth do mesmo projeto. O browser nunca fornece conta por argumento. */
    async autenticar(token: string): Promise<string | null> {
      try {
        const r = await transportar(api + '/auth/v1/user', { redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { apikey: chave, authorization: `Bearer ${token}` } })
        const u: unknown = JSON.parse(new TextDecoder().decode(await corpo(r, 128 * 1024)))
        return objetoCopia(u) && typeof u['id'] === 'string' ? u['id'] : null
      } catch { return null }
    },
    /** Caminho conferido pela captura; size/hash são revalidados antes do empacotamento. */
    async baixarOriginal(referencia: Readonly<Record<string, unknown>>): Promise<Uint8Array> {
      const caminho = referencia['caminho']
      exigirCopia(typeof caminho === 'string' && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpeg$/.test(caminho), 'foto')
      return corpo(await pedir('/storage/v1/object/authenticated/fotos-produtos/' + caminho), 204800)
    } }
}
