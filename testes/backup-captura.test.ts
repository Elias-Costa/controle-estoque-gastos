import { describe, expect, test } from 'bun:test'
import { carregarFontesBackup, dadosDaCaptura, lerCapturaServidor, materialDaCaptura, pacoteDaCaptura, type CapturaServidor, type FontesBackup } from '../nuvem/backup/captura.ts'
import { lerArquivoCopia } from '../src/plataforma/arquivo-copia.ts'
import { hashDaFoto } from '../src/plataforma/fotos.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { documentoEstoque } from '../src/sincronizacao/borda-estoque.ts'

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
  })
  test('original errado/ausente ou caminho alheio impede o pacote antes da publicação', async () => {
    const { c, fontes } = await caso()
    await expect(dadosDaCaptura(c, fontes, async () => new Uint8Array([1, 2, 3]))).rejects.toThrow()
    const ref = fontes.fotos[0]
    if (typeof ref !== 'object' || ref === null) throw new Error('Fixture ausente')
    await expect(dadosDaCaptura(c, { ...fontes, fotos: [{ ...ref, caminho: `outra/${uuidv7()}.jpeg` }] }, async () => { throw new Error('Não deve baixar') })).rejects.toThrow()
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
