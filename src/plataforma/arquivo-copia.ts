import { BlobReader, BlobWriter, ZipReader, ZipWriter, type FileEntry } from '@zip.js/zip.js/lib/zip-core.js'
import { dadosDaCopia, exigirCopia, jsonDaCopia, lerJsonDaTabela, lerVinculoCopia, objetoCopia } from '../dados/formato-copia.ts'
import { consultasDaCopia } from '../dados/consultas-copia.ts'
import { fotosNecessariasCopia, mesmoVinculo } from '../dados/repositorio-copia.ts'
import { LIMITES_COPIA as L, TABELAS_COPIA, type DadosCopia, type EstagioCopia, type TabelaCopia, type VinculoConta } from '../dados/tipos-copia.ts'
import { hashDaFoto } from './fotos.ts'

type ArquivoListado = { nome: string; bytes: number; sha256: string }
const codificador = new TextEncoder()
const textoJson = (v: unknown) => new Blob([jsonDaCopia(v)], { type: 'application/json' })
const NOME_VALIDO = /^(?:dados\/(?:[a-zA-Z]+)\/\d{6}\.json|(?:fotos|miniaturas)\/[0-9a-f-]{36}\.jpeg|consultas\/(?:fichas|estoque|caixa)\.csv)$/
async function hashBlob(blob: Blob): Promise<string> { return hashDaFoto(new Uint8Array(await blob.arrayBuffer())) }
async function conferirFotos(d: DadosCopia): Promise<void> {
  for (const foto of fotosNecessariasCopia(d)) {
    exigirCopia(foto.binario && foto.miniatura && foto.binario.byteLength === foto.bytes, 'foto')
    exigirCopia(await hashDaFoto(foto.binario) === foto.sha256, 'foto')
  }
}
/** Produz um único ZIP/STORE completo. A importação deste módulo é sob demanda (D-071). */
export async function criarArquivoCopia(estagio: EstagioCopia, dados: DadosCopia): Promise<Blob> {
  exigirCopia(estagio.pronto && estagio.tipo === 'exportacao', 'estagio')
  dadosDaCopia(dados); await conferirFotos(dados)
  const escritor = new ZipWriter(new BlobWriter('application/zip'), { level: 0, useWebWorkers: false, bufferedWrite: false, extendedTimestamp: false })
  const arquivos: ArquivoListado[] = []
  let bytes = 0, textos = 0
  async function adicionar(nome: string, blob: Blob): Promise<void> {
    bytes += blob.size
    const textual = nome.endsWith('.json') || nome.endsWith('.csv')
    if (textual) textos += blob.size
    exigirCopia(bytes <= L.arquivo && textos <= L.textos && arquivos.length + 2 <= L.entradas && (!textual || blob.size <= L.lote), 'limite')
    arquivos.push({ nome, bytes: blob.size, sha256: await hashBlob(blob) })
    await escritor.add(nome, new BlobReader(blob))
  }
  try {
    for (const tabela of TABELAS_COPIA) {
      const linhas: readonly unknown[] = tabela === 'fotos' ? dados.fotos.map(({ binario: _b, miniatura: _m, ...foto }) => foto) : dados[tabela]
      let lote: unknown[] = [], tamanho = 2, numero = 0
      async function gravar() { await adicionar(`dados/${tabela}/${String(numero++).padStart(6, '0')}.json`, textoJson(lote)); lote = []; tamanho = 2 }
      for (const linha of linhas) {
        const comprimento = codificador.encode(jsonDaCopia(linha)).byteLength + 16
        exigirCopia(comprimento <= L.lote - 2, 'limite')
        if (tamanho + comprimento > L.lote) await gravar()
        lote.push(linha); tamanho += comprimento
      }
      if (lote.length || numero === 0) await gravar()
    }
    for (const foto of dados.fotos) {
      if (foto.binario) await adicionar(`fotos/${foto.id}.jpeg`, new Blob([new Uint8Array(foto.binario)]))
      if (foto.miniatura) await adicionar(`miniaturas/${foto.id}.jpeg`, new Blob([new Uint8Array(foto.miniatura)]))
    }
    for (const [nome, conteudo] of Object.entries(consultasDaCopia(dados))) await adicionar(nome, new Blob([conteudo], { type: 'text/csv;charset=utf-8' }))
    const manifesto = textoJson({ formato: 1, esquema: 6, id: estagio.id, vinculo: estagio.vinculo,
      capturadoEm: estagio.capturadoEm, quantidades: Object.fromEntries(TABELAS_COPIA.map((t) => [t, dados[t].length])), arquivos })
    exigirCopia(manifesto.size <= L.manifesto && bytes + manifesto.size <= L.arquivo, 'limite')
    await escritor.add('manifesto.json', new BlobReader(manifesto))
    const resultado = await escritor.close()
    exigirCopia(resultado.size <= L.arquivo, 'limite')
    return resultado
  } catch (erro) { await escritor.close().catch(() => undefined); throw erro }
}

/** Valida tudo antes de devolver dados à camada local; ZIP não escreve diretamente na base. */
export async function lerArquivoCopia(arquivo: Blob, vinculo: VinculoConta): Promise<{ dados: DadosCopia; capturadoEm: string }> {
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
    exigirCopia(objetoCopia(manifesto) && Object.keys(manifesto).sort().join(',') === 'arquivos,capturadoEm,esquema,formato,id,quantidades,vinculo' &&
      manifesto['formato'] === 1 && manifesto['esquema'] === 6 && typeof manifesto['id'] === 'string' && /^[0-9a-f-]{36}$/i.test(manifesto['id']) &&
      typeof manifesto['capturadoEm'] === 'string' && !Number.isNaN(new Date(manifesto['capturadoEm']).getTime()) &&
      Array.isArray(manifesto['arquivos']) && objetoCopia(manifesto['quantidades']))
    exigirCopia(mesmoVinculo(lerVinculoCopia(manifesto['vinculo']), vinculo), 'conta')
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
        const partes = a.nome.split('/'), tabela = TABELAS_COPIA.find((t) => t === partes[1])
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
    exigirCopia(vistas.size === TABELAS_COPIA.length && ['consultas/fichas.csv', 'consultas/estoque.csv', 'consultas/caixa.csv'].every((n) => entradas.has(n)))
    const fotos = porTabela['fotos']; exigirCopia(fotos)
    porTabela['fotos'] = fotos.map((v: unknown) => {
      exigirCopia(objetoCopia(v) && typeof v['id'] === 'string' && !('binario' in v) && !('miniatura' in v))
      const binario = binarios.get(v['id']), miniatura = miniaturas.get(v['id'])
      binarios.delete(v['id']); miniaturas.delete(v['id'])
      return { ...v, ...(binario ? { binario } : {}), ...(miniatura ? { miniatura } : {}) }
    })
    exigirCopia(binarios.size === 0 && miniaturas.size === 0)
    const dados = dadosDaCopia(porTabela)
    for (const f of dados.fotos) if (f.caminho) exigirCopia(f.caminho === `${vinculo.contaId}/${f.id}/${f.copiaId}.jpeg`)
    for (const p of dados.protecoesFotos) exigirCopia(p.caminho === `${vinculo.contaId}/${p.fotoId}/${p.copiaId}.jpeg` && p.id === `${p.copiaId}/${p.geracao}`)
    const quantidades = manifesto['quantidades']
    exigirCopia(Object.keys(quantidades).length === TABELAS_COPIA.length && TABELAS_COPIA.every((t) => quantidades[t] === dados[t].length))
    await conferirFotos(dados)
    return { dados, capturadoEm: manifesto['capturadoEm'] }
  } finally { await leitor.close() }
}
