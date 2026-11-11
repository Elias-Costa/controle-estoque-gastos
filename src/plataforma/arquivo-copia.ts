import { BlobReader, Writer, ZipReader, ZipWriter, type FileEntry } from '@zip.js/zip.js/lib/zip-core.js'
import { dadosDaCopia, exigirCopia, jsonDaCopia, lerJsonDaTabela, lerOrigemBackup, lerVinculoCopia, objetoCopia } from '../dados/formato-copia.ts'
import { consultasDaCopia } from '../dados/consultas-copia.ts'
import { fotosNecessariasCopia, mesmoVinculo } from '../dados/repositorio-copia.ts'
import { LIMITES_COPIA as L, TABELAS_COPIA, TABELAS_COPIA_V1, TABELAS_COPIA_V2, type DadosCopia, type EstagioCopia, type OrigemBackup, type TabelaCopia, type VinculoConta } from '../dados/tipos-copia.ts'
import { LIMITE_MINIATURA_BYTES } from '../dados/tipos-fotos.ts'
import { hashDaFoto, miniaturaDaFoto } from './fotos.ts'

type ArquivoListado = { nome: string; bytes: number; sha256: string }
/** Fases do empacotamento, sem conteúdo do arquivo na observação (BA-04). */
export type EtapaArquivoCopia = 'validacao_dados' | 'validacao_fotos' | 'zip_dados' | 'zip_fotos' | 'zip_consultas' | 'zip_fechamento'
const codificador = new TextEncoder()
const textoJson = (v: unknown) => new Blob([jsonDaCopia(v)], { type: 'application/json' })
const NOME_VALIDO = /^(?:dados\/(?:[a-zA-Z]+)\/\d{6}\.json|(?:fotos|miniaturas)\/[0-9a-f-]{36}\.jpeg|consultas\/(?:fichas|estoque|caixa)\.csv)$/
function blobDoBinario(binario: Uint8Array): Blob {
  // Blob copia a vista exata; não duplicar antes nem incluir bytes fora do intervalo.
  const parte = binario.buffer instanceof ArrayBuffer
    ? new Uint8Array(binario.buffer, binario.byteOffset, binario.byteLength) : new Uint8Array(binario)
  return new Blob([parte])
}
class PartesDoZip extends Writer<Blob> {
  private partes: Blob[] = []
  override writeUint8Array(parte: Uint8Array): Promise<void> {
    this.partes.push(blobDoBinario(parte))
    return Promise.resolve()
  }
  override getData(): Promise<Blob> {
    // BA-04: Response.blob() do BlobWriter concatena o ZIP inteiro ao fechar no Edge.
    // Partes já imutáveis dispensam esse buffer contíguo extra; zip.js mantém formato/CRC.
    const arquivo = new Blob(this.partes, { type: 'application/zip' })
    this.partes = []
    return Promise.resolve(arquivo)
  }
}
async function hashBlob(blob: Blob): Promise<string> {
  // Blob já é imutável; o buffer lido para o hash não precisa de outra cópia defensiva.
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
async function conferirFotos(d: DadosCopia, exigirMiniatura = true): Promise<void> {
  for (const foto of fotosNecessariasCopia(d)) {
    exigirCopia(foto.binario && (!exigirMiniatura || foto.miniatura) && foto.binario.byteLength === foto.bytes, 'foto')
    exigirCopia(await hashDaFoto(foto.binario) === foto.sha256, 'foto')
  }
}
/** Produz um único ZIP/STORE completo. A importação deste módulo é sob demanda (D-071). */
export async function criarArquivoCopia(estagio: EstagioCopia, dados: DadosCopia): Promise<Blob> {
  return criarArquivo(estagio, dados)
}
/** ZIP autossuficiente 5/10: aceita originais sem miniaturas, reconstruídas na importação (D-084). */
export async function criarArquivoBackup(estagio: EstagioCopia, dados: DadosCopia, origem: OrigemBackup,
  aoAvancar?: (etapa: EtapaArquivoCopia) => void, resumir = hashBlob): Promise<Blob> {
  return criarArquivo(estagio, dados, lerOrigemBackup(origem), aoAvancar, resumir)
}
async function criarArquivo(estagio: EstagioCopia, dados: DadosCopia, origem?: OrigemBackup,
  aoAvancar?: (etapa: EtapaArquivoCopia) => void, resumir = hashBlob): Promise<Blob> {
  exigirCopia(estagio.pronto && estagio.tipo === 'exportacao', 'estagio')
  aoAvancar?.('validacao_dados')
  dadosDaCopia(dados)
  // Metadados da mesma foto acompanham o Blob imutável que será conferido e escrito.
  dados = { ...dados, fotos: dados.fotos.map((foto) => ({ ...foto })) }
  aoAvancar?.('validacao_fotos')
  for (const foto of fotosNecessariasCopia(dados)) {
    exigirCopia(foto.binario && (origem || foto.miniatura) && foto.binario.byteLength === foto.bytes, 'foto')
  }
  const carimbo = new Date(estagio.capturadoEm)
  // BA-02/D-084: remontar a mesma captura deve produzir os mesmos bytes para retomar o upload.
  // zip.js usa componentes locais no DOS timestamp; os componentes UTC fixam o resultado entre runtimes.
  // A captura do aparelho pode ser retomada após trocar de fuso. A data real está no manifesto.
  const dataDoZip = origem?.tipo === 'aparelho' ? new Date(2000, 0, 1, 12)
    : new Date(carimbo.getUTCFullYear(), carimbo.getUTCMonth(), carimbo.getUTCDate(), carimbo.getUTCHours(), carimbo.getUTCMinutes(), carimbo.getUTCSeconds())
  const escritor = new ZipWriter(new PartesDoZip(), { level: 0, useWebWorkers: false, bufferedWrite: false, extendedTimestamp: false,
    ...(origem ? { lastModDate: dataDoZip } : {}) })
  const arquivos: ArquivoListado[] = []
  let bytes = 0, textos = 0
  async function adicionar(nome: string, blob: Blob, hashConferido?: string): Promise<void> {
    bytes += blob.size
    const textual = nome.endsWith('.json') || nome.endsWith('.csv')
    if (textual) textos += blob.size
    exigirCopia(bytes <= L.arquivo && textos <= L.textos && arquivos.length + 2 <= L.entradas && (!textual || blob.size <= L.lote), 'limite')
    arquivos.push({ nome, bytes: blob.size, sha256: hashConferido ?? await resumir(blob) })
    await escritor.add(nome, new BlobReader(blob))
  }
  try {
    aoAvancar?.('zip_dados')
    for (const tabela of TABELAS_COPIA) {
      const linhas: readonly unknown[] = tabela === 'fotos' ? dados.fotos.map(({ binario: _b, miniatura: _m, ...foto }) => foto) : dados[tabela]
      let lote: string[] = [], tamanho = 2, numero = 0
      async function gravar() {
        // Mesma indentação de jsonDaCopia(linhas), reaproveitando a serialização que dimensiona o lote.
        const texto = lote.length ? `[\n${lote.join(',\n')}\n]` : '[]'
        await adicionar(`dados/${tabela}/${String(numero++).padStart(6, '0')}.json`, new Blob([texto], { type: 'application/json' }))
        lote = []; tamanho = 2
      }
      for (const linha of linhas) {
        const json = jsonDaCopia(linha), comprimento = codificador.encode(json).byteLength + 16
        exigirCopia(comprimento <= L.lote - 2, 'limite')
        if (tamanho + comprimento > L.lote) await gravar()
        lote.push(`  ${json.replaceAll('\n', '\n  ')}`); tamanho += comprimento
      }
      if (lote.length || numero === 0) await gravar()
    }
    aoAvancar?.('zip_fotos')
    for (const foto of dados.fotos) {
      if (foto.binario) {
        const original = blobDoBinario(foto.binario), sha256 = await resumir(original)
        exigirCopia(original.size === foto.bytes && sha256 === foto.sha256, 'foto')
        // Somente este bloco privado reaproveita o hash dos mesmos bytes efetivamente escritos.
        await adicionar(`fotos/${foto.id}.jpeg`, original, sha256)
      }
      if (!origem && foto.miniatura) await adicionar(`miniaturas/${foto.id}.jpeg`, blobDoBinario(foto.miniatura))
    }
    aoAvancar?.('zip_consultas')
    for (const [nome, conteudo] of Object.entries(consultasDaCopia(dados))) await adicionar(nome, new Blob([conteudo], { type: 'text/csv;charset=utf-8' }))
    aoAvancar?.('zip_fechamento')
    const manifesto = textoJson({ formato: origem ? 5 : 4, esquema: 10, ...(origem ? { origem } : {}), id: estagio.id, vinculo: estagio.vinculo,
      capturadoEm: estagio.capturadoEm, quantidades: Object.fromEntries(TABELAS_COPIA.map((t) => [t, dados[t].length])), arquivos })
    exigirCopia(manifesto.size <= L.manifesto && bytes + manifesto.size <= L.arquivo, 'limite')
    await escritor.add('manifesto.json', new BlobReader(manifesto))
    const resultado = await escritor.close()
    exigirCopia(resultado.size <= L.arquivo, 'limite')
    return resultado
  } catch (erro) { await escritor.close().catch(() => undefined); throw erro }
}

/** Valida tudo antes de devolver dados à camada local; ZIP não escreve diretamente na base. */
export async function lerArquivoCopia(arquivo: Blob, vinculo: VinculoConta, miniaturizar = miniaturaDaFoto): Promise<{ dados: DadosCopia; capturadoEm: string; origem?: OrigemBackup }> {
  exigirCopia(arquivo.size > 0 && arquivo.size <= L.arquivo, 'limite')
  const leitor = new ZipReader(new BlobReader(arquivo), { useWebWorkers: false, strictness: 'strict', checkCrc32: true, checkOverlappingEntry: true })
  try {
    const entradas = new Map<string, FileEntry>()
    let totalDeclarado = 0, totalReal = 0, totalTexto = 0
    for await (const entrada of leitor.getEntriesGenerator()) {
      exigirCopia(!entrada.directory && !entrada.symlink && !entrada.encrypted && entrada.compressionMethod === 0 && !entradas.has(entrada.filename))
      exigirCopia(entrada.filename === 'manifesto.json' || NOME_VALIDO.test(entrada.filename))
      entradas.set(entrada.filename, entrada)
      totalDeclarado += entrada.uncompressedSize
      exigirCopia(Number.isSafeInteger(totalDeclarado) && totalDeclarado <= L.arquivo && entradas.size <= L.entradas, 'limite')
    }
    async function ler(nome: string, limite: number): Promise<Blob> {
      const entrada = entradas.get(nome); exigirCopia(entrada)
      exigirCopia(entrada.uncompressedSize <= limite, 'limite')
      const partes: Uint8Array<ArrayBuffer>[] = []
      let tamanho = 0
      await entrada.getData({ writable: new WritableStream<Uint8Array>({ write(parte) {
        tamanho += parte.byteLength; totalReal += parte.byteLength
        exigirCopia(tamanho <= limite && totalReal <= L.arquivo, 'limite')
        partes.push(new Uint8Array(parte))
      } }) })
      exigirCopia(tamanho === entrada.uncompressedSize)
      return new Blob(partes)
    }
    const manifesto: unknown = JSON.parse(await (await ler('manifesto.json', L.manifesto)).text())
    exigirCopia(objetoCopia(manifesto) && Object.keys(manifesto).sort().join(',') ===
      (manifesto['formato'] === 5 ? 'arquivos,capturadoEm,esquema,formato,id,origem,quantidades,vinculo' : 'arquivos,capturadoEm,esquema,formato,id,quantidades,vinculo') &&
      ((manifesto['formato'] === 1 && manifesto['esquema'] === 6) || (manifesto['formato'] === 2 && manifesto['esquema'] === 7) ||
        (manifesto['formato'] === 3 && manifesto['esquema'] === 9) || ((manifesto['formato'] === 4 || manifesto['formato'] === 5) && manifesto['esquema'] === 10)) && typeof manifesto['id'] === 'string' && /^[0-9a-f-]{36}$/i.test(manifesto['id']) &&
      typeof manifesto['capturadoEm'] === 'string' && !Number.isNaN(new Date(manifesto['capturadoEm']).getTime()) &&
      Array.isArray(manifesto['arquivos']) && objetoCopia(manifesto['quantidades']))
    exigirCopia(mesmoVinculo(lerVinculoCopia(manifesto['vinculo']), vinculo), 'conta')
    const formato = manifesto['formato']
    const origem = formato === 5 ? lerOrigemBackup(manifesto['origem']) : undefined
    const tabelas = formato === 1 ? TABELAS_COPIA_V1 : formato === 2 ? TABELAS_COPIA_V2 : TABELAS_COPIA
    const arquivos: ArquivoListado[] = manifesto['arquivos'].map((v: unknown) => {
      exigirCopia(objetoCopia(v) && Object.keys(v).sort().join(',') === 'bytes,nome,sha256' && typeof v['nome'] === 'string' && NOME_VALIDO.test(v['nome']) &&
        typeof v['bytes'] === 'number' && Number.isSafeInteger(v['bytes']) && v['bytes'] >= 0 && typeof v['sha256'] === 'string' && /^[0-9a-f]{64}$/.test(v['sha256']))
      return { nome: v['nome'], bytes: v['bytes'], sha256: v['sha256'] }
    })
    exigirCopia(arquivos.length + 1 === entradas.size && new Set(arquivos.map((a) => a.nome)).size === arquivos.length)
    const porTabela: Record<string, unknown[]> = Object.fromEntries(TABELAS_COPIA.map((t) => [t, []]))
    const vistas = new Set<TabelaCopia>(), binarios = new Map<string, Uint8Array>(), miniaturas = new Map<string, Uint8Array>()
    const lotes = new Map<TabelaCopia, number>()
    for (const a of arquivos) {
      const textual = a.nome.endsWith('.json') || a.nome.endsWith('.csv')
      const blob = await ler(a.nome, textual ? L.lote : a.nome.startsWith('miniaturas/') ? 20_480 : 204_800)
      exigirCopia(blob.size === a.bytes && await hashBlob(blob) === a.sha256)
      if (textual) { totalTexto += blob.size; exigirCopia(totalTexto <= L.textos, 'limite') }
      if (a.nome.startsWith('dados/')) {
        const partes = a.nome.split('/'), tabela = tabelas.find((t) => t === partes[1])
        exigirCopia(tabela && partes[2] === `${String(lotes.get(tabela) ?? 0).padStart(6, '0')}.json`)
        lotes.set(tabela, (lotes.get(tabela) ?? 0) + 1); vistas.add(tabela)
        const linhas = lerJsonDaTabela(tabela, await blob.text())
        exigirCopia(Array.isArray(linhas)); porTabela[tabela]?.push(...linhas)
        exigirCopia(Object.values(porTabela).reduce((n, ls) => n + ls.length, 0) <= L.registros, 'limite')
      } else if (a.nome.startsWith('fotos/') || a.nome.startsWith('miniaturas/')) {
        const fotoId = a.nome.split('/')[1]?.replace('.jpeg', ''); exigirCopia(fotoId)
        ;(a.nome.startsWith('fotos/') ? binarios : miniaturas).set(fotoId, new Uint8Array(await blob.arrayBuffer()))
      }
    }
    exigirCopia(vistas.size === tabelas.length && ['consultas/fichas.csv', 'consultas/estoque.csv', 'consultas/caixa.csv'].every((n) => entradas.has(n)))
    const fotos = porTabela['fotos']; exigirCopia(fotos)
    porTabela['fotos'] = fotos.map((v: unknown) => {
      exigirCopia(objetoCopia(v) && typeof v['id'] === 'string' && !('binario' in v) && !('miniatura' in v))
      const binario = binarios.get(v['id']), miniatura = miniaturas.get(v['id'])
      binarios.delete(v['id']); miniaturas.delete(v['id'])
      return { ...v, ...(binario ? { binario } : {}), ...(miniatura ? { miniatura } : {}) }
    })
    exigirCopia(binarios.size === 0 && miniaturas.size === 0)
    const dados = dadosDaCopia(porTabela, formato)
    for (const f of dados.fotos) if (f.caminho) exigirCopia(f.caminho === `${vinculo.contaId}/${f.id}/${f.copiaId}.jpeg`)
    for (const p of dados.protecoesFotos) exigirCopia(p.caminho === `${vinculo.contaId}/${p.fotoId}/${p.copiaId}.jpeg` && p.id === `${p.copiaId}/${p.geracao}`)
    const quantidades = manifesto['quantidades']
    exigirCopia(Object.keys(quantidades).length === tabelas.length && tabelas.every((t) => quantidades[t] === dados[t].length))
    // Conferir todos os originais antes de executar o decoder; falha nunca devolve dados parciais.
    await conferirFotos(dados, formato !== 5)
    if (formato === 5) {
      for (let i = 0; i < dados.fotos.length; i++) {
        const foto = dados.fotos[i]; exigirCopia(foto)
        if (!foto.binario || foto.miniatura) continue
        let miniatura: Uint8Array
        try { miniatura = await miniaturizar(foto.binario) } catch { exigirCopia(false) }
        exigirCopia(miniatura instanceof Uint8Array && miniatura.byteLength > 0 && miniatura.byteLength <= LIMITE_MINIATURA_BYTES)
        totalReal += miniatura.byteLength
        exigirCopia(totalReal <= L.arquivo, 'limite')
        dados.fotos[i] = { ...foto, miniatura }
      }
    }
    return { dados, capturadoEm: manifesto['capturadoEm'], ...(origem ? { origem } : {}) }
  } finally { await leitor.close() }
}
