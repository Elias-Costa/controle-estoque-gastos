import { exigirCopia, objetoCopia } from '../../src/dados/formato-copia.ts'
import { LIMITES_COPIA as L, TABELAS_COPIA, type VinculoConta } from '../../src/dados/tipos-copia.ts'
import { consultasDaCopia } from '../../src/dados/consultas-copia.ts'
import { conteudoDoEfeito } from '../../src/dominio/regras-estoque.ts'
import { dataInternaDaCopia, entradasDeDadosCopia, manifestoDaCopia } from '../../src/plataforma/arquivo-copia.ts'
import { conteudoDaFotoParaRetencao } from '../../src/plataforma/material-backup.ts'
import { baixarLoteDaCaptura, carregarFontesBackup, fotoDaCaptura, lerCapturaServidor, materialDaCaptura, metadadosDaCaptura,
  type CapturaServidor } from './captura.ts'
import { caminhoDeLote, fecharLotesZip, fonteDoZip, gravarLotesZip, lerIndiceDoZip, lerLoteGravado, shaDosLotes,
  type ArmazemDeLotes } from './lotes.ts'
import type { PacoteParaEnvio, PassoDoEnvio, PortasBackupServidor, ResultadoBackupServidor } from './servidor.ts'

const VERSAO = 1, MAX_FOTOS_NO_LOTE = 32
// D-084: aproveitar mais partes já conferidas antes de retomar pelo Storage.
const BLOCOS_COM_FECHAMENTO = 16
type Grupo = { chave: string; referencias: readonly unknown[] }
type Portas = PortasBackupServidor & { readonly partes: ArmazemDeLotes }

function registro(v: unknown): Record<string, unknown> { exigirCopia(objetoCopia(v)); return v }
function lista(v: unknown, maximo: number): readonly unknown[] { exigirCopia(Array.isArray(v) && v.length <= maximo); return v }
function hashes(v: unknown): string[] {
  return lista(v, L.registros).map((h) => { exigirCopia(typeof h === 'string' && /^[a-f0-9]{64}$/.test(h)); return h })
}

function grupoDaCaptura(c: CapturaServidor, referencias: readonly unknown[]): Grupo {
  const fontes = referencias.map((r) => {
    const f = fotoDaCaptura(c, r)
    return [f.id, f.caminho, f.sha256, f.bytes, f.largura, f.altura]
  })
  return { chave: shaDosLotes(JSON.stringify([VERSAO, c.vinculo.contaId, c.vinculo.destino, fontes])), referencias }
}

/** Faixas estáveis por hash do id. Uma edição só altera a faixa que contém o original. */
export function gruposDeFotos(c: CapturaServidor, referencias: readonly unknown[]): Grupo[] {
  const ordenadas = referencias.map((ref) => ({ ref, ordem: shaDosLotes(fotoDaCaptura(c, ref).id) }))
    .sort((a, b) => a.ordem < b.ordem ? -1 : a.ordem > b.ordem ? 1 : 0)
  const grupos: Grupo[] = []
  function separar(entradas: typeof ordenadas, bit: number): void {
    if (entradas.length === 0) return
    if (bit >= 4 && entradas.length <= MAX_FOTOS_NO_LOTE) {
      grupos.push(grupoDaCaptura(c, entradas.map((e) => e.ref)))
      return
    }
    exigirCopia(bit < 256)
    // A lista já está ordenada pelo hash. Dividir em duas faixas evita disparos para dezenas de lotes mínimos.
    const digito = Math.floor(bit / 4), mascara = 8 >> (bit % 4)
    const primeiroComBit = entradas.findIndex((e) => (Number.parseInt(e.ordem.charAt(digito), 16) & mascara) !== 0)
    const divisa = primeiroComBit < 0 ? entradas.length : primeiroComBit
    separar(entradas.slice(0, divisa), bit + 1)
    separar(entradas.slice(divisa), bit + 1)
  }
  // As 16 faixas iniciais permanecem estáveis mesmo quando a quantidade total muda.
  separar(ordenadas, 0)
  return grupos
}

/** Avança um passo confirmado e deixa o próximo disparo retomar pelo catálogo (D-084). */
export async function executarPreparo(portas: Portas, vinculo: VinculoConta, sugerida: string, tamanhoBloco: number,
  enviar: (c: CapturaServidor, estado: unknown, pacote: PacoteParaEnvio, limiteBlocos?: number) => Promise<PassoDoEnvio>): Promise<ResultadoBackupServidor | undefined> {
  const { rpc, partes } = portas, conta = vinculo.contaId, posse = crypto.randomUUID()
  const e = registro(await rpc('assumir_preparo_backup', { conta, captura: sugerida, destino: vinculo.destino, posse }))
  if (e['modo'] === 'legado') return undefined
  if (e['modo'] === 'ocupado') { exigirCopia(typeof e['id'] === 'string'); return { estado: 'pendente', capturaId: e['id'] } }
  exigirCopia(e['modo'] === 'preparo' && e['versao'] === VERSAO && typeof e['passo'] === 'number' && Number.isSafeInteger(e['passo']))
  const c = lerCapturaServidor(e['captura'], vinculo), fase = e['fase'], prefixo = `${conta}/${c.id}`
  const identidade = { conta, captura: c.id, posse }, pendente = { estado: 'pendente', capturaId: c.id } as const
  const estadoDaCaptura = registro(e['captura'])['estado']
  let passo = e['passo'], emPosse = true
  const reservar = async (objetos: readonly { sha256: string; bytes: number }[]) => {
    await rpc('reservar_objetos_backup', { ...identidade, passo, objetos: objetos.map(({ sha256, bytes }) => ({ sha256, bytes })) })
  }
  async function avancar(resultado: Record<string, unknown>, manter = false) {
    await rpc('avancar_preparo_backup', { ...identidade, passo, resultado, encadear: portas.encadearPreparo !== false })
    passo++; emPosse = manter
  }
  async function transmitir(pacote: PacoteParaEnvio, limiteBlocos?: number) {
    const envio = await enviar(c, estadoDaCaptura, pacote, limiteBlocos)
    await avancar(envio.resultado.estado === 'pronta' ? { pronta: true } : { enviados: envio.enviados })
    return envio.resultado
  }
  try {
    if (fase === 'dados') {
      portas.aoAvancar?.('preparo_dados')
      const fontes = await carregarFontesBackup(rpc, c), dados = metadadosDaCaptura(c, fontes), data = dataInternaDaCopia(c.capturadoEm)
      const jsons = await gravarLotesZip(entradasDeDadosCopia(dados), data, partes, prefixo, reservar)
      const csvs = Object.entries(consultasDaCopia(dados)).map(([nome, conteudo]) => ({ nome, blob: new Blob([conteudo]) }))
      const consultas = await gravarLotesZip(csvs, data, partes, prefixo, reservar)
      await avancar({ dados: jsons, consultas, grupos: gruposDeFotos(c, fontes.fotos), material: await materialDaCaptura(dados),
        quantidades: Object.fromEntries(TABELAS_COPIA.map((t) => [t, dados[t].length])) })
      return pendente
    }
    if (fase === 'fotos') {
      const g = registro(e['grupo']), referencias = lista(g['referencias'], MAX_FOTOS_NO_LOTE)
      const grupo = grupoDaCaptura(c, referencias), fotos = referencias.map((r) => fotoDaCaptura(c, r))
      exigirCopia(fotos.length > 0 && grupo.chave === g['chave'])
      let lote
      if (e['reutilizavel'] !== null) {
        portas.aoAvancar?.('reuso_fotos')
        lote = lerLoteGravado(e['reutilizavel'], conta)
      } else {
        portas.aoAvancar?.('preparo_fotos')
        const originais = await baixarLoteDaCaptura(c, referencias, portas.baixarOriginal)
        const novos = await gravarLotesZip(originais.map((f) => ({ nome: `fotos/${f.id}.jpeg`, shaEsperado: f.sha256,
          blob: new Blob([new Uint8Array(f.binario)]) })), dataInternaDaCopia(), partes, prefixo, reservar)
        exigirCopia(novos.length === 1); lote = novos[0]; exigirCopia(lote)
      }
      exigirCopia(lote.arquivos.length === fotos.length && lote.arquivos.every((a, i) => {
        const f = fotos[i]; return f && a.nome === `fotos/${f.id}.jpeg` && a.bytes === f.bytes && a.sha256 === f.sha256
      }), 'foto')
      const material = fotos.map((f) => shaDosLotes(conteudoDoEfeito(['foto', conteudoDaFotoParaRetencao(f)])))
      await avancar({ chave: grupo.chave, lote, material })
      return pendente
    }
    if (fase === 'fechar') {
      portas.aoAvancar?.('fechar_lotes')
      const p = registro(e['plano']), fotos = lista(e['fotos'], L.entradas).map(registro)
      const lerLotes = (v: unknown) => lista(v, L.entradas).map((l) => lerLoteGravado(l, conta))
      const lotes = [...lerLotes(p['dados']), ...fotos.map((f) => lerLoteGravado(f['lote'], conta)), ...lerLotes(p['consultas'])]
      const arquivos = lotes.flatMap((l) => l.arquivos), contagens = registro(p['quantidades'])
      const quantidades = Object.fromEntries(TABELAS_COPIA.map((t) => {
        const n = contagens[t]; exigirCopia(typeof n === 'number' && Number.isSafeInteger(n) && n >= 0); return [t, n]
      }))
      const bytes = arquivos.reduce((n, a) => n + a.bytes, 0)
      exigirCopia(arquivos.length + 1 <= L.entradas && new Set(arquivos.map((a) => a.nome)).size === arquivos.length &&
        arquivos.every((a) => a.nome !== 'manifesto.json') && arquivos.filter((a) => a.nome.startsWith('fotos/')).length === quantidades['fotos'] &&
        arquivos.reduce((n, a) => n + (a.nome.startsWith('fotos/') ? 0 : a.bytes), 0) <= L.textos, 'limite')
      const manifesto = manifestoDaCopia(c, quantidades, arquivos, { tipo: 'servidor' })
      exigirCopia(manifesto.size <= L.manifesto && bytes + manifesto.size <= L.arquivo, 'limite')
      const ultimo = await gravarLotesZip([{ nome: 'manifesto.json', blob: manifesto }], dataInternaDaCopia(c.capturadoEm), partes, prefixo, reservar)
      const { indice, retidos } = await fecharLotesZip([...lotes, ...ultimo], partes, prefixo, reservar, BLOCOS_COM_FECHAMENTO * tamanhoBloco)
      const material = [...new Set([...hashes(e['material']), ...fotos.flatMap((f) => hashes(f['material']))])].sort()
      const manter = retidos !== undefined
      await avancar({ indice, material, manter }, manter)
      return manter ? await transmitir({ arquivo: fonteDoZip(indice, partes, retidos), sha256: indice.sha256, material }, BLOCOS_COM_FECHAMENTO) : pendente
    }
    if (fase === 'enviar') {
      const indice = lerIndiceDoZip(e['indice'], conta)
      return await transmitir({ arquivo: fonteDoZip(indice, partes), sha256: indice.sha256, material: hashes(e['material']) })
    }
    exigirCopia(fase === 'limpar')
    portas.aoAvancar?.('limpar_partes')
    const apagar = lista(e['apagar'], 32).map((v) => { exigirCopia(caminhoDeLote(v, conta)); return v })
    await partes.apagar(apagar)
    await avancar({ apagados: apagar })
    // O preparo só entra na limpeza após confirmação ou cancelamento no catálogo.
    const envio = registro(await rpc('consultar_upload_backup', { conta, captura: c.id }))
    return envio['estado'] === 'pronta' && typeof envio['arquivoId'] === 'string' && typeof envio['tamanho'] === 'string'
      ? { estado: 'pronta', capturaId: c.id, arquivoId: envio['arquivoId'], bytes: Number(envio['tamanho']) } : pendente
  } finally {
    if (emPosse) await rpc('soltar_preparo_backup', identidade).catch(() => undefined)
  }
}
