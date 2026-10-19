import { LIMITE_FOTO_BYTES, LIMITE_MINIATURA_BYTES, type FotoPreparada } from '../dados/tipos-fotos.ts'

const LADOS_FOTO = [1024, 819, 655, 524, 419, 335, 320]
const QUALIDADES_FOTO = [0.82, 0.72, 0.62]
const LADOS_MINIATURA = [320, 256, 200, 160, 128]
const QUALIDADES_MINIATURA = [0.8, 0.7, 0.6]
const FALHA = 'Não consegui preparar esta foto. Tente outra.'

type ImagemComprimida = { readonly binario: Uint8Array; readonly largura: number; readonly altura: number }

/** SHA-256 dos bytes efetivos; uma resposta de arquivo já existente não comprova conteúdo (D-025/Q41A). */
export async function hashDaFoto(binario: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(binario))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function comImagem<T>(binario: Uint8Array, usar: (imagem: HTMLImageElement) => Promise<T>): Promise<T> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(binario)]))
  try {
    const imagem = new Image()
    imagem.src = url
    await imagem.decode()
    if (imagem.naturalWidth < 1 || imagem.naturalHeight < 1) throw new Error(FALHA)
    return await usar(imagem)
  } catch {
    throw new Error(FALHA)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function comprimir(imagem: HTMLImageElement, lados: readonly number[], qualidades: readonly number[], teto: number): Promise<ImagemComprimida> {
  // D-025: primeiro medir, depois reduzir; a imagem não é ampliada e a proporção é preservada.
  for (const lado of lados) {
    const escala = Math.min(1, lado / Math.max(imagem.naturalWidth, imagem.naturalHeight))
    const tela = document.createElement('canvas')
    tela.width = Math.max(1, Math.round(imagem.naturalWidth * escala))
    tela.height = Math.max(1, Math.round(imagem.naturalHeight * escala))
    const contexto = tela.getContext('2d')
    if (!contexto) throw new Error(FALHA)
    contexto.fillStyle = '#fff'
    contexto.fillRect(0, 0, tela.width, tela.height)
    contexto.imageSmoothingEnabled = true
    contexto.imageSmoothingQuality = 'high'
    contexto.drawImage(imagem, 0, 0, tela.width, tela.height)
    for (const qualidade of qualidades) {
      const arquivo = await new Promise<Blob | null>((resolver) => tela.toBlob(resolver, 'image/jpeg', qualidade))
      // toBlob pode falhar ou devolver PNG quando o encoder não suporta o formato solicitado.
      if (!arquivo || arquivo.type !== 'image/jpeg') throw new Error(FALHA)
      if (arquivo.size <= teto) return { binario: new Uint8Array(await arquivo.arrayBuffer()), largura: tela.width, altura: tela.height }
    }
    tela.width = 0
    tela.height = 0
  }
  throw new Error(FALHA)
}

/** Reconstrói a miniatura do JPEG remoto confirmado; consulta offline não guarda o original inteiro. */
export async function miniaturaDaFoto(binario: Uint8Array): Promise<Uint8Array> {
  return comImagem(binario, async (imagem) => (await comprimir(imagem, LADOS_MINIATURA, QUALIDADES_MINIATURA, LIMITE_MINIATURA_BYTES)).binario)
}

/** Prepara uma foto capturada/selecionada antes de qualquer gravação, sem rede nem parâmetro por aparelho. */
export async function prepararFoto(entrada: Blob): Promise<FotoPreparada> {
  const foto = await comImagem(new Uint8Array(await entrada.arrayBuffer()), (imagem) => comprimir(imagem, LADOS_FOTO, QUALIDADES_FOTO, LIMITE_FOTO_BYTES))
  const miniatura = await miniaturaDaFoto(foto.binario)
  return { ...foto, miniatura, sha256: await hashDaFoto(foto.binario) }
}
