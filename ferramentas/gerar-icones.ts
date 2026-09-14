/**
 * Gera, a partir de `public/favicon.svg`, os PNG que o Safari e o Chrome pedem para instalar o
 * app (E-13, RF-23, D-038, D-048): o `apple-touch-icon` de 180, os ícones de 192 e 512 do
 * manifesto, a versão "maskable" de 512 (o desenho encolhido para a zona segura do Android) e
 * as imagens de abertura do iPhone (`apple-touch-startup-image`, uma por tamanho de tela).
 *
 * Rasteriza pelo Chromium do Playwright, que já está instalado desde E-08 — sem dependência
 * nova, sem editor de imagem. `bun run icones`; os arquivos gerados entram no git.
 *
 * A tabela de tamanhos de iPhone é de memória, **não verificada** (D-048 item 4): o que não
 * casar cai no que o iOS faz sem imagem. O script confere que `index.html` declara um `<link>`
 * para cada tamanho, para a tabela e as tags não divergirem em silêncio.
 */

import { chromium, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const FUNDO_DA_ABERTURA = '#f7f7f8' // o `fundo` de src/index.css, tema claro
const SVG = readFileSync('public/favicon.svg', 'utf8')

/** Os ícones quadrados: nome, lado e se o desenho encolhe para a zona segura (maskable). */
const ICONES = [
  { nome: 'icone-180.png', lado: 180, mascaravel: false },
  { nome: 'icone-192.png', lado: 192, mascaravel: false },
  { nome: 'icone-512.png', lado: 512, mascaravel: false },
  { nome: 'icone-mascaravel-512.png', lado: 512, mascaravel: true },
] as const

/** Tamanhos lógicos (pt) e densidade dos iPhones, retrato; o arquivo é em pixels físicos. */
const ABERTURAS = [
  { largura: 320, altura: 568, densidade: 2 },
  { largura: 375, altura: 667, densidade: 2 },
  { largura: 414, altura: 736, densidade: 3 },
  { largura: 375, altura: 812, densidade: 3 },
  { largura: 414, altura: 896, densidade: 2 },
  { largura: 414, altura: 896, densidade: 3 },
  { largura: 390, altura: 844, densidade: 3 },
  { largura: 428, altura: 926, densidade: 3 },
  { largura: 393, altura: 852, densidade: 3 },
  { largura: 430, altura: 932, densidade: 3 },
  { largura: 402, altura: 874, densidade: 3 },
  { largura: 440, altura: 956, densidade: 3 },
] as const

/** O arquivo de uma abertura, em pixels físicos. */
function arquivoDaAbertura({ largura, altura, densidade }: (typeof ABERTURAS)[number]): string {
  return `abertura/${largura * densidade}x${altura * densidade}.png`
}

/** A `media` do `<link rel="apple-touch-startup-image">` de um tamanho. */
function mediaDaAbertura({ largura, altura, densidade }: (typeof ABERTURAS)[number]): string {
  return `screen and (device-width: ${largura}px) and (device-height: ${altura}px) and (-webkit-device-pixel-ratio: ${densidade}) and (orientation: portrait)`
}

/** O SVG com o desenho encolhido para a zona segura (80 % do lado, centrado) — a versão "maskable". */
function svgMascaravel(): string {
  const marcado = SVG.replace('<g id="desenho">', '<g id="desenho" transform="translate(256 256) scale(0.8) translate(-256 -256)">')
  if (marcado === SVG) throw new Error('public/favicon.svg sem <g id="desenho">: o script encolhe esse grupo')
  return marcado
}

async function renderizar(page: Page, html: string, largura: number, altura: number, caminho: string): Promise<void> {
  await page.setViewportSize({ width: largura, height: altura })
  await page.setContent(html)
  writeFileSync(`public/${caminho}`, await page.screenshot({ type: 'png' }))
  console.log(`  ${caminho} (${largura}×${altura})`)
}

/** Confere que `index.html` tem o `<link>` de cada abertura; a tabela mora aqui, as tags lá. */
function conferirIndex(): void {
  const index = readFileSync('index.html', 'utf8')
  const faltando = ABERTURAS.filter((a) => !index.includes(`href="/${arquivoDaAbertura(a)}"`) || !index.includes(`media="${mediaDaAbertura(a)}"`))
  if (faltando.length > 0) {
    console.error('index.html sem o <link rel="apple-touch-startup-image"> destes tamanhos:')
    for (const a of faltando) console.error(`  <link rel="apple-touch-startup-image" href="/${arquivoDaAbertura(a)}" media="${mediaDaAbertura(a)}" />`)
    process.exitCode = 1
  }
}

mkdirSync('public/icones', { recursive: true })
mkdirSync('public/abertura', { recursive: true })

const navegador = await chromium.launch()
const page = await navegador.newPage()
try {
  console.log('ícones:')
  for (const icone of ICONES) {
    const svg = icone.mascaravel ? svgMascaravel() : SVG
    await renderizar(page, `<body style="margin:0">${svg.replace(/width="512" height="512"/, `width="${icone.lado}" height="${icone.lado}"`)}</body>`, icone.lado, icone.lado, `icones/${icone.nome}`)
  }
  console.log('aberturas:')
  for (const abertura of ABERTURAS) {
    const largura = abertura.largura * abertura.densidade
    const altura = abertura.altura * abertura.densidade
    // O ícone com os cantos arredondados como o iOS mostra, num quarto da largura, no centro.
    const lado = Math.round(largura * 0.25)
    const html = `<body style="margin:0;background:${FUNDO_DA_ABERTURA};display:flex;align-items:center;justify-content:center;width:${largura}px;height:${altura}px">
      <div style="width:${lado}px;height:${lado}px;border-radius:22%;overflow:hidden">${SVG.replace(/width="512" height="512"/, `width="${lado}" height="${lado}"`)}</div></body>`
    await renderizar(page, html, largura, altura, arquivoDaAbertura(abertura))
  }
} finally {
  await navegador.close()
}
conferirIndex()
