import type { SupabaseClient } from '@supabase/supabase-js'
import type { FotoLocal, ProtecaoFoto } from '../dados/tipos-fotos.ts'
import { classificar, type Resposta } from './nuvem.ts'

/** Transporte privado de bytes e RPCs de coordenação; nunca faz parte da escrita local. */
export type NuvemFotos = {
  readonly rpc: (nome: string, argumentos: Record<string, unknown>) => Promise<Resposta<unknown>>
  readonly enviar: (caminho: string, bytes: Uint8Array) => Promise<Resposta<void>>
  readonly baixar: (caminho: string) => Promise<Resposta<Uint8Array>>
  readonly apagar: (caminho: string) => Promise<Resposta<void>>
}

/** Decodifica inclusive respostas de retentativa; referência malformada nunca autoriza liberação. */
export function protecaoDaNuvem(valor: unknown): ProtecaoFoto {
  if (!valor || typeof valor !== 'object') throw new Error('Proteção de foto malformada')
  const r: Record<string, unknown> = { ...valor }
  const id = (chave: string) => {
    const v = r[chave]
    if (typeof v !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)) throw new Error('Identidade de foto inválida')
    return v
  }
  const inteiro = (chave: string, maximo: number) => {
    const v = r[chave]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > maximo) throw new Error('Dimensão de foto inválida')
    return v
  }
  const fotoId = id('fotoId'), copiaId = id('copiaId')
  if (typeof r['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(r['sha256']) ||
    typeof r['disponivel'] !== 'boolean' || typeof r['caminho'] !== 'string' ||
    !new RegExp(`^[0-9a-f-]{36}/${fotoId}/${copiaId}\\.jpeg$`, 'i').test(r['caminho'])) throw new Error('Conteúdo de foto inválido')
  return { fotoId, copiaId, aparelhoId: id('aparelhoId'), geracao: id('geracao'),
    sha256: r['sha256'], caminho: r['caminho'], disponivel: r['disponivel'],
    bytes: inteiro('bytes', 204800), largura: inteiro('largura', 1024), altura: inteiro('altura', 1024) }
}

/** Documento imutável de registro; não transmite binários nem estado local na RPC. */
export function documentoDaFoto(foto: FotoLocal): Record<string, unknown> {
  return { fotoId: foto.id, copiaId: foto.copiaId, sha256: foto.sha256,
    bytes: foto.bytes, largura: foto.largura, altura: foto.altura }
}

/** Storage privado, sem sobrescrita: duplicata será conferida por leitura e hash pelo motor. */
export function criarNuvemFotos(supabase: SupabaseClient): NuvemFotos {
  const bucket = supabase.storage.from('fotos-produtos')
  function falha(erro: { message: string; statusCode?: string | number }): Resposta<never> {
    return { ok: false, falha: { tipo: String(erro.statusCode) === '401' ? 'sessao' : 'rede', mensagem: erro.message } }
  }
  return {
    rpc: async (nome, argumentos) => {
      const { data, error } = await supabase.rpc(nome, argumentos)
      return error ? { ok: false, falha: classificar(error) } : { ok: true, valor: data }
    },
    enviar: async (caminho, bytes) => {
      const { error } = await bucket.upload(caminho, bytes, { contentType: 'image/jpeg', upsert: false })
      if (error && String(error.statusCode) !== '409') return falha(error)
      return { ok: true, valor: undefined }
    },
    baixar: async (caminho) => {
      const { data, error } = await bucket.download(caminho)
      if (error) return falha(error)
      return { ok: true, valor: new Uint8Array(await data.arrayBuffer()) }
    },
    apagar: async (caminho) => {
      const { error } = await bucket.remove([caminho])
      return error ? falha(error) : { ok: true, valor: undefined }
    },
  }
}
