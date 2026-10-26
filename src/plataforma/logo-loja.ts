import { LADO_LOGO, LIMITE_LOGO_BYTES, logoValida } from '../dados/identidade-loja.ts'

/** D-076: imagem local vira PNG proporcional, sem EXIF nem remoção de transparência. */
export async function prepararLogoLoja(arquivo: Blob): Promise<string> {
  const url = URL.createObjectURL(arquivo)
  try {
    const imagem = new Image()
    imagem.src = url
    await imagem.decode()
    if (imagem.naturalWidth < 1 || imagem.naturalHeight < 1) throw new Error('Imagem vazia')
    for (const lado of [LADO_LOGO, 384, 256, 192, 128, 96, 64, 32, 16, 8, 1]) {
      const escala = Math.min(1, lado / Math.max(imagem.naturalWidth, imagem.naturalHeight))
      const tela = document.createElement('canvas')
      tela.width = Math.max(1, Math.round(imagem.naturalWidth * escala))
      tela.height = Math.max(1, Math.round(imagem.naturalHeight * escala))
      const contexto = tela.getContext('2d')
      if (!contexto) throw new Error('Imagem indisponível')
      contexto.drawImage(imagem, 0, 0, tela.width, tela.height)
      const png = await new Promise<Blob | null>((resolver) => tela.toBlob(resolver, 'image/png'))
      if (png?.type === 'image/png' && png.size <= LIMITE_LOGO_BYTES) {
        const logo = tela.toDataURL('image/png')
        if (logoValida(logo)) return logo
      }
      tela.width = 0; tela.height = 0
    }
    throw new Error('Imagem grande demais')
  } catch { throw new Error('Não consegui preparar esta logo. Tente outra imagem.') }
  finally { URL.revokeObjectURL(url) }
}
