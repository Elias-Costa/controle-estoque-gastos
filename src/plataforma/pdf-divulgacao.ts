import { jsPDF } from 'jspdf'
import { emReais } from '../dominio/dinheiro.ts'
import type { ItemPdfDivulgacao } from '../interface/divulgacao-produtos.ts'
import { identidadeLojaValida, type IdentidadeLoja } from '../dados/identidade-loja.ts'

// D-076: paleta da referência da loja; dourado nas molduras, cores escuras para leitura.
const CORES = { verde: '#123F32', dourado: '#B58A4D', creme: '#F7F0E6', terracota: '#95513F',
  texto: '#343632', suave: '#555149', papel: '#FFFDFC', borda: '#D7BF99' } as const

function conferirLetras(fonte: unknown, texto: string): void {
  // jsPDF 4.2.1: glifo zero significa ausência no cmap; não publicar nomes mutilados.
  if (!fonte || typeof fonte !== 'object' || !('characterToGlyph' in fonte) || typeof fonte.characterToGlyph !== 'function') throw new Error('Não consegui conferir as letras do PDF.')
  for (const letra of texto.normalize('NFC')) {
    if (letra === '\n' || letra === '\r') continue
    if (!fonte.characterToGlyph.call(fonte, letra.codePointAt(0))) throw new Error('Um nome ou marca tem uma letra que não consegui escrever no PDF. Confira o cadastro.')
  }
}

/** D-074: PDF local identificado pela vendedora; módulo sob demanda, fonte livre no precache. */
export async function gerarPdfDivulgacao(itens: readonly ItemPdfDivulgacao[], geradoEm: string, identidade: IdentidadeLoja): Promise<File> {
  if (!identidadeLojaValida(identidade)) throw new Error('Informe a identificação da loja.')
  if (!itens.length) throw new Error('Escolha pelo menos um produto.')
  for (const item of itens) {
    if (typeof item.preco !== 'bigint' || item.preco < 0n || !item.foto.length || !Number.isSafeInteger(item.quantidade) || item.quantidade < 1) throw new Error('Produto incompleto para o PDF.')
  }
  const resposta = await fetch(`${import.meta.env.BASE_URL}fontes/noto-sans-regular.ttf`)
  if (!resposta.ok) throw new Error('Não consegui preparar as letras do PDF.')
  const fonte = new Uint8Array(await resposta.arrayBuffer())
  let binario = ''
  for (let i = 0; i < fonte.length; i += 8192) binario += String.fromCharCode(...fonte.subarray(i, i + 8192))
  const doc = new jsPDF({ unit: 'pt', format: [420, 594], compress: true, putOnlyUsedFonts: true })
  doc.addFileToVFS('NotoSans-Regular.ttf', btoa(binario))
  doc.addFont('NotoSans-Regular.ttf', 'Noto', 'normal')
  doc.setFont('Noto')
  conferirLetras(doc.getFont().metadata, identidade.nome)
  conferirLetras(doc.getFont().metadata, identidade.descricao)
  doc.setProperties({ title: `${identidade.nome} - Produtos disponíveis`, author: identidade.nome })
  const xNome = identidade.logo ? 96 : 24
  doc.setFontSize(24)
  const nomes: string[] = doc.splitTextToSize(identidade.nome.normalize('NFC'), 396 - xNome)
  doc.setFontSize(10)
  const descricao: string[] = identidade.descricao ? doc.splitTextToSize(identidade.descricao.normalize('NFC'), 372) : []
  const alturaDaMarca = Math.max(identidade.logo ? 56 : 0, nomes.length * 29)
  const fimDaMarca = 24 + alturaDaMarca
  const yTitulo = fimDaMarca + (descricao.length ? 14 + (descricao.length - 1) * 13 + 28 : 24)
  const inicioDosProdutos = yTitulo + 68
  if (inicioDosProdutos > 432) throw new Error('A identificação ficou grande demais para o PDF. Encurte o nome ou a descrição.')
  let pagina = 1
  let y = inicioDosProdutos
  function cabecalho() {
    doc.setFillColor(CORES.creme).rect(0, 0, 420, 594, 'F')
    doc.setFillColor(CORES.verde).rect(0, 0, 420, 7, 'F')
    doc.setFillColor(CORES.dourado).rect(0, 7, 420, 2, 'F')
    if (identidade.logo) {
      const imagem = doc.getImageProperties(identidade.logo)
      const escala = Math.min(56 / imagem.width, 56 / imagem.height)
      doc.addImage(identidade.logo, 'PNG', 24 + (56 - imagem.width * escala) / 2, 24 + (56 - imagem.height * escala) / 2,
        imagem.width * escala, imagem.height * escala, 'logo-loja')
    }
    doc.setTextColor(CORES.verde).setFontSize(24).text(nomes, xNome, 44 + (alturaDaMarca - nomes.length * 29) / 2, { lineHeightFactor: 29 / 24 })
    if (descricao.length) doc.setTextColor(CORES.suave).setFontSize(10).text(descricao, 24, fimDaMarca + 14, { lineHeightFactor: 1.3 })
    doc.setDrawColor(CORES.dourado).setLineWidth(0.7).line(24, yTitulo - 21, 396, yTitulo - 21)
    doc.setTextColor(CORES.verde).setFontSize(18).text('Produtos disponíveis', 24, yTitulo)
    doc.setFontSize(10).text(`Gerado em ${geradoEm} | ${itens.length} produtos`, 24, yTitulo + 18)
    doc.setTextColor(CORES.suave).setFontSize(10).text(['Quantidade e preço no momento da geração.', 'A disponibilidade pode mudar; isto não é uma reserva.'], 24, yTitulo + 36)
  }
  function rodape() {
    doc.setDrawColor(CORES.dourado).setLineWidth(0.7).line(24, 560, 396, 560)
    doc.setTextColor(CORES.suave).setFontSize(9).text(`Página ${pagina}`, 396, 576, { align: 'right' })
  }
  cabecalho()
  for (let i = 0; i < itens.length; i++) {
    const item = itens[i]
    if (!item) throw new Error('Lista incompleta.')
    conferirLetras(doc.getFont().metadata, item.nome)
    if (item.marca) conferirLetras(doc.getFont().metadata, item.marca)
    doc.setFontSize(14)
    const nome: string[] = doc.splitTextToSize(item.nome.normalize('NFC'), 240)
    doc.setFontSize(11)
    const marca: string[] = doc.splitTextToSize(item.marca ? `Marca: ${item.marca.normalize('NFC')}` : 'Marca não informada', 240)
    doc.setFontSize(15)
    const preco: string[] = doc.splitTextToSize(item.preco === 0n ? `${emReais(item.preco)} (gratuito)` : emReais(item.preco), 240)
    const altura = Math.max(116, nome.length * 17 + marca.length * 14 + preco.length * 18 + 55)
    // Ensaio E-28C: bloco inteiro; nunca cortar nomes ou separar foto/informações entre páginas.
    if (altura > 548 - inicioDosProdutos) throw new Error('Um nome ou marca ficou grande demais para o PDF. Confira o cadastro e tente novamente.')
    if (y + altura > 552) { rodape(); doc.addPage(); pagina++; y = inicioDosProdutos; cabecalho() }
    doc.setFillColor(CORES.papel).setDrawColor(CORES.borda).setLineWidth(0.6).roundedRect(24, y, 372, altura - 6, 7, 7, 'FD')
    const imagem = doc.getImageProperties(item.foto)
    const escala = Math.min(88 / imagem.width, 88 / imagem.height)
    const largura = imagem.width * escala, alturaFoto = imagem.height * escala
    doc.addImage(item.foto, 'JPEG', 34 + (88 - largura) / 2, y + 10 + (88 - alturaFoto) / 2, largura, alturaFoto, `foto-${i}`)
    let textoY = y + 21
    doc.setTextColor(CORES.verde).setFontSize(14).text(nome, 138, textoY, { lineHeightFactor: 17 / 14 })
    textoY += nome.length * 17 + 4
    doc.setTextColor(CORES.suave).setFontSize(11).text(marca, 138, textoY, { lineHeightFactor: 14 / 11 })
    textoY += marca.length * 14 + 5
    doc.setTextColor(CORES.terracota).setFontSize(15).text(preco, 138, textoY, { lineHeightFactor: 18 / 15 })
    textoY += preco.length * 18 + 3
    doc.setTextColor(CORES.texto).setFontSize(11).text(`Quantidade disponível: ${item.quantidade}`, 138, textoY)
    y += altura
    if (i % 10 === 0) await new Promise<void>((resolver) => setTimeout(resolver, 0))
  }
  rodape()
  return new File([doc.output('blob')], 'produtos-disponiveis.pdf', { type: 'application/pdf' })
}
