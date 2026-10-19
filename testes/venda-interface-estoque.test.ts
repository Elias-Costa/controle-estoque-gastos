import { expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarOperacoesEstoque } from '../src/dados/operacoes-estoque.ts'
import { criarRepositorioEstoque, type EstadoLocalEstoque } from '../src/dados/repositorio-estoque.ts'
import { prepararIntencaoRecusada } from '../src/dados/recuperar-tentativa.ts'
import { projetarEstoque } from '../src/dominio/estoque.ts'
import { saldo, totalDaVenda, type Lancamento } from '../src/dominio/ficha.ts'
import { conferirTroca, prepararTrocaVenda } from '../src/dominio/trocas-venda.ts'
import { ehVendaEstoque, prepararVendaEstoque, prometidoDoProduto } from '../src/dominio/vendas-estoque.ts'
import { conferirVendaComEstoque, rascunhoComEstoque, selecionarProduto, type RascunhoComEstoque } from '../src/interface/venda-com-estoque.ts'
import { lerEstoque } from '../src/interface/leitura-de-estoque.ts'
import { compra, item, ok, operacao, produto, venda } from './apoio-estoque.ts'

function estado(): EstadoLocalEstoque {
  return { produtos: [produto], clientes: ['cliente'], lancamentos: [], movimentos: [compra('compra', 1)], grupos: [], operacoes: [], fila: [], carimbo: 1n }
}
function rascunho(): RascunhoComEstoque {
  return { data: '2026-10-19', pagamento: 'fiado', forma: 'dinheiro', descontoTexto: '', vezes: 3, edicoes: [],
    itens: [{ descricao: 'Perfume', produtoId: produto.id, quantidadeTexto: '3', precoTexto: '33,35' }, { descricao: 'Avulso', precoTexto: '10,00' }] }
}

test('venda mista multiplica preço unitário sem float; sugestão não altera estoque', () => {
  const e = estado(), antes = structuredClone(e)
  const c = conferirVendaComEstoque(rascunho(), e, '2026-10-19')
  expect(c.total).toBe(11005n)
  expect(c.parcelas.map((p) => p.valor)).toEqual([3675n, 3665n, 3665n])
  expect(c.itensLocais.map((i) => i.entregue)).toEqual([1, 0])
  expect(c.linhas[0]?.pendente).toBe(2)
  expect(e).toEqual(antes)
})
test('seleção preserva zero/vazio; preço e entregue podem ser alterados antes da venda', () => {
  expect(selecionarProduto({ descricao: '', precoTexto: '' }, { ...produto, precoVenda: 0n }).precoTexto).toBe('0,00')
  expect(selecionarProduto({ descricao: '', precoTexto: '' }, { ...produto, precoVenda: undefined }).precoTexto).toBe('')
  const r = rascunho(), primeiro = r.itens[0]
  if (!primeiro) throw new Error('sem item')
  const c = conferirVendaComEstoque({ ...r, itens: [{ ...primeiro, precoTexto: '10,01', entregueTexto: '0' }] }, estado(), r.data)
  expect(c.total).toBe(3003n); expect(c.itensLocais[0]?.entregue).toBe(0)
  expect(c.guardas).toEqual([])
})
test('dois itens do mesmo produto não sugerem entregar a mesma unidade duas vezes', () => {
  const r = rascunho(), primeiro = r.itens[0]
  if (!primeiro) throw new Error('sem item')
  expect(conferirVendaComEstoque({ ...r, itens: [primeiro, primeiro] }, estado(), r.data).itensLocais.map((i) => i.entregue)).toEqual([1, 0])
})
test('brinde junto de item pago é permitido, mas uma venda toda gratuita orienta saída por brinde', () => {
  const r = { ...rascunho(), itens: [{ descricao: 'Brinde', precoTexto: '0,00' }] }
  expect(conferirVendaComEstoque(r, estado(), r.data).erro).toContain('brinde')
  expect(conferirVendaComEstoque(r, estado(), r.data, true).erro).toBeUndefined()
  expect(conferirVendaComEstoque({ ...r, itens: [...r.itens, { descricao: 'Pago', precoTexto: '10,00' }] }, estado(), r.data).erro).toBeUndefined()
})
for (const texto of ['', '0', '-1', '1.5', '9007199254740992']) test(`quantidade inválida não habilita venda: ${texto}`, () => {
  const r = rascunho()
  expect(conferirVendaComEstoque({ ...r, itens: [{ ...r.itens[0], descricao: 'P', precoTexto: '1,00', quantidadeTexto: texto }] }, estado(), r.data).erro).toBeDefined()
})
test('venda antiga continua avulsa e edição F2 abre preço unitário, quantidade e identidade', () => {
  const v = venda()
  expect(rascunhoComEstoque(v).itens[0]).toMatchObject({ id: 'item', produtoId: produto.id, quantidadeTexto: '3', precoTexto: '50,00' })
  const antiga = { ...v, itens: [{ descricao: 'Histórico', preco: 15000n }] }
  expect(ehVendaEstoque(antiga)).toBe(false)
  expect(rascunhoComEstoque(antiga).itens[0]?.produtoId).toBeUndefined()
})

function casoTroca() {
  const perfume = item('perfume-item', 1, 10000n)
  const creme = { ...item('creme-item', 1, 5000n), produtoId: 'creme', descricao: 'Creme' }
  const produtos = [produto, { ...produto, id: 'creme', nome: 'Creme' }, { ...produto, id: 'novo', nome: 'Novo' }]
  const original = venda('original', [perfume, creme])
  const inicio = ok(prepararVendaEstoque([], [compra()], original, operacao('venda-inicial'), produtos,
    original.itens.map((i) => ({ itemId: i.id, quantidade: 1, movimentoId: `entrega-${i.id}` }))))
  const historico = [compra(), ...inicio.movimentos]
  const entrada = { operacao: operacao('troca'), data: '2026-10-19', revisaoVenda: 1, estornoId: 'desfez', vendaId: 'substituta', parcelaIds: ['parcela-nova'],
    devolucoes: [{ itemId: perfume.id, quantidade: 1, movimentoId: 'retorno-perfume' }], novos: [] }
  return { produtos, original, historico, entrada, inicio }
}
test('devolver só perfume conserva creme, sua entrega e custo; financeiro cai de 150 para 50', () => {
  const c = casoTroca(), grupo = ok(prepararTrocaVenda([c.original], c.historico, c.original, c.produtos, c.entrada))
  expect(saldo([c.original, ...grupo.lancamentos])).toBe(5000n)
  expect(grupo.movimentos).toHaveLength(1)
  expect(grupo.movimentos[0]?.tipo).toBe('retorno')
  const substituta = grupo.lancamentos.find((l) => l.tipo === 'venda')
  expect(substituta?.tipo === 'venda' && substituta.itens.map((i) => i.id)).toEqual(['creme-item'])
  expect(ok(prometidoDoProduto([c.original, ...grupo.lancamentos], [...c.historico, ...grupo.movimentos], 'creme'))).toBe(0)
})
test('troca por 120 resulta em 170, repõe perfume e baixa só novo item com custo conhecido', () => {
  const c = casoTroca(), novo = { ...item('novo-item', 1, 12000n), produtoId: 'novo' }
  const grupo = ok(prepararTrocaVenda([c.original], c.historico, c.original, c.produtos, { ...c.entrada,
    novos: [{ item: novo, entregue: 1, movimentoId: 'nova-entrega' }] }))
  expect(saldo([c.original, ...grupo.lancamentos])).toBe(17000n)
  expect(grupo.movimentos.map((m) => m.tipo)).toEqual(['retorno', 'entrega'])
  expect(grupo.movimentos[1]).toMatchObject({ itemId: 'novo-item', custoUnitario: 2500n })
})
test('desconto parcial é inteiro exato e parcelas mantêm vencimentos, com soma igual ao novo total', () => {
  const c = casoTroca(), original = { ...c.original, desconto: 1001n,
    parcelas: [{ id: 'p1', vencimento: '2026-11-01', valor: 7004n }, { id: 'p2', vencimento: '2026-12-01', valor: 6995n }] } as const
  expect(conferirTroca(original, c.entrada.devolucoes, []).desconto).toBe(333n)
  const grupo = ok(prepararTrocaVenda([original], c.historico, original, c.produtos, { ...c.entrada, parcelaIds: ['n1', 'n2'] }))
  const nova = grupo.lancamentos.find((l) => l.tipo === 'venda')
  expect(nova?.tipo === 'venda' && totalDaVenda(nova)).toBe(4667n)
  expect(nova?.tipo === 'venda' && nova.pagamento === 'fiado' && nova.parcelas.map((p) => [p.vencimento, p.valor])).toEqual([
    ['2026-11-01', 2337n], ['2026-12-01', 2330n] ])
})
test('devolução total não cria venda vazia nem recebimento inventado', () => {
  const c = casoTroca(), grupo = ok(prepararTrocaVenda([c.original], c.historico, c.original, c.produtos,
    { ...c.entrada, devolucoes: [...c.entrada.devolucoes, { itemId: 'creme-item', quantidade: 1, movimentoId: 'volta-creme' }] }))
  expect(grupo.lancamentos.map((l) => l.tipo)).toEqual(['estorno'])
  expect(saldo([c.original, ...grupo.lancamentos])).toBe(0n)
})
test('não devolver promessa, repetir retorno, trocar alvo cancelado ou alterar parcela paga', () => {
  const c = casoTroca()
  expect(prepararTrocaVenda([c.original], c.historico, c.original, c.produtos, { ...c.entrada,
    devolucoes: [{ ...c.entrada.devolucoes[0], itemId: 'perfume-item', movimentoId: 'r', quantidade: 2 }] }).ok).toBe(false)
  const pagamento: Lancamento = { tipo: 'recebimento', id: 'rec', clienteId: 'cliente', data: '2026-10-19', valor: 1n, forma: 'pix' }
  expect(prepararTrocaVenda([c.original, pagamento], c.historico, c.original, c.produtos, c.entrada)).toEqual({ ok: false, motivo: 'parcela-paga-alterada' })
  const trocada = ok(prepararTrocaVenda([c.original], c.historico, c.original, c.produtos, c.entrada))
  expect(prepararTrocaVenda([c.original, ...trocada.lancamentos], c.historico, c.original, c.produtos, c.entrada).ok).toBe(false)
})
test('devolução parcial conserva promessa: vendeu 3, entregou 1 e voltou 1 deixa 2 prometidos', () => {
  const v = venda(), h = [compra()], g = ok(prepararVendaEstoque([], h, v, operacao('v'), [produto], [{ itemId: 'item', quantidade: 1, movimentoId: 'entrega' }]))
  const t = ok(prepararTrocaVenda([v], [...h, ...g.movimentos], v, [produto], { ...casoTroca().entrada,
    devolucoes: [{ itemId: 'item', quantidade: 1, movimentoId: 'retorno' }] }))
  expect(ok(prometidoDoProduto([v, ...t.lancamentos], [...h, ...g.movimentos, ...t.movimentos], produto.id))).toBe(2)
})
test('dados locais guardam troca inteira, custo histórico e fila; Q47 não repete cancelamento já aceito', async () => {
  const banco = new BancoLocal('venda-interface', { indexedDB: new IDBFactory(), IDBKeyRange })
  try {
    const repo = criarRepositorioEstoque(banco), ops = criarOperacoesEstoque(repo)
    await banco.clientes.put({ id: 'cliente', nome: 'Fictícia', atualizadoEm: '2026-10-19T12:00:00Z' })
    const cat = ok(await ops.cadastrarCategoria('Produtos')), p = ok(await ops.cadastrarProduto({ nome: 'P', categoriaId: cat.id, custoManual: 2500n }))
    ok(await ops.registrarMovimento({ tipo: 'compra', produtoId: p.id, quantidade: 3, data: '2026-10-19', custoUnitario: 3000n }))
    const g = ok(await ops.lancarVenda({ clienteId: 'cliente', data: '2026-10-19', pagamento: 'fiado', desconto: 0n,
      itens: [{ descricao: 'P', produtoId: p.id, quantidade: 3, precoUnitario: 5000n, entregue: 1 }], parcelas: [{ vencimento: '2026-11-01', valor: 15000n }] }))
    const v = g.lancamentos[0]
    if (!v || v.tipo !== 'venda' || !ehVendaEstoque(v) || !v.itens[0]) throw new Error('sem venda')
    ok(await ops.trocarDevolver(v.id, '2026-10-19', [{ itemId: v.itens[0].id, quantidade: 1 }]))
    expect(lerEstoque(await repo.lerEstado(), p.id)).toMatchObject({ fisico: 3, prometido: 2, disponivel: 1 })
    expect((await repo.lerEstado()).movimentos.find((m) => m.tipo === 'entrega')).toMatchObject({ custoUnitario: 3000n })
    const cancelamento = ok(await ops.cancelarVenda((await repo.lerEstado()).lancamentos.find((l) => l.tipo === 'venda' && l.id !== v.id)?.id ?? '', '2026-10-19', []))
    const e = await repo.lerEstado()
    const recuperada = prepararIntencaoRecusada(e, cancelamento, '2026-10-19', {})
    expect(recuperada.ok && recuperada.valor.lancamentos).toEqual([])
    expect(ok(projetarEstoque(e.movimentos, p.id)).fisico).toBe(3)
  } finally { banco.close() }
})
