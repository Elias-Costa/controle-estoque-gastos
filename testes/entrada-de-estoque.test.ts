import { expect, test } from 'bun:test'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarOperacoesEstoque } from '../src/dados/operacoes-estoque.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { conferirEntrada, rascunhoDaEntrada } from '../src/interface/rascunho-da-entrada.ts'
import { lerEstoque } from '../src/interface/leitura-de-estoque.ts'
import { referenciaDoEfeito } from '../src/dominio/estoque.ts'
import { aplicarMascara } from '../src/interface/mascara-de-dinheiro.ts'
import { compra, ok } from './apoio-estoque.ts'

const base = { produtoId: 'p', quantidadeTexto: '3', custoTexto: '33,35', data: '2026-10-19' }

test('total exato, zero explícito e custo desconhecido percorrem a máscara usada no formulário', () => {
  expect(ok(conferirEntrada({ ...base, custoTexto: aplicarMascara('3335', true) }, 'compra', base.data)).total).toBe(10005n)
  const vazio = ok(conferirEntrada({ ...base, custoTexto: '' }, 'compra', base.data))
  expect(vazio.total).toBeUndefined()
  expect(vazio.entrada.tipo === 'compra' && vazio.entrada.custoUnitario).toBeUndefined()
  const zero = ok(conferirEntrada({ ...base, custoTexto: aplicarMascara('0', true) }, 'compra', base.data))
  expect(zero.total).toBe(0n)
  expect(zero.entrada.tipo === 'compra' && zero.entrada.custoUnitario).toBe(0n)
  expect(ok(conferirEntrada({ ...base, custoTexto: '90.071.992.547.409,93' }, 'compra', base.data)).total).toBe(27021597764222979n)
})

for (const quantidadeTexto of ['', '0', '-1', '1.5', '1,5', '3x', '9007199254740992']) {
  test(`compra recusa quantidade inválida: ${quantidadeTexto}`, () => {
    expect(conferirEntrada({ ...base, quantidadeTexto }, 'compra', base.data)).toEqual({ ok: false, motivo: 'quantidade-invalida' })
  })
}
for (const data of ['', '2026-10-20', '2026-02-30', '2026-13-01', '2025-02-29']) {
  test(`data do fato recusada: ${data}`, () => {
    expect(conferirEntrada({ ...base, data }, 'compra', base.data)).toEqual({ ok: false, motivo: 'data-invalida' })
  })
}
test('data retroativa não é trocada pelo lançamento; contagem zero não é compra zero', () => {
  expect(ok(conferirEntrada({ ...base, data: '2024-02-29' }, 'compra', base.data)).entrada.data).toBe('2024-02-29')
  expect(ok(conferirEntrada({ ...base, quantidadeTexto: '0' }, 'estoque-inicial', base.data))).toEqual({ entrada: {
    tipo: 'contagem', produtoId: 'p', totalContado: 0, motivo: 'estoque-inicial', data: base.data,
  } })
  expect(conferirEntrada({ ...base, custoTexto: 'não é custo' }, 'compra', base.data)).toEqual({ ok: false, motivo: 'custo-invalido' })
  expect(conferirEntrada({ ...base, produtoId: '' }, 'compra', base.data)).toEqual({ ok: false, motivo: 'produto-inexistente' })
})
test('nova entrada não presume custo e correção abre quantidade, custo e data originais', () => {
  expect(rascunhoDaEntrada('p', base.data)).toEqual({ produtoId: 'p', quantidadeTexto: '', custoTexto: '', data: base.data })
  expect(rascunhoDaEntrada('outro', base.data, compra())).toEqual({ produtoId: 'perfume', quantidadeTexto: '10', custoTexto: '30,00', data: '2026-10-01' })
})

test('leitura após compra/correção conserva custo da entrega e distingue versões, anulação e problema', async () => {
  const banco = new BancoLocal('entrada-e24', { indexedDB: new IDBFactory(), IDBKeyRange })
  try {
    const repo = criarRepositorioEstoque(banco), ops = criarOperacoesEstoque(repo)
    const categoria = ok(await ops.cadastrarCategoria('Perfume'))
    const produto = ok(await ops.cadastrarProduto({ nome: 'Produto', categoriaId: categoria.id, custoManual: 2500n }))
    await banco.clientes.put({ id: 'c', nome: 'Vera', atualizadoEm: '2026-10-19T10:00:00Z' })
    const inicial = ok(await ops.registrarMovimento({ tipo: 'contagem', produtoId: produto.id, data: base.data, totalContado: 7, motivo: 'estoque-inicial' }))
    expect(lerEstoque(await repo.lerEstado(), produto.id)).toMatchObject({ fisico: 7, custo: 2500n })
    const compra1 = ok(await ops.registrarMovimento({ tipo: 'compra', produtoId: produto.id, data: base.data, quantidade: 3, custoUnitario: 3335n }))
    const alvo = compra1.movimentos[0]!
    await ops.lancarVenda({ clienteId: 'c', data: base.data, desconto: 0n, pagamento: 'avista', forma: 'dinheiro',
      itens: [{ descricao: 'Produto', produtoId: produto.id, quantidade: 1, precoUnitario: 5000n, entregue: 1 }] })
    const compra2 = ok(await ops.registrarMovimento({ tipo: 'compra', produtoId: produto.id, data: '2026-09-30', quantidade: 2, custoUnitario: 4000n }))
    expect(lerEstoque(await repo.lerEstado(), produto.id)).toMatchObject({ fisico: 11, custo: 3335n })
    await ops.corrigirRegistroMovimento(referenciaDoEfeito(alvo), { tipo: 'compra', produtoId: produto.id, data: base.data, quantidade: 4, custoUnitario: 3500n })
    let leitura = lerEstoque(await repo.lerEstado(), produto.id)
    expect(leitura.fisico).toBe(12)
    expect(leitura.historico.find((item) => item.movimento.id === alvo.id && item.movimento.revisao === 1)).toMatchObject({ superada: true, corrigivel: false })
    expect(leitura.historico.find((item) => item.movimento.tipo === 'entrega')?.movimento).toMatchObject({ custoUnitario: 3335n })
    const envio = await repo.capturarEnvio(compra2.operacao.id)
    if (!envio) throw new Error('sem captura')
    await repo.responderEnvio(envio)
    await ops.corrigirRegistroMovimento(referenciaDoEfeito(compra2.movimentos[0]!), { tipo: 'compra', produtoId: produto.id, data: '2026-09-30', quantidade: 1 })
    leitura = lerEstoque(await repo.lerEstado(), produto.id)
    expect(leitura.historico.find((item) => item.movimento.id === compra2.movimentos[0]!.id)).toMatchObject({ anulada: true, corrigivel: false })
    expect(leitura.historico.filter((item) => item.movimento.tipo === 'anulacao')).toHaveLength(1)
    expect(leitura.fisico).toBe(11)
    const tentativa = await repo.capturarEnvio(inicial.operacao.id)
    if (!tentativa) throw new Error('sem contagem')
    await repo.responderEnvio(tentativa, { codigo: '23000', mensagem: 'teste', em: '2026-10-19T10:00:00Z' })
    expect(lerEstoque(await repo.lerEstado(), produto.id).historico.find((item) => item.movimento.id === inicial.movimentos[0]!.id)).toMatchObject({ problema: true, corrigivel: false })
  } finally { banco.close() }
})
