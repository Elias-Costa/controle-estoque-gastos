import { LADO_LOGO, LIMITE_LOGO_BYTES, logoValida } from '../dados/identidade-loja.ts'

/** D-076: posição em frações do diâmetro; zoom 1 conserva a imagem inteira no quadrado. */
export type EnquadramentoLogo = { readonly x: number; readonly y: number; readonly zoom: number }

/** Mesma geometria na prévia e no PNG; somente o interior do círculo recebe pixels. */
export function desenharLogoCircular(contexto: CanvasRenderingContext2D, imagem: HTMLImageElement, lado: number, enquadramento: EnquadramentoLogo): void {
  const { x, y, zoom } = enquadramento
  if (![x, y, zoom].every(Number.isFinite) || Math.abs(x) > 1 || Math.abs(y) > 1 || zoom < 0.5 || zoom > 4 ||
    imagem.naturalWidth < 1 || imagem.naturalHeight < 1) throw new Error('Enquadramento inválido')
  contexto.clearRect(0, 0, lado, lado)
  contexto.save()
  contexto.beginPath(); contexto.arc(lado / 2, lado / 2, lado / 2, 0, 2 * Math.PI); contexto.clip()
  const escala = lado * zoom / Math.max(imagem.naturalWidth, imagem.naturalHeight)
  const largura = imagem.naturalWidth * escala, altura = imagem.naturalHeight * escala
  contexto.drawImage(imagem, (lado - largura) / 2 + x * lado, (lado - altura) / 2 + y * lado, largura, altura)
  contexto.restore()
}

/** D-076: somente o recorte confirmado vira PNG; não amplia os pixels do original. */
export async function prepararLogoLoja(imagem: HTMLImageElement, enquadramento: EnquadramentoLogo): Promise<string> {
  try {
    const ladoMaximo = Math.max(1, Math.floor(Math.max(imagem.naturalWidth, imagem.naturalHeight) / enquadramento.zoom))
    for (const limite of [LADO_LOGO, 384, 256, 192, 128, 96, 64, 32, 16, 8, 1]) {
      const lado = Math.min(limite, ladoMaximo)
      const tela = document.createElement('canvas')
      tela.width = lado; tela.height = lado
      const contexto = tela.getContext('2d')
      if (!contexto) throw new Error('Imagem indisponível')
      desenharLogoCircular(contexto, imagem, lado, enquadramento)
      const png = await new Promise<Blob | null>((resolver) => tela.toBlob(resolver, 'image/png'))
      if (png?.type === 'image/png' && png.size <= LIMITE_LOGO_BYTES) {
        const logo = tela.toDataURL('image/png')
        if (logoValida(logo)) return logo
      }
      tela.width = 0; tela.height = 0
    }
    throw new Error('Imagem grande demais')
  } catch { throw new Error('Não consegui preparar esta logo. Tente outra imagem.') }
}
