import { expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { lerDadosIndicadores } from '../src/dados/leitura-indicadores.ts'
import { criarOperacoesEstoque } from '../src/dados/operacoes-estoque.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { baseConhecida, novaContagem } from '../src/dominio/estoque.ts'
import { saldo, type Lancamento, type VendaAVista } from '../src/dominio/ficha.ts'
import { projetarIndicadores, type DadosIndicadores } from '../src/dominio/indicadores.ts'
import { prepararTrocaVenda } from '../src/dominio/trocas-venda.ts'
import { ehVendaEstoque, prepararCancelamento, prepararCorrecaoVenda, prepararEntrega, prepararRetorno, prepararVendaEstoque,
  type GrupoEstoque, type VendaEstoque } from '../src/dominio/vendas-estoque.ts'
import { lerProdutosNoMinimo } from '../src/interface/produtos-no-minimo.ts'
import { compra, contagem, item, ok, operacao, produto, venda } from './apoio-estoque.ts'

const CLIENTE = { id: 'cliente', nome: 'Cliente de teste' }
const HOJE = '2026-12-20'
const base: DadosIndicadores = { clientes: [CLIENTE], lancamentos: [], movimentos: [], fatosCaixa: [], produtos: [produto], operacoes: [] }

function acrescentar(dados: DadosIndicadores, ...grupos: GrupoEstoque[]): DadosIndicadores {
  return { ...dados, lancamentos: [...dados.lancamentos, ...grupos.flatMap((g) => g.lancamentos)],
    movimentos: [...dados.movimentos, ...grupos.flatMap((g) => g.movimentos)], operacoes: [...dados.operacoes, ...grupos.map((g) => g.operacao)] }
}

function avista(id: string, data: string, valor: bigint): VendaAVista {
  return { tipo: 'venda', pagamento: 'avista', forma: 'pix', id, data, clienteId: CLIENTE.id,
    itens: [{ descricao: 'Avulso antigo', preco: valor }], desconto: 0n }
}

function vender(dados: DadosIndicadores, v: VendaEstoque, entregues: readonly number[]): DadosIndicadores {
  const baixas = v.itens.map((i, pos) => ({ itemId: i.id, quantidade: entregues[pos] ?? 0, movimentoId: `baixa-${i.id}` }))
  return acrescentar(dados, ok(prepararVendaEstoque(dados.lancamentos, dados.movimentos, v, operacao(`op-${v.id}`), dados.produtos, baixas)))
}

test('RF-19 soma o restante das parcelas por ficha, inclusive saldo anterior e desativadas', () => {
  const lancamentos: Lancamento[] = [
    { tipo: 'saldo-anterior', id: 'papel', data: '2026-08-01', clienteId: CLIENTE.id, parcelas: [
      { id: 'p1', vencimento: '2026-10-25', valor: 10000n }, { id: 'p2', vencimento: '2026-11-20', valor: 5000n }] },
    { tipo: 'recebimento', id: 'pix', clienteId: CLIENTE.id, data: '2026-10-26', valor: 3000n, forma: 'pix' },
    { tipo: 'saldo-anterior', id: 'papel-desativada', clienteId: 'desativada', data: '2026-10-01',
      parcelas: [{ id: 'p3', vencimento: '2026-10-22', valor: 2000n }] },
    { tipo: 'saldo-anterior', id: 'liquidado', clienteId: 'quitada', data: '2026-11-01', parcelas: [{ id: 'p4', vencimento: '2026-11-01', valor: 7n }] },
    { tipo: 'desconto-quitacao', id: 'quitacao', clienteId: 'quitada', data: '2026-11-03', valor: 7n },
    avista('a-vista', '2026-11-03', 2000n),
  ]
  const dados = { ...base, clientes: [CLIENTE, { id: 'desativada', nome: CLIENTE.nome, desativadoEm: '2026-11-10' },
    { id: 'quitada', nome: 'Outra cliente' }], lancamentos }
  const esperado = dados.clientes.reduce((total, c) => total + saldo(lancamentos.filter((l) => l.clienteId === c.id)), 0n)
  expect(projetarIndicadores(dados, '2026-11-20').aReceber).toEqual({ total: esperado, devedoras: 2,
    desativadas: 1, saldoDesativadas: 2000n, aVencer: 5000n, vencido: 9000n, faixas: [9000n, 0n, 0n, 0n] })
  expect(esperado).toBe(14000n)
  const estorno = { tipo: 'estorno', id: 'desfeito', estornaId: 'pix', clienteId: CLIENTE.id, data: '2026-11-04' } as const
  expect(projetarIndicadores({ ...dados, lancamentos: [...lancamentos, estorno] }, '2026-11-20').aReceber.total).toBe(17000n)
})

test.each([
  ['2026-08-01', -1], ['2026-08-02', 0], ['2026-08-03', 1],
  ['2026-08-31', 1], ['2026-09-01', 1], ['2026-09-02', 2],
  ['2026-09-30', 2], ['2026-10-01', 2], ['2026-10-02', 3],
  ['2026-10-30', 3], ['2026-10-31', 3], ['2026-11-01', 4],
] as const)('RT-06, vencimento 02/08 e referência %s entram em uma faixa', (hoje, faixa) => {
  const v = venda('v', [item('i', 1, 2500n)])
  const lancamentos = [{ ...v, data: '2026-07-30', parcelas: [{ id: 'parcela', valor: 2500n, vencimento: '2026-08-02' }] }]
  const aReceber = projetarIndicadores({ ...base, lancamentos }, hoje).aReceber
  expect([aReceber.aVencer, ...aReceber.faixas]).toEqual([0, 1, 2, 3, 4].map((i) => i === Math.max(0, faixa) ? 2500n : 0n))
  expect(aReceber.vencido + aReceber.aVencer).toBe(aReceber.total)
})

test('RF-20 atribui entrega posterior e seu custo histórico ao mês da venda', () => {
  const v: VendaEstoque = { ...venda('v', [item('i', 2)]), pagamento: 'fiado', desconto: 1000n,
    parcelas: [{ id: 'p', valor: 9000n, vencimento: '2026-11-01' }] }
  const inicial = vender({ ...base, movimentos: [compra('custo-antigo', 5, 2000n)] }, v, [1])
  expect(projetarIndicadores(inicial, HOJE, '2026-10').lucro).toMatchObject({ vendasApuraveis: 4500n, custoDasEntregas: 2000n, resultado: 2500n, aEntregar: 4500n })
  const outraCompra = { ...compra('novo-custo', 5, 2500n), data: '2026-11-02' }
  const estoque = [...inicial.movimentos, outraCompra]
  const entrega = ok(prepararEntrega(inicial.lancamentos, estoque, v,
    { operacao: operacao('entrega'), id: 'segunda', data: '2026-11-03', itemId: 'i', quantidade: 1 }, produto))
  const dados = acrescentar({ ...inicial, movimentos: estoque, produtos: [{ ...produto, custoManual: 9000n }] }, entrega)
  expect(projetarIndicadores(dados, HOJE, '2026-10').lucro).toMatchObject({ vendasApuraveis: 9000n, custoDasEntregas: 4500n, resultado: 4500n, aEntregar: 0n })
  expect(projetarIndicadores(dados, HOJE, '2026-11').lucro.resultado).toBe(0n)
  expect(projetarIndicadores(dados, HOJE, '2026-11').vendas.consultado.temAnotacoes).toBe(false)
})

test('D-090 registra cancelamento sem retorno e reverte só o custo no retorno tardio', () => {
  const v = venda('v', [item('i', 1, 4500n)])
  const inicial = vender({ ...base, movimentos: [compra('c', 2, 2000n)] }, v, [1])
  const cancelamento = ok(prepararCancelamento(inicial.lancamentos, inicial.movimentos, v, { operacao: operacao('cancelamento'),
    estornoId: 'e', data: '2026-11-03', revisaoVenda: 1, retornos: [{ itemId: 'i', quantidade: 0, movimentoId: 'm' }] }))
  const cancelada = acrescentar(inicial, cancelamento)
  const retorno = ok(prepararRetorno(cancelada.lancamentos, cancelada.movimentos, v, { operacao: operacao('retorno'),
    data: '2026-12-06', retornos: [{ itemId: 'i', quantidade: 1, movimentoId: 'r' }] }))
  const dados = acrescentar(cancelada, retorno)
  expect(projetarIndicadores(dados, HOJE, '2026-10').lucro.resultado).toBe(2500n)
  const novembro = projetarIndicadores(dados, HOJE, '2026-11')
  expect(novembro.vendas.consultado.valor).toBe(-4500n)
  expect(novembro.lucro).toMatchObject({ devolucoesApuraveis: 4500n, custoDosRetornos: 0n, resultado: -4500n })
  const dezembro = projetarIndicadores(dados, HOJE)
  expect(dezembro.vendas.consultado.temAnotacoes).toBe(false)
  expect(dezembro.lucro).toMatchObject({ devolucoesApuraveis: 0n, custoDosRetornos: 2000n, resultado: 2000n })
  expect(dezembro.aReceber.total).toBe(0n)
})

test('cancelar promessa retira a pendência e conserva venda e cancelamento cada qual no seu mês', () => {
  const v = venda('v', [item('i', 2)])
  const inicial = vender(base, v, [])
  const cancelamento = ok(prepararCancelamento(inicial.lancamentos, inicial.movimentos, v, { operacao: operacao('cancelar'),
    estornoId: 'e', data: '2026-11-03', revisaoVenda: 1, retornos: [] }))
  const dados = acrescentar(inicial, cancelamento)
  expect(projetarIndicadores(dados, HOJE, '2026-10').lucro).toMatchObject({ resultado: 0n, aEntregar: 0n, canceladosSemEntrega: 10000n })
  expect(projetarIndicadores(dados, HOJE, '2026-11').vendas.consultado.valor).toBe(-10000n)
})

test('RF-20/21 e D-090 preservam devolução parcial e data de cada item na correção da substituta', () => {
  const v = venda('v', [item('mantido', 2, 4500n)])
  const inicial = vender({ ...base, movimentos: [compra('c', 6, 2000n)] }, v, [2])
  const troca = ok(prepararTrocaVenda(inicial.lancamentos, inicial.movimentos, v, [produto], {
    operacao: operacao('op-troca'), estornoId: 'e-1', vendaId: 'sub', data: '2026-11-02', revisaoVenda: 1,
    devolucoes: [{ itemId: 'mantido', quantidade: 1, movimentoId: 'r' }], parcelaIds: ['sub-p'],
    novos: [{ item: item('novo', 1, 5500n), entregue: 1, movimentoId: 'nova-baixa' }],
  }))
  const trocada = acrescentar(inicial, troca)
  expect(projetarIndicadores(trocada, HOJE, '2026-10').lucro.resultado).toBe(5000n)
  expect(projetarIndicadores(trocada, HOJE, '2026-11').lucro).toMatchObject({ vendasApuraveis: 5500n,
    devolucoesApuraveis: 4500n, custoDasEntregas: 2000n, custoDosRetornos: 2000n, resultado: 1000n })
  expect(projetarIndicadores(trocada, HOJE, '2026-11').vendas.consultado.valor).toBe(1000n)
  const substituta = troca.lancamentos.find((l) => l.tipo === 'venda')
  if (!substituta || !ehVendaEstoque(substituta)) throw new Error('Venda substituta ausente')
  const corrigida = { ...venda('corrigida', [item('mantido', 1, 4600n), item('novo', 1, 5700n)]), data: v.data }
  const grupo = ok(prepararCorrecaoVenda(trocada.lancamentos, trocada.movimentos, substituta, corrigida,
    { operacao: operacao('op-correcao'), revisaoOriginal: 1, sincronizado: true, estornoId: 'e-2', data: '2026-12-02', natureza: 'financeira' }))
  const dados = acrescentar(trocada, grupo)
  expect(projetarIndicadores(dados, HOJE, '2026-10').vendas.consultado.valor).toBe(9100n)
  expect(projetarIndicadores(dados, HOJE, '2026-11').vendas.consultado.valor).toBe(1200n)
  expect(projetarIndicadores(dados, HOJE, '2026-10').lucro.resultado).toBe(5100n)
  expect(projetarIndicadores(dados, HOJE, '2026-11').lucro.resultado).toBe(1200n)
  expect(projetarIndicadores(dados, HOJE).vendas.consultado.temAnotacoes).toBe(false)
})

test('D-087 reverte a venda e o custo em devolução simultânea; custo incerto de retorno parcial é sinalizado', () => {
  const v = venda('v', [item('i', 2, 4500n)])
  const inicial = vender({ ...base, movimentos: [compra('c', 4, 2000n)] }, v, [1])
  const outraCompra = { ...compra('outro-custo', 2, 2500n), data: '2026-10-09' }
  const historico = [...inicial.movimentos, outraCompra]
  const outraEntrega = ok(prepararEntrega(inicial.lancamentos, historico, v,
    { operacao: operacao('outra'), id: 'segunda', data: '2026-10-10', itemId: 'i', quantidade: 1 }, produto))
  const entregue = acrescentar({ ...inicial, movimentos: historico }, outraEntrega)
  for (const quantidade of [1, 2]) {
    const troca = ok(prepararTrocaVenda(entregue.lancamentos, entregue.movimentos, v, [produto], {
      operacao: operacao('op-troca'), estornoId: 'e', vendaId: 'sub', data: '2026-11-01', revisaoVenda: 1,
      devolucoes: [{ itemId: 'i', quantidade, movimentoId: 'r' }], parcelaIds: ['sub-p'], novos: [],
    }))
    const dados = acrescentar(entregue, troca)
    expect(projetarIndicadores(dados, HOJE, '2026-10').lucro.resultado).toBe(4500n)
    const novembro = projetarIndicadores(dados, HOJE, '2026-11')
    expect(novembro.lucro).toMatchObject({ devolucoesApuraveis: 4500n * BigInt(quantidade),
      custoDosRetornos: quantidade === 1 ? 0n : 4500n, retornosSemCusto: quantidade === 1 ? ['r'] : [] })
    expect(novembro.vendas.consultado.valor).toBe(-4500n * BigInt(quantidade))
  }
})

test('D-059/087 conserva o desconto de um centavo em trocas sucessivas e concilia com a venda vigente', () => {
  const v = { ...avista('v', '2026-10-02', 1n), desconto: 1n, itens: [item('a', 1), item('b', 1)] }
  const inicial = vender({ ...base, movimentos: [compra('c', 5, 2500n)] }, v, [1, 1])
  const troca = ok(prepararTrocaVenda(inicial.lancamentos, inicial.movimentos, v, [produto], {
    operacao: operacao('troca'), estornoId: 'e1', vendaId: 's1', data: '2026-11-03', revisaoVenda: 1,
    devolucoes: [{ itemId: 'b', quantidade: 1, movimentoId: 'r1' }], novos: [], parcelaIds: [],
  }))
  const anterior = troca.lancamentos.find((l) => l.tipo === 'venda')
  if (!anterior || !ehVendaEstoque(anterior)) throw new Error('Venda substituta ausente')
  const primeiraTroca = acrescentar(inicial, troca)
  const ultima = ok(prepararTrocaVenda(primeiraTroca.lancamentos, primeiraTroca.movimentos, anterior, [produto], {
    operacao: operacao('outra-troca'), estornoId: 'e2', vendaId: 's2', data: '2026-12-03', revisaoVenda: 1,
    devolucoes: [{ itemId: 'a', quantidade: 1, movimentoId: 'r2' }], novos: [], parcelaIds: [],
  }))
  const dados = acrescentar(primeiraTroca, ultima)
  const meses = ['2026-10', '2026-11', '2026-12'].map((mes) => projetarIndicadores(dados, HOJE, mes))
  expect(meses.map((resumo) => resumo.vendas.consultado.valor)).toEqual([9999n, -4999n, -5000n])
  expect(meses.map((resumo) => resumo.lucro.resultado)).toEqual([4999n, -2499n, -2500n])
})

test('devolução inteira reverte a margem conhecida mesmo quando uma das baixas não tinha custo', () => {
  const v = venda('v', [item('i', 2, 4500n)])
  const inicial = vender({ ...base, movimentos: [compra('c', 2, 2000n)] }, v, [1])
  const outraCompra = { ...compra('sem-custo', 2), custoUnitario: undefined, data: '2026-10-09' }
  const historico = [...inicial.movimentos, outraCompra]
  const segunda = ok(prepararEntrega(inicial.lancamentos, historico, v,
    { operacao: operacao('entrega2'), id: 'm2', data: '2026-10-10', itemId: 'i', quantidade: 1 }, produto))
  const entregue = acrescentar({ ...inicial, movimentos: historico }, segunda)
  const troca = ok(prepararTrocaVenda(entregue.lancamentos, entregue.movimentos, v, [produto], {
    operacao: operacao('troca'), estornoId: 'e', vendaId: 'sub', data: '2026-11-02', revisaoVenda: 1,
    devolucoes: [{ itemId: 'i', quantidade: 2, movimentoId: 'r' }], novos: [], parcelaIds: [],
  }))
  const dados = acrescentar(entregue, troca)
  expect(projetarIndicadores(dados, HOJE, '2026-10').lucro).toMatchObject({ resultado: 2500n, semCusto: 4500n })
  expect(projetarIndicadores(dados, HOJE, '2026-11').lucro).toMatchObject({ resultado: -2500n, custoDosRetornos: 2000n,
    devolucoesApuraveis: 4500n, semCusto: -4500n, retornosSemCusto: ['r'] })
})

test('correção financeira de venda reexpressa o fato e usa somente a baixa vigente', () => {
  const v = venda('v', [item('i', 1, 4500n)])
  const inicial = vender({ ...base, movimentos: [compra('c', 2, 2000n)] }, v, [1])
  const corrigida = { ...venda('corrigida', [item('i', 1, 6500n)]), data: '2026-09-29' }
  const correcao = ok(prepararCorrecaoVenda(inicial.lancamentos, inicial.movimentos, v, corrigida,
    { operacao: operacao('corrigir'), revisaoOriginal: 1, sincronizado: true, estornoId: 'e', data: '2026-12-01', natureza: 'financeira' }))
  const dados = acrescentar(inicial, correcao)
  expect(projetarIndicadores(dados, HOJE, '2026-09').lucro).toMatchObject({ vendasApuraveis: 6500n, custoDasEntregas: 2000n, resultado: 4500n })
  expect(projetarIndicadores(dados, HOJE, '2026-10').vendas.consultado.temAnotacoes).toBe(false)
  expect(projetarIndicadores(dados, HOJE).vendas.consultado.temAnotacoes).toBe(false)
})

test('D-090 exclui da margem a entrega concorrente acima da venda e conserva as baixas no estoque', () => {
  const v = venda('v', [item('i', 1)])
  const dados = vender({ ...base, produtos: [{ ...produto, estoqueMinimo: 10 }], movimentos: [compra('c', 4, 2000n)] }, v, [])
  const grupo = ok(prepararEntrega(dados.lancamentos, dados.movimentos, v,
    { operacao: operacao('offline-a'), id: 'a', data: v.data, itemId: 'i', quantidade: 1 }, produto))
  const concorrente = { ...grupo, operacao: { ...grupo.operacao, id: 'offline-b', movimentos: [{ id: 'b', revisao: 1 }] },
    movimentos: grupo.movimentos.map((m) => ({ ...m, id: 'b', operacaoId: 'offline-b', custoUnitario: 3000n })) }
  const leitura = projetarIndicadores(acrescentar(dados, grupo, concorrente), HOJE, '2026-10')
  expect(leitura.lucro).toMatchObject({ resultado: 0n, entregasAConferir: ['i'] })
  expect(leitura.vendas.consultado.valor).toBe(5000n)
  expect(leitura.estoque.repor[0]).toMatchObject({ fisico: 2, prometido: 0, disponivel: 2 })
})

test('RN-10/11/15 conserva o centavo em venda mista, custo zero, quitação e caixa de negócio', () => {
  const valor = 9_007_199_254_741_005n
  const outro = { ...produto, id: 'sem-custo', custoManual: undefined }
  const v = { ...avista('mista', '2026-10-02', valor), desconto: 1n, itens: [
    item('com-custo', 1, valor), { ...item('sem-custo', 1, valor), produtoId: outro.id },
    { ...item('avulso', 1, valor), produtoId: undefined },
  ] }
  const inicial = vender({ ...base, produtos: [{ ...produto, custoManual: 0n }, outro] }, v, [1, 1, 0])
  const lancamentos: Lancamento[] = [...inicial.lancamentos,
    { tipo: 'saldo-anterior', id: 'resto', clienteId: CLIENTE.id, data: '2026-10-07', parcelas: [{ id: 'r', vencimento: '2026-10-11', valor: 7n }] },
    { tipo: 'desconto-quitacao', id: 'q', clienteId: CLIENTE.id, data: '2026-10-12', valor: 7n }]
  const despesa = { tipo: 'despesa', id: 'antiga', revisao: 1, valor, mercadoria: false, classificacao: 'negocio',
    categoria: 'Teste', data: '2026-10-10' } as const
  const dados: DadosIndicadores = { ...inicial, lancamentos, fatosCaixa: [despesa,
    { tipo: 'estorno', id: 'estorno-gasto', revisao: 1, alvo: { id: despesa.id, revisao: 1 }, data: '2026-11-01' },
    { ...despesa, id: 'corrigida', valor: valor + 15n }, { ...despesa, id: 'mercadoria', mercadoria: true },
    { ...despesa, id: 'pessoal', classificacao: 'pessoal' }] }
  const outubro = projetarIndicadores(dados, HOJE, '2026-10')
  expect(outubro.lucro).toMatchObject({ vendasApuraveis: valor - 1n, custoDasEntregas: 0n, semCusto: valor, avulsos: valor,
    itensSemCusto: ['sem-custo'], despesas: valor + 15n, descontosQuitacao: 7n, resultado: -23n })
  expect(outubro.vendas.consultado.valor).toBe(3n * valor - 1n)
})

test('RF-21 compara o mesmo corte, inclui fevereiro bissexto, distingue ausência e reexpressa estorno legado', () => {
  const v = { ...venda('fiado', [item('i', 1)]), data: '2024-03-10', desconto: 500n,
    parcelas: [{ id: 'p', valor: 4500n, vencimento: '2024-04-01' }] }
  const lancamentos: Lancamento[] = [v, avista('avista', '2024-03-01', 2000n), avista('fevereiro', '2024-02-29', 1500n),
    avista('futura', '2024-03-31', 6000n), avista('legada', '2024-02-03', 1000n),
    { tipo: 'estorno', id: 'e', data: '2024-03-01', estornaId: 'legada', clienteId: CLIENTE.id },
    { tipo: 'recebimento', id: 'pix', forma: 'pix', valor: 100n, data: '2024-03-12', clienteId: CLIENTE.id }]
  const dados = { ...base, lancamentos }
  const agora = projetarIndicadores(dados, '2024-03-30').vendas
  expect(agora.consultado).toMatchObject({ valor: 6500n, fim: '2024-03-30', temAnotacoes: true })
  expect(agora.anterior).toMatchObject({ valor: 1500n, fim: '2024-02-29', temAnotacoes: true })
  expect(agora.diaria).toHaveLength(30)
  expect(agora.mensal).toHaveLength(12)
  expect(agora.mensal[0]).toMatchObject({ mes: '2023-04', valor: 0n, temAnotacoes: false })
  expect(agora.mensal.at(-1)).toMatchObject({ mes: '2024-03', valor: 6500n })
  const fechado = projetarIndicadores(dados, '2024-04-04', '2024-03').vendas
  expect(fechado.consultado).toMatchObject({ valor: 12500n, fim: '2024-03-31' })
  expect(fechado.anterior.fim).toBe('2024-02-29')
  expect(projetarIndicadores(dados, '2024-01-01').vendas.anterior).toEqual({ inicio: '2023-12-01', fim: '2023-12-01', valor: 0n, temAnotacoes: false })
})

test('RF-22 coincide com RF-15 em mínimo vazio/zero, promessa total e contagem a conferir', () => {
  const c = compra('c', 2)
  const movimentos = [c, contagem([c], 'a', 1), contagem([c], 'b', 1)]
  const produtos = [{ ...produto, estoqueMinimo: 0 }, { ...produto, id: 'vazio' }]
  const dados = { ...base, movimentos, produtos, lancamentos: [venda('v', [item('i', 2)])] }
  const leitura = projetarIndicadores(dados, HOJE).estoque
  const minimo = lerProdutosNoMinimo({ ...dados, clientes: [CLIENTE.id], fila: [], grupos: [], carimbo: 0n })
  expect(leitura.repor).toEqual(minimo)
  expect(leitura.repor[0]).toMatchObject({ fisico: 2, prometido: 2, disponivel: 0, contagensAfetadas: true })
  expect(leitura.encalhados).toEqual([])
  const semPromessa = projetarIndicadores({ ...dados, lancamentos: [] }, HOJE).estoque
  expect(semPromessa.semData[0]).toMatchObject({ produto: { id: produto.id }, contagensAfetadas: true })
})

test('RF-22 observa 90/91 dias, reposição após faltar, conferência contínua e entrega recente', () => {
  const primeira = { ...compra('primeira', 1), data: '2026-08-01' }
  const dados = { ...base, movimentos: [primeira] }
  expect(projetarIndicadores(dados, '2026-10-30').estoque.encalhados).toHaveLength(0)
  expect(projetarIndicadores(dados, '2026-10-31').estoque.encalhados[0]).toMatchObject({ desde: '2026-08-01', dias: 91 })
  expect(projetarIndicadores(dados, '2026-08-03', '2026-08', 1).estoque.encalhados[0]?.dias).toBe(2)
  const v = venda('v', [item('i', 1)])
  const consumida = vender(dados, v, [1])
  const reposicao = { ...compra('reposicao', 2), data: '2026-10-08', conhecidos: baseConhecida(consumida.movimentos, produto.id) }
  const reposta = [...consumida.movimentos, reposicao]
  const conferencia = ok(novaContagem(reposta, { id: 'conferencia', operacaoId: 'op-conferencia', revisao: 1, produtoId: produto.id,
    data: '2026-11-02', motivo: 'conferencia', totalContado: 3 }))
  const historico = { ...consumida, movimentos: [...reposta, conferencia] }
  expect(projetarIndicadores(historico, '2027-01-07').estoque.encalhados[0]).toMatchObject({ desde: '2026-10-08', dias: 91 })
  const outraVenda = { ...venda('outra', [item('outra-linha', 1)]), data: '2026-12-01' }
  expect(projetarIndicadores(vender(historico, outraVenda, [1]), '2027-01-07').estoque.encalhados).toHaveLength(0)
})

test('leitura local em duas conexões reúne os efeitos da venda e o manifesto, com a fila preservada', async () => {
  const opcoes = { indexedDB: new IDBFactory(), IDBKeyRange }
  const banco = new BancoLocal('indicadores-e41', opcoes), outro = new BancoLocal('indicadores-e41', opcoes)
  try {
    const repo = criarRepositorioEstoque(banco)
    const ops = criarOperacoesEstoque(repo)
    const categoria = ok(await ops.cadastrarCategoria('Perfumes'))
    const p = ok(await ops.cadastrarProduto({ nome: 'Perfume', categoriaId: categoria.id, estoqueMinimo: 0, custoManual: 2500n }))
    await banco.clientes.put({ ...CLIENTE, atualizadoEm: '2026-10-10T10:00:00Z' })
    ok(await ops.registrarMovimento({ tipo: 'compra', produtoId: p.id, quantidade: 1, custoUnitario: 2500n, data: '2026-10-01' }))
    await outro.open()
    const escrita = ops.lancarVenda({ clienteId: CLIENTE.id, data: '2026-10-02', desconto: 0n, pagamento: 'fiado',
      parcelas: [{ vencimento: '2026-11-02', valor: 5000n }], itens: [{ descricao: p.nome, produtoId: p.id, quantidade: 1, entregue: 1, precoUnitario: 5000n }] })
    const simultanea = await lerDadosIndicadores(outro)
    const grupo = ok(await escrita)
    const completa = await lerDadosIndicadores(outro)
    const vendaVisivel = simultanea.lancamentos.length
    expect(simultanea.movimentos.filter((m) => m.tipo === 'entrega')).toHaveLength(vendaVisivel)
    expect(simultanea.operacoes.filter((op) => op.tipo === 'venda')).toHaveLength(vendaVisivel)
    const fila = await banco.fila.toArray()
    const leitura = projetarIndicadores(completa, HOJE, '2026-10')
    expect(leitura.aReceber.total).toBe(5000n)
    expect(leitura.lucro.resultado).toBe(2500n)
    expect(leitura.estoque.repor[0]).toMatchObject({ disponivel: 0 })
    expect(await banco.fila.toArray()).toEqual(fila)
    expect(await lerDadosIndicadores(outro)).toEqual(completa)

    const v = grupo.lancamentos.find((l) => l.tipo === 'venda')
    if (!v || !ehVendaEstoque(v) || v.pagamento !== 'fiado') throw new Error('Venda fiado ausente')
    const envioInicial = await repo.capturarEnvio(grupo.operacao.id)
    if (!envioInicial) throw new Error('Envio inicial ausente')
    ok(await ops.corrigirVenda(v.id, { ...v, parcelas: v.parcelas.map((p) => ({ ...p, valor: 4800n })),
      itens: v.itens.map((i) => ({ ...i, entregue: 1, precoUnitario: 4800n })) }, { natureza: 'financeira', data: '2026-10-03' }))
    await repo.responderEnvio(envioInicial)
    const envioNovo = await repo.capturarEnvio(grupo.operacao.id)
    if (!envioNovo) throw new Error('Envio revisado ausente')
    await repo.responderEnvio(envioNovo, { codigo: '23000', mensagem: 'Versão divergente', em: '2026-10-04T12:00:00Z' })
    expect(projetarIndicadores(await lerDadosIndicadores(outro), HOJE, '2026-10').vendas.consultado.valor).toBe(4800n)
    ok(await repo.encerrar(envioNovo.versao.id, { data: '2026-10-04', confirmado: true, intencaoPendente: false }))
    const aposEncerrar = projetarIndicadores(await lerDadosIndicadores(outro), HOJE, '2026-10')
    expect(aposEncerrar.aReceber.total).toBe(5000n)
    expect(aposEncerrar.vendas.consultado.valor).toBe(5000n)
    expect(aposEncerrar.lucro.custoDasEntregas).toBe(2500n)
    expect(await banco.encerramentos.count()).toBe(1)
  } finally {
    outro.close()
    banco.close()
  }
})
