import { createHash } from 'node:crypto'
import { BlobReader, Reader, ZipWriter, type CreateReadableOptions } from '@zip.js/zip.js/lib/zip-core.js'
import { exigirCopia, objetoCopia } from '../../src/dados/formato-copia.ts'
import { LIMITES_COPIA as L } from '../../src/dados/tipos-copia.ts'
import { escritorDaCopia, type ArquivoListado } from '../../src/plataforma/arquivo-copia.ts'

/** Objeto físico do preparo. Um lote ZIP pode ocupar mais de um objeto. */
export const BYTES_PARTE = 4 * 1024 * 1024
const BYTES_LOTE = 9 * 1024 * 1024
// BA-04: teto de trabalho para somar fechamento e envio na mesma chamada.
const LIMITE_PARA_RETER = 96 * 1024 * 1024
const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const CAMINHO = new RegExp(`^${UUID}/${UUID}/[a-f0-9]{64}\\.bin$`)
const NOME = /^(?:dados\/[a-zA-Z]+\/\d{6}\.json|fotos\/[0-9a-f-]{36}\.jpeg|consultas\/(?:fichas|estoque|caixa)\.csv|manifesto\.json)$/

/** Leitura e escrita somente no bucket privado do preparo. Intervalos são semiabertos. */
export type ArmazemDeLotes = {
  gravar(caminho: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>
  ler(caminho: string, inicio: number, fim: number, total: number): Promise<Uint8Array<ArrayBuffer>>
  apagar(caminhos: readonly string[]): Promise<void>
}
/** Identidade de objeto registrada antes da rede. */
export type ParteGravada = { caminho: string; bytes: number; sha256: string }
/** ZIP parcial e inventário das entradas efetivamente escritas. */
export type LoteGravado = { segmentos: ParteGravada[]; arquivos: ArquivoListado[] }
/** Prefixos dos objetos, em ordem, seguidos do diretório produzido pelo zip.js. */
export type IndiceDoZip = { trechos: { parte: ParteGravada; bytes: number }[]; tamanho: number; sha256: string }
/** Registro dos objetos que um passo está autorizado a criar, antes do HTTP. */
export type ReservarObjetos = (partes: readonly ParteGravada[]) => Promise<void>

/** SHA nativo apenas no servidor. */
export function shaDosLotes(valor: string | Uint8Array): string {
  return createHash('sha256').update(valor).digest('hex')
}
/** Escopo fechado para caminhos devolvidos pelo catálogo (D-084). */
export function caminhoDeLote(v: unknown, dono?: string): v is string {
  return typeof v === 'string' && CAMINHO.test(v) && (dono === undefined || v.startsWith(dono + '/'))
}
function inteiro(v: unknown, limite: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= limite
}
function resumo(v: unknown): v is string { return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) }
function lerParte(v: unknown, dono: string): ParteGravada {
  exigirCopia(objetoCopia(v) && caminhoDeLote(v['caminho'], dono) && inteiro(v['bytes'], BYTES_PARTE) && resumo(v['sha256']) &&
    v['caminho'].endsWith(`/${v['sha256']}.bin`))
  return { caminho: v['caminho'], bytes: v['bytes'], sha256: v['sha256'] }
}
/** Confere os metadados antes de acessar objetos, inclusive quando o lote vem de outra data. */
export function lerLoteGravado(v: unknown, dono: string): LoteGravado {
  exigirCopia(objetoCopia(v) && Array.isArray(v['segmentos']) && v['segmentos'].length > 0 && v['segmentos'].length <= 3 &&
    Array.isArray(v['arquivos']) && v['arquivos'].length > 0 && v['arquivos'].length <= L.entradas)
  const segmentos = v['segmentos'].map((s: unknown) => lerParte(s, dono))
  exigirCopia(segmentos.reduce((n, s) => n + s.bytes, 0) <= BYTES_LOTE, 'limite')
  const arquivos = v['arquivos'].map((a: unknown) => {
    exigirCopia(objetoCopia(a) && typeof a['nome'] === 'string' && NOME.test(a['nome']) && inteiro(a['bytes'], L.lote) && resumo(a['sha256']))
    return { nome: a['nome'], bytes: a['bytes'], sha256: a['sha256'] }
  })
  return { segmentos, arquivos }
}
/** Aceita somente o índice integral dentro do limite existente e do mesmo dono. */
export function lerIndiceDoZip(v: unknown, dono: string): IndiceDoZip {
  exigirCopia(objetoCopia(v) && Array.isArray(v['trechos']) && v['trechos'].length > 0 &&
    v['trechos'].length <= L.entradas * 3 && inteiro(v['tamanho'], L.arquivo) && resumo(v['sha256']))
  const trechos = v['trechos'].map((t: unknown) => {
    exigirCopia(objetoCopia(t)); const parte = lerParte(t['parte'], dono)
    exigirCopia(inteiro(t['bytes'], parte.bytes)); return { parte, bytes: t['bytes'] }
  })
  exigirCopia(trechos.reduce((n, t) => n + t.bytes, 0) === v['tamanho'])
  return { trechos, tamanho: v['tamanho'], sha256: v['sha256'] }
}

async function lerConferindo(armazem: ArmazemDeLotes, parte: ParteGravada): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await armazem.ler(parte.caminho, 0, parte.bytes, parte.bytes)
  exigirCopia(bytes.byteLength === parte.bytes && shaDosLotes(bytes) === parte.sha256)
  return bytes
}
async function gravarArquivo(armazem: ArmazemDeLotes, prefixo: string, arquivo: Blob, reservar: ReservarObjetos): Promise<ParteGravada[]> {
  exigirCopia(inteiro(arquivo.size, BYTES_LOTE), 'limite')
  const blocos: { parte: ParteGravada; binario: Uint8Array<ArrayBuffer> }[] = []
  for (let inicio = 0; inicio < arquivo.size; inicio += BYTES_PARTE) {
    const binario = new Uint8Array(await arquivo.slice(inicio, inicio + BYTES_PARTE).arrayBuffer()), sha256 = shaDosLotes(binario)
    const caminho = `${prefixo}/${sha256}.bin`; exigirCopia(caminhoDeLote(caminho))
    blocos.push({ parte: { caminho, bytes: binario.length, sha256 }, binario })
  }
  const partes = blocos.map((b) => b.parte)
  await reservar(partes)
  for (const { parte, binario } of blocos) {
    await armazem.gravar(parte.caminho, binario)
    // Resposta perdida ou conflito não é recibo. O mesmo caminho só vale com os mesmos bytes.
    await lerConferindo(armazem, parte)
  }
  return partes
}

/** Gera lotes STORE sem mudar a ordem das entradas ou o formato de restauração. */
export async function gravarLotesZip(entradas: Iterable<{ nome: string; blob: Blob; shaEsperado?: string }>, data: Date,
  armazem: ArmazemDeLotes, prefixo: string, reservar: ReservarObjetos): Promise<LoteGravado[]> {
  let escritor = escritorDaCopia(data), arquivos: ArquivoListado[] = [], estimativa = 0
  const lotes: LoteGravado[] = []
  async function fechar() {
    const zip = await escritor.close()
    lotes.push({ segmentos: await gravarArquivo(armazem, prefixo, zip, reservar), arquivos })
    arquivos = []; estimativa = 0
  }
  try {
    for (const { nome, blob, shaEsperado } of entradas) {
      exigirCopia(NOME.test(nome) && inteiro(blob.size, L.lote), 'limite')
      // Reserva de cabeçalho/diretório. O tamanho gravado também é conferido.
      const previsto = blob.size + 256
      if (estimativa + previsto > BYTES_LOTE) { await fechar(); escritor = escritorDaCopia(data) }
      const sha256 = shaDosLotes(new Uint8Array(await blob.arrayBuffer()))
      exigirCopia(!shaEsperado || sha256 === shaEsperado, 'foto')
      await escritor.add(nome, new BlobReader(blob))
      arquivos.push({ nome, bytes: blob.size, sha256 }); estimativa += previsto
    }
    if (arquivos.length) await fechar()
    else await escritor.close()
    return lotes
  } catch (erro) { await escritor.close().catch(() => undefined); throw erro }
}

class LeitorDeLote extends Reader<readonly Uint8Array<ArrayBuffer>[]> {
  private readonly blocos: readonly Uint8Array<ArrayBuffer>[]
  constructor(blocos: readonly Uint8Array<ArrayBuffer>[]) {
    super(blocos); this.blocos = blocos; this.size = blocos.reduce((n, b) => n + b.length, 0)
  }
  private recortes(inicio: number, comprimento: number) {
    const partes: Uint8Array<ArrayBuffer>[] = []
    let posicao = 0
    for (const bloco of this.blocos) {
      const de = Math.max(0, inicio - posicao), ate = Math.min(bloco.length, inicio + comprimento - posicao)
      if (ate > de) partes.push(bloco.subarray(de, ate))
      posicao += bloco.length
      if (posicao >= inicio + comprimento) break
    }
    return partes
  }
  override readUint8Array(inicio: number, comprimento: number): Promise<Uint8Array> {
    // Metadados podem ser manipulados pela biblioteca. O buffer usado no envio continua imutável.
    const partes = this.recortes(inicio, comprimento), resultado = new Uint8Array(partes.reduce((n, p) => n + p.length, 0))
    let posicao = 0
    for (const parte of partes) { resultado.set(parte, posicao); posicao += parte.length }
    return Promise.resolve(resultado)
  }
  override createReadable(opcoes?: CreateReadableOptions): ReadableStream<Uint8Array> {
    const inicio = opcoes?.offset ?? 0
    const partes = this.recortes(inicio, opcoes?.size ?? this.size - inicio).values()
    return new ReadableStream({ pull(controlador) {
      const parte = partes.next()
      if (parte.done) controlador.close()
      else controlador.enqueue(parte.value)
    } })
  }
}

/** Fecha o ZIP em fluxo. Conserva só o diretório final e os prefixos, sem criar outro Blob integral. */
export async function fecharLotesZip(lotes: readonly LoteGravado[], armazem: ArmazemDeLotes, prefixo: string, reservar: ReservarObjetos,
  reterAte: number) {
  const total = lotes.reduce((n, l) => n + l.segmentos.reduce((s, p) => s + p.bytes, 0), 0)
  const retidos = reterAte > 0 && total <= LIMITE_PARA_RETER ? new Map<string, Uint8Array<ArrayBuffer>>() : undefined
  const hash = createHash('sha256'), diretorio: Uint8Array<ArrayBuffer>[] = [], trechos: IndiceDoZip['trechos'] = []
  let tamanho = 0, finalizando = false
  const escritor = new ZipWriter(new WritableStream<Uint8Array>({ write(parte) {
    tamanho += parte.byteLength; exigirCopia(tamanho <= L.arquivo, 'limite')
    hash.update(parte)
    if (finalizando) diretorio.push(new Uint8Array(parte))
  } }), { level: 0, useWebWorkers: false, bufferedWrite: false })
  for (const lote of lotes) {
    const antes = tamanho, binarios: Uint8Array<ArrayBuffer>[] = []
    for (const parte of lote.segmentos) {
      binarios.push(await lerConferindo(armazem, parte))
    }
    const leitor = new LeitorDeLote(binarios)
    await escritor.appendZip(leitor, { readerOptions: { strictness: 'strict', useWebWorkers: false } })
    let prefixoRestante = tamanho - antes
    exigirCopia(prefixoRestante > 0 && prefixoRestante < leitor.size)
    let posicao = antes
    for (const [i, binario] of binarios.entries()) {
      const parte = lote.segmentos[i]; exigirCopia(parte)
      const bytes = Math.min(parte.bytes, prefixoRestante)
      if (bytes > 0) {
        trechos.push({ parte, bytes })
        if (posicao < reterAte) retidos?.set(parte.caminho, binario)
        posicao += bytes
      }
      prefixoRestante -= bytes
    }
    exigirCopia(prefixoRestante === 0)
  }
  finalizando = true
  await escritor.close()
  const final = new Blob(diretorio)
  const partes = await gravarArquivo(armazem, prefixo, final, reservar)
  const finais = retidos && tamanho - final.size < reterAte ? new Uint8Array(await final.arrayBuffer()) : undefined
  let inicio = 0
  for (const parte of partes) {
    trechos.push({ parte, bytes: parte.bytes })
    if (finais) retidos?.set(parte.caminho, finais.subarray(inicio, inicio + parte.bytes))
    inicio += parte.bytes
  }
  const indice: IndiceDoZip = { trechos, tamanho, sha256: hash.digest('hex') }
  exigirCopia(trechos.reduce((n, t) => n + t.bytes, 0) === tamanho)
  return { indice, retidos }
}

/** Fonte de um único ZIP por intervalos. A retomada pode ler blocos que cruzam lotes. */
export function fonteDoZip(indice: IndiceDoZip, armazem: ArmazemDeLotes, retidos?: ReadonlyMap<string, Uint8Array<ArrayBuffer>>) {
  return { size: indice.tamanho, async slice(inicio: number, fim: number): Promise<Blob> {
    exigirCopia(Number.isSafeInteger(inicio) && Number.isSafeInteger(fim) && inicio >= 0 && fim > inicio && fim <= indice.tamanho)
    const partes: Uint8Array<ArrayBuffer>[] = []
    let posicao = 0, lidos = 0
    for (const t of indice.trechos) {
      const de = Math.max(0, inicio - posicao), ate = Math.min(t.bytes, fim - posicao)
      if (ate > de) {
        const salvo = retidos?.get(t.parte.caminho)
        const bytes = salvo ? salvo.subarray(de, ate) : await armazem.ler(t.parte.caminho, de, ate, t.parte.bytes)
        exigirCopia(bytes.length === ate - de)
        partes.push(bytes); lidos += bytes.length
      }
      posicao += t.bytes
      if (posicao >= fim) break
    }
    exigirCopia(lidos === fim - inicio)
    return new Blob(partes, { type: 'application/zip' })
  } }
}
