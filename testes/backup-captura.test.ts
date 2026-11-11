import { describe, expect, test } from 'bun:test'
import { carregarFontesBackup, dadosDaCaptura, lerCapturaServidor, materialDaCaptura, pacoteDaCaptura, type CapturaServidor, type FontesBackup } from '../nuvem/backup/captura.ts'
import { criarArquivoBackup, dataInternaDaCopia, entradasDeDadosCopia, lerArquivoCopia, manifestoDaCopia } from '../src/plataforma/arquivo-copia.ts'
import { hashDaFoto } from '../src/plataforma/fotos.ts'
import { indexarMaterialBackup } from '../src/plataforma/material-backup.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { documentoEstoque } from '../src/sincronizacao/borda-estoque.ts'
import { consultasDaCopia } from '../src/dados/consultas-copia.ts'
import { TABELAS_COPIA } from '../src/dados/tipos-copia.ts'
import { fecharLotesZip, fonteDoZip, gravarLotesZip, shaDosLotes, type ArmazemDeLotes } from '../nuvem/backup/lotes.ts'
import { gruposDeFotos } from '../nuvem/backup/retomavel.ts'

async function caso() {
  const cliente = uuidv7(), categoria = uuidv7(), produto = uuidv7(), foto = uuidv7(), copia = uuidv7(), compra = uuidv7(), operacao = uuidv7(), fato = uuidv7()
  const c: CapturaServidor = { id: uuidv7(), dia: '2026-11-05', capturadoEm: '2026-11-05T14:00:00.000Z',
    vinculo: { contaId: uuidv7(), destino: 'http://127.0.0.1:54321' } }
  const binario = new Uint8Array(await Bun.file('testes/arquivos/foto-teste.jpeg').arrayBuffer())
  const miniatura = new Uint8Array(await Bun.file('testes/arquivos/foto-teste-miniatura.jpeg').arrayBuffer())
  const grupo = { operacao: { id: operacao, revisao: 1, formato: 1, tipo: 'movimento', lancamentos: [], movimentos: [{ id: compra, revisao: 1 }], dependencias: [] },
    lancamentos: [], movimentos: [{ id: compra, revisao: 1, operacaoId: operacao, produtoId: produto, data: c.dia,
      conhecidos: [], tipo: 'compra', quantidade: 7, custoUnitario: '9007199254740993', ordemCadastro: '1' }] }
  const fontes: FontesBackup = {
    clientes: [{ id: cliente, nome: 'Cliente fictícia do servidor', telefone: null, apelido: null, observacao: null, desativado_em: null, atualizado_em: c.capturadoEm }],
    lancamentos: [{ id: uuidv7(), clienteId: cliente, data: c.dia, tipo: 'saldo-anterior', parcelas: [{ id: uuidv7(), vencimento: c.dia, valor: '9007199254740993' }] }],
    categorias: [{ id: categoria, nome: 'Categoria fictícia' }],
    produtos: [{ id: produto, nome: 'Produto com foto', categoria_id: categoria, atualizado_em: c.capturadoEm, foto_id: foto, classificacao: null,
      marca: null, codigo_catalogo: null, custo_manual: null, preco_venda: '10000', estoque_minimo: 1 }],
    estoque: [{ recepcao: '1', tipo: 'operacao', grupo, evidencias: [], encerramentoId: null }],
    caixa: [{ recepcao: '1', grupo: { operacao: { id: uuidv7(), revisao: 1, formato: 1, tipo: 'registro', fatos: [{ id: fato, revisao: 1 }] },
      fatos: [{ id: fato, revisao: 1, tipo: 'despesa', data: c.dia, valor: '10000', categoria: 'Teste', classificacao: 'negocio', mercadoria: false }] } }],
    modelos: [], identidades: [], fotos: [{ fotoId: foto, copiaId: copia, produtoId: produto, cadastroEm: c.capturadoEm,
      caminho: `${c.vinculo.contaId}/${foto}/${copia}.jpeg`, disponivel: true, bytes: binario.byteLength, sha256: await hashDaFoto(binario), largura: 768, altura: 1024 }],
  }
  return { c, fontes, grupo, binario, miniatura }
}

describe('BA-02 captura do servidor → dados/ZIP, sem Google/Edge reais', () => {
  test('preserva centavos/fatos/estoque/foto; ZIP da mesma captura é reproduzível e importável', async () => {
    const { c, fontes, binario, miniatura } = await caso()
    const d = await dadosDaCaptura(c, fontes, async () => binario)
    expect(d.lancamentos[0]?.tipo === 'saldo-anterior' && d.lancamentos[0].parcelas[0]?.valor).toBe(9007199254740993n)
    expect(d.movimentos[0]?.tipo === 'compra' && d.movimentos[0].custoUnitario).toBe(9007199254740993n)
    expect(d.movimentos[0]?.tipo === 'compra' && d.movimentos[0].quantidade).toBe(7)
    expect(d.fatosCaixa[0]?.tipo === 'despesa' && d.fatosCaixa[0].valor).toBe(10000n)
    expect(d.fila).toEqual([]); expect(d.fotos[0]?.miniatura).toBeUndefined()
    const a = await pacoteDaCaptura(c, d)
    await new Promise((resolver) => setTimeout(resolver, 2100))
    const b = await pacoteDaCaptura(c, await dadosDaCaptura(c, fontes, async () => binario))
    expect(await hashDaFoto(new Uint8Array(await a.arrayBuffer()))).toBe(await hashDaFoto(new Uint8Array(await b.arrayBuffer())))
    const lido = await lerArquivoCopia(a, c.vinculo, async () => miniatura)
    expect(lido.origem).toEqual({ tipo: 'servidor' }); expect(lido.dados.lancamentos).toEqual(d.lancamentos)
    expect(lido.dados.movimentos).toEqual(d.movimentos); expect(lido.dados.fatosCaixa).toEqual(d.fatosCaixa)
    expect(lido.dados.fotos[0]?.binario).toEqual(binario); expect(lido.dados.fotos[0]?.miniatura).toEqual(miniatura)
    const material = await materialDaCaptura(d)
    expect(material.length).toBeGreaterThan(0); expect(material.every((h) => /^[a-f0-9]{64}$/.test(h))).toBe(true)
    expect(material).toEqual((await indexarMaterialBackup(d)).material)
  })
  test('original errado/ausente ou caminho alheio impede o pacote antes da publicação', async () => {
    const { c, fontes } = await caso()
    await expect(dadosDaCaptura(c, fontes, async () => new Uint8Array([1, 2, 3]))).rejects.toThrow()
    const ref = fontes.fotos[0]
    if (typeof ref !== 'object' || ref === null) throw new Error('Fixture ausente')
    await expect(dadosDaCaptura(c, { ...fontes, fotos: [{ ...ref, caminho: `outra/${uuidv7()}.jpeg` }] }, async () => { throw new Error('Não deve baixar') })).rejects.toThrow()
  })
  test('BA-04 confere o original uma vez no empacotador e conserva os mesmos bytes com SHA nativo', async () => {
    const { c, fontes, binario } = await caso()
    const dados = await dadosDaCaptura(c, fontes, async () => binario)
    let hashesDoOriginal = 0
    const web = await criarArquivoBackup({ id: c.id, tipo: 'exportacao', vinculo: c.vinculo, capturadoEm: c.capturadoEm, pronto: true },
      dados, { tipo: 'servidor' }, undefined, async (blob) => {
        if (blob.size === binario.byteLength) hashesDoOriginal++
        return hashDaFoto(new Uint8Array(await blob.arrayBuffer()))
      })
    expect(hashesDoOriginal).toBe(1)
    expect(new Uint8Array(await web.arrayBuffer())).toEqual(new Uint8Array(await (await pacoteDaCaptura(c, dados)).arrayBuffer()))
  })
  test('BA-04 recusa corrupção do mesmo tamanho e troca de bytes antes da escrita do original', async () => {
    const { c, fontes, binario } = await caso()
    const errado = new Uint8Array(binario); errado[0] = (errado[0] ?? 0) ^ 1
    const corrompidos = await dadosDaCaptura(c, fontes, async () => errado)
    await expect(pacoteDaCaptura(c, corrompidos)).rejects.toMatchObject({ motivo: 'foto' })
    const dados = await dadosDaCaptura(c, fontes, async () => new Uint8Array(binario))
    await expect(pacoteDaCaptura(c, dados, (etapa) => {
      if (etapa === 'zip_dados') dados.fotos[0]?.binario?.fill(0)
    })).rejects.toMatchObject({ motivo: 'foto' })
  })
  test('BA-04 o conteúdo já conferido e escrito não muda com o buffer do chamador', async () => {
    const { c, fontes, binario, miniatura } = await caso()
    const comMargens = new Uint8Array(binario.length + 32).fill(123)
    comMargens.set(binario, 16)
    const dados = await dadosDaCaptura(c, fontes, async () => comMargens.subarray(16, -16))
    const arquivo = await pacoteDaCaptura(c, dados, (etapa) => {
      if (etapa === 'zip_consultas') dados.fotos[0]?.binario?.fill(0)
    })
    const lido = await lerArquivoCopia(arquivo, c.vinculo, async () => miniatura)
    expect(lido.dados.fotos[0]?.binario).toEqual(binario)
  })
  test('baixa originais em lotes limitados sem trocar a ordem do ZIP', async () => {
    const { c, fontes, binario } = await caso()
    const ref = fontes.fotos[0], produto = fontes.produtos[0]
    if (typeof ref !== 'object' || ref === null || typeof produto !== 'object' || produto === null) throw new Error('Fixture ausente')
    const pares = Array.from({ length: 9 }, () => {
      const fotoId = uuidv7(), copiaId = uuidv7(), produtoId = uuidv7()
      return {
        foto: { ...ref, fotoId, copiaId, produtoId, caminho: `${c.vinculo.contaId}/${fotoId}/${copiaId}.jpeg` },
        produto: { ...produto, id: produtoId, foto_id: fotoId },
      }
    })
    const fotos = pares.map((par) => par.foto)
    let ativos = 0, maximo = 0
    const concluidos: unknown[] = []
    const d = await dadosDaCaptura(c, { ...fontes, fotos, produtos: [{ ...produto, foto_id: null }, ...pares.map((par) => par.produto)] }, async (original) => {
      maximo = Math.max(maximo, ++ativos)
      await Bun.sleep(original['fotoId'] === fotos[0]?.fotoId ? 20 : 0)
      concluidos.push(original['fotoId'])
      ativos--
      return binario
    })
    expect(maximo).toBe(8)
    expect(concluidos[0]).not.toBe(fotos[0]?.fotoId)
    expect(d.fotos.map((foto) => foto.id)).toEqual(fotos.map((foto) => foto.fotoId))
  })
  test('cabeçalho de outra conta/destino e lote truncado não são aceitos como captura inteira', async () => {
    const { c } = await caso()
    expect(lerCapturaServidor(c, c.vinculo)).toEqual(c)
    expect(() => lerCapturaServidor({ ...c, vinculo: { ...c.vinculo, contaId: uuidv7() } }, c.vinculo)).toThrow()
    await expect(carregarFontesBackup(async () => ({ linhas: [], total: 2 }), c)).rejects.toThrow()
    let chamadas = 0
    await expect(carregarFontesBackup(async () => (++chamadas === 1
      ? { linhas: Array.from({ length: 250 }, () => ({})), total: 251 } : { linhas: [{}], total: 252 }), c)).rejects.toThrow()
  })
  test('Q47A conserva tentativa recusada e retoma somente a nova operação ainda não aceita', async () => {
    const { c, fontes, grupo, binario } = await caso()
    const novoId = uuidv7(), movimentoId = uuidv7()
    const recusada = { ...grupo, operacao: { ...grupo.operacao, revisao: 2, movimentos: grupo.operacao.movimentos.map((r) => ({ ...r, revisao: 2 })) },
      movimentos: grupo.movimentos.map((m) => ({ ...m, revisao: 2, quantidade: 9 })) }
    const nova = { ...grupo, operacao: { ...grupo.operacao, id: novoId, movimentos: [{ id: movimentoId, revisao: 1 }] },
      movimentos: grupo.movimentos.map((m) => ({ ...m, id: movimentoId, operacaoId: novoId, quantidade: 9 })) }
    const fim = { recepcao: '2', tipo: 'encerramento', encerramento: { id: uuidv7(), data: c.dia,
      tentativa: { id: grupo.operacao.id, revisao: 2, conteudo: 'conteudo original textual preservado' },
      evidencia: { grupo: recusada, desfecho: 'recusada', diagnostico: 'Fictício Q47A' }, aceitosConhecidos: [grupo], novaOperacao: nova } }
    const d = await dadosDaCaptura(c, { ...fontes, estoque: [...fontes.estoque, documentoEstoque(fim)] }, async () => binario)
    expect(d.encerramentos).toHaveLength(1); expect(d.versoesEstoque).toHaveLength(3)
    expect(d.fila.map((f) => f.registroId)).toEqual([novoId])
    expect(d.operacoes.map((o) => o.id)).toEqual([grupo.operacao.id, novoId])
    expect(d.movimentos).toHaveLength(2)
    expect(new Set(d.versoesEstoque.map((v) => v.id)).size).toBe(3)
  })
})

describe('BA-04 preparo retomável do ZIP', () => {
  test('um ZIP retomado por intervalos conserva o conteúdo e o índice recusa objeto corrompido', async () => {
    const { c, fontes, binario, miniatura } = await caso()
    const dados = await dadosDaCaptura(c, fontes, async () => binario), foto = dados.fotos[0]
    if (!foto) throw new Error('Foto de teste ausente')
    const objetos = new Map<string, Uint8Array<ArrayBuffer>>(), reservados = new Set<string>()
    const leituras: { inicio: number; fim: number; total: number }[] = []
    const armazem: ArmazemDeLotes = {
      async gravar(caminho, bytes) {
        expect(reservados.has(caminho)).toBe(true)
        if (!objetos.has(caminho)) objetos.set(caminho, bytes.slice())
      },
      async ler(caminho, inicio, fim, total) {
        leituras.push({ inicio, fim, total }); const objeto = objetos.get(caminho)
        if (!objeto) throw new Error('Parte de teste ausente')
        return objeto.slice(inicio, fim)
      },
      async apagar() { throw new Error('A montagem não limpa objetos') },
    }
    const data = dataInternaDaCopia(c.capturadoEm), prefixo = `${c.vinculo.contaId}/${c.id}`
    const gravar = (entradas: Parameters<typeof gravarLotesZip>[0]) => gravarLotesZip(entradas, data, armazem, prefixo, reservar)
    const reservar: Parameters<typeof gravarLotesZip>[4] = async (partes) => { for (const p of partes) reservados.add(p.caminho) }
    const entradasFoto = [{ nome: `fotos/${foto.id}.jpeg`, blob: new Blob([binario]), shaEsperado: foto.sha256 }]
    const jsons = await gravar(entradasDeDadosCopia(dados)), fotos = await gravar(entradasFoto)
    expect(await gravar(entradasFoto)).toEqual(fotos)
    const consultas = await gravar(Object.entries(consultasDaCopia(dados)).map(([nome, texto]) => ({ nome, blob: new Blob([texto]) })))
    const lotes = [...jsons, ...fotos, ...consultas], arquivos = lotes.flatMap((l) => l.arquivos)
    lotes.push(...await gravar([{ nome: 'manifesto.json', blob: manifestoDaCopia(c,
      Object.fromEntries(TABELAS_COPIA.map((t) => [t, dados[t].length])), arquivos, { tipo: 'servidor' }) }]))
    const { indice, retidos } = await fecharLotesZip(lotes, armazem, prefixo, reservar, Number.MAX_SAFE_INTEGER)
    const viva = fonteDoZip(indice, armazem, retidos), retomada = fonteDoZip(indice, armazem)
    leituras.length = 0
    const inteiro = new Uint8Array(await (await viva.slice(0, viva.size)).arrayBuffer())
    expect(leituras).toHaveLength(0)
    const divisa = indice.trechos[0]?.bytes
    if (!divisa) throw new Error('Índice de teste vazio')
    const inicio = divisa - 3, fim = divisa + 7
    expect(new Uint8Array(await (await retomada.slice(inicio, fim)).arrayBuffer())).toEqual(inteiro.slice(inicio, fim))
    expect(leituras).toHaveLength(2)
    expect(leituras.every((r) => r.fim - r.inicio < r.total)).toBe(true)
    const parcial = await fecharLotesZip(lotes, armazem, prefixo, reservar, divisa)
    leituras.length = 0
    const fonteParcial = fonteDoZip(parcial.indice, armazem, parcial.retidos)
    expect(new Uint8Array(await (await fonteParcial.slice(inicio, fim)).arrayBuffer())).toEqual(inteiro.slice(inicio, fim))
    expect(parcial.indice).toEqual(indice)
    expect(leituras).toHaveLength(1)
    expect(shaDosLotes(inteiro)).toBe(indice.sha256)
    expect(inteiro).toEqual(new Uint8Array(await (await pacoteDaCaptura(c, dados)).arrayBuffer()))
    const lido = await lerArquivoCopia(new Blob([inteiro]), c.vinculo, async () => miniatura)
    expect(lido.dados.lancamentos).toEqual(dados.lancamentos)
    expect(lido.dados.movimentos).toEqual(dados.movimentos)
    expect(lido.dados.fatosCaixa).toEqual(dados.fatosCaixa)
    expect(lido.dados.fotos[0]?.binario).toEqual(binario)
    const primeiraFoto = fotos[0]?.segmentos[0]
    if (!primeiraFoto) throw new Error('Parte de teste ausente')
    objetos.get(primeiraFoto.caminho)?.fill(0)
    await expect(fecharLotesZip(lotes, armazem, prefixo, reservar, 0)).rejects.toThrow()
  })

  test('o lote de uma foto depende do original e conserva a chave nas datas seguintes', async () => {
    const { c, fontes } = await caso()
    const referencia = fontes.fotos[0]
    if (typeof referencia !== 'object' || !referencia) throw new Error('Foto de teste ausente')
    const fotos = Array.from({ length: 481 }, () => {
      const fotoId = uuidv7(), copiaId = uuidv7()
      return { ...referencia, fotoId, copiaId, caminho: `${c.vinculo.contaId}/${fotoId}/${copiaId}.jpeg` }
    })
    const anterior = gruposDeFotos(c, fotos)
    const nova = { ...c, id: uuidv7(), capturadoEm: '2026-11-06T14:00:00.000Z' }
    expect(gruposDeFotos(nova, fotos.toReversed())).toEqual(anterior)
    expect(anterior.every((g) => g.referencias.length <= 32)).toBe(true)
    const editadas = fotos.map((ref, i) => i === 0 ? { ...ref, sha256: 'f'.repeat(64) } : ref)
    const chaves = new Set(gruposDeFotos(nova, editadas).map((g) => g.chave))
    expect(anterior.filter((g) => !chaves.has(g.chave))).toHaveLength(1)
  })
})
