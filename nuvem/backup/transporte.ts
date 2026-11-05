import { PROJETO_DE_HOMOLOGACAO } from '../destinos-de-teste.ts'
import { exigirCopia, objetoCopia } from '../../src/dados/formato-copia.ts'
import type { RpcBackup } from './captura.ts'

/** Diagnóstico sem URL, cabeçalho, corpo do PostgREST ou credencial. */
export class FalhaTransporteBackup extends Error {
  readonly status: number
  constructor(status: number) { super(`Transporte de backup indisponível (HTTP ${status}).`); this.status = status }
}
const RPCS_SEM_CORPO = new Set(['registrar_upload_backup', 'confirmar_backup', 'concluir_rotacao_backup', 'cancelar_captura_backup', 'atualizar_renovacao_backup'])
const RPCS = new Set([...RPCS_SEM_CORPO, 'capturar_backup_servidor', 'ler_captura_backup', 'consultar_upload_backup',
  'planejar_rotacao_backup', 'proxima_captura_backup', 'reservar_pasta_backup', 'obter_autorizacao_backup',
  'ultimo_backup_confirmado', 'consultar_backup_aparelho', 'reservar_backup_aparelho', 'trocar_sessao_backup_aparelho'])

/** Exclusivo do servidor de teste; credencial administrativa nunca sai para Google/app/ZIP. */
export function criarTransporteBackup(api: string, chave: string, transportar: (url: string, opcoes: RequestInit) => Promise<Response> = fetch) {
  exigirCopia(['http://127.0.0.1:54321', 'http://kong:8000', `https://${PROJETO_DE_HOMOLOGACAO}.supabase.co`].includes(api) && chave.length > 0)
  async function corpo(r: Response, limite: number): Promise<Uint8Array> {
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
    try { return await transportar(api + caminho, { ...opcoes, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { apikey: chave, authorization: `Bearer ${chave}`, 'content-type': 'application/json' } }) }
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
  return { rpc,
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
