import { describe, expect, test } from 'bun:test'
import { repartir, somar } from '../src/dominio/dinheiro.ts'
import {
  LIMITE_QUITACAO,
  historico,
  parcelas,
  saldo,
  totalDaVenda,
  type Ficha,
  type Parcela,
  type Recebimento,
  type Resultado,
  type VendaFiado,
} from '../src/dominio/ficha.ts'
import {
  calcularTroco,
  caminhoDeCorrecao,
  considerarPago,
  corrigir,
  estornar,
  novaVendaAVista,
  novaVendaFiado,
  novoCliente,
  novoSaldoAnterior,
  podeConsiderarPago,
  registrarRecebimento,
  renegociarParcelas,
} from '../src/dominio/lancamentos.ts'

/**
 * O que ela lança (E-04): os construtores, o recebimento com troco (RN-03, D-016 — RT-03),
 * "considerar pago" (RN-15, D-031), o estorno (RN-07, RI-03 — RT-05), a correção no lugar
 * (D-013) e a renegociação de parcelas (RN-08, D-012).
 *
 * Os números vêm das respostas dela na sessão de 2026-09-08: deve 47,00 e manda 50,00 →
 * devolve 3,00 na hora; deve 47,03 e dá 47,00 → considera pago.
 */

const VERA = 'cliente-vera'

function ok<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) throw new Error(`recusado: ${resultado.motivo}`)
  return resultado.valor
}

function motivo<T>(resultado: Resultado<T>): string {
  return resultado.ok ? 'ok' : resultado.motivo
}

function em<T>(lista: readonly T[], posicao: number): T {
  const item = lista[posicao]
  if (item === undefined) throw new Error(`não há posição ${posicao} numa lista de ${lista.length}`)
  return item
}

function parcela(id: string, vencimento: string, valor: bigint): Parcela {
  return { id, vencimento, valor }
}

function fiado(id: string, data: string, lista: Parcela[]): VendaFiado {
  const total = somar(lista.map((p) => p.valor))
  return ok(novaVendaFiado({ id, clienteId: VERA, data, itens: [{ descricao: 'perfume', preco: total }], parcelas: lista }))
}

function recebi(ficha: Ficha, id: string, data: string, valor: bigint): Recebimento {
  return ok(registrarRecebimento(ficha, { id, clienteId: VERA, data, valor, forma: 'dinheiro' })).recebimento
}

describe('novoCliente (RF-01)', () => {
  test('só o nome é obrigatório, e fica sem espaços em volta', () => {
    expect(ok(novoCliente({ id: 'c1', nome: '  Vera  ' }))).toEqual({ id: 'c1', nome: 'Vera' })
    expect(motivo(novoCliente({ id: 'c1', nome: '   ' }))).toBe('nome-obrigatorio')
  })

  test('telefone fica como digitado; apelido e observação passam', () => {
    const cliente = ok(novoCliente({ id: 'c1', nome: 'Maria', telefone: '(11) 9 8765-4321', apelido: 'Maria do salão', observacao: 'paga dia 10' }))
    expect(cliente.telefone).toBe('(11) 9 8765-4321')
    expect(cliente.apelido).toBe('Maria do salão')
    expect(cliente.observacao).toBe('paga dia 10')
  })
})

describe('novaVendaFiado, novaVendaAVista, novoSaldoAnterior (RF-03, RF-05, RF-07, D-011)', () => {
  const itens = [
    { descricao: 'perfume', preco: 3990n },
    { descricao: 'batom', preco: 2500n },
  ]

  test('fiado: desconto ausente é zero; as parcelas de repartir fecham o total', () => {
    const total = 6490n
    const lista = repartir(total, 3).map((valor, i) => parcela(`p${i}`, `2026-1${i}-01`, valor))
    const venda = ok(novaVendaFiado({ id: 'v1', clienteId: VERA, data: '2026-09-01', itens, parcelas: lista }))
    expect(venda.desconto).toBe(0n)
    expect(venda.pagamento).toBe('fiado')
    expect(totalDaVenda(venda)).toBe(total)
    expect(venda.parcelas.map((p) => p.valor)).toEqual([2170n, 2160n, 2160n])
  })

  test('fiado com desconto: as parcelas precisam fechar o total com desconto', () => {
    const certo = novaVendaFiado({ id: 'v1', clienteId: VERA, data: '2026-09-01', itens, desconto: 490n, parcelas: [parcela('p1', '2026-10-01', 6000n)] })
    expect(motivo(certo)).toBe('ok')
    const errado = novaVendaFiado({ id: 'v1', clienteId: VERA, data: '2026-09-01', itens, desconto: 490n, parcelas: [parcela('p1', '2026-10-01', 6490n)] })
    expect(motivo(errado)).toBe('parcelas-nao-fecham')
  })

  test('fiado recusa o que validar recusa, com o motivo dela', () => {
    const base = { id: 'v1', clienteId: VERA, data: '2026-09-01', itens, parcelas: [parcela('p1', '2026-10-01', 6490n)] }
    expect(motivo(novaVendaFiado({ ...base, itens: [] }))).toBe('sem-itens')
    expect(motivo(novaVendaFiado({ ...base, parcelas: [] }))).toBe('sem-parcelas')
    expect(motivo(novaVendaFiado({ ...base, data: 'ontem' }))).toBe('data-invalida')
    expect(motivo(novaVendaFiado({ ...base, parcelas: [parcela('v1', '2026-10-01', 6490n)] }))).toBe('id-repetido')
  })

  test('à vista: um lançamento só, com a forma, e sem parcela (RN-04, D-039)', () => {
    const venda = ok(novaVendaAVista({ id: 'a1', clienteId: VERA, data: '2026-09-01', itens, forma: 'pix' }))
    expect(venda.pagamento).toBe('avista')
    expect(venda.forma).toBe('pix')
    expect(totalDaVenda(venda)).toBe(6490n)
    expect(saldo([venda])).toBe(0n)
    expect(parcelas([venda])).toEqual([])
    expect(motivo(novaVendaAVista({ id: 'a1', clienteId: VERA, data: '2026-09-01', itens, desconto: 7000n, forma: 'pix' }))).toBe('desconto-invalido')
  })

  test('saldo anterior: parcelas obrigatórias, sem itens, distinguível pelo tipo', () => {
    const papel = ok(novoSaldoAnterior({ id: 's1', clienteId: VERA, data: '2026-06-10', parcelas: [parcela('p1', '2026-09-10', 12000n)] }))
    expect(papel.tipo).toBe('saldo-anterior')
    expect(saldo([papel])).toBe(12000n)
    expect(motivo(novoSaldoAnterior({ id: 's1', clienteId: VERA, data: '2026-06-10', parcelas: [] }))).toBe('sem-parcelas')
  })
})

describe('recebimento e troco (RF-06, RN-03, D-016) — RT-03', () => {
  const venda = () => fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 4700n)])

  test('calcularTroco: deve 47,00 e manda 50,00 → registra 47,00, troco 3,00', () => {
    expect(calcularTroco(4700n, 5000n)).toEqual({ registrado: 4700n, troco: 300n })
    expect(calcularTroco(4700n, 4700n)).toEqual({ registrado: 4700n, troco: 0n })
    expect(calcularTroco(4700n, 2000n)).toEqual({ registrado: 2000n, troco: 0n })
  })

  test('acima da dívida: o recebimento gravado é o saldo, o troco é informação, a ficha zera', () => {
    const { recebimento, troco } = ok(registrarRecebimento([venda()], { id: 'r1', clienteId: VERA, data: '2026-09-05', valor: 5000n, forma: 'pix' }))
    expect(recebimento.valor).toBe(4700n)
    expect(troco).toBe(300n)
    expect(saldo([venda(), recebimento])).toBe(0n)
    // O troco não está em lançamento nenhum: a ficha não conhece os R$ 3,00.
    expect(historico([venda(), recebimento]).map((l) => l.valor)).toEqual([4700n, 4700n])
  })

  test('exato e abaixo: sem troco, o valor entra inteiro', () => {
    const exato = ok(registrarRecebimento([venda()], { id: 'r1', clienteId: VERA, data: '2026-09-05', valor: 4700n, forma: 'dinheiro' }))
    expect(exato.troco).toBe(0n)
    expect(exato.recebimento.valor).toBe(4700n)
    const parcial = ok(registrarRecebimento([venda()], { id: 'r1', clienteId: VERA, data: '2026-09-05', valor: 2000n, forma: 'dinheiro' }))
    expect(parcial.troco).toBe(0n)
    expect(saldo([venda(), parcial.recebimento])).toBe(2700n)
  })

  test('sem dívida não há o que receber; valor não positivo não é recebimento', () => {
    expect(motivo(registrarRecebimento([], { id: 'r1', clienteId: VERA, data: '2026-09-05', valor: 1000n, forma: 'pix' }))).toBe('nada-a-receber')
    const paga: Ficha = [venda(), recebi([venda()], 'r1', '2026-09-05', 4700n)]
    expect(motivo(registrarRecebimento(paga, { id: 'r2', clienteId: VERA, data: '2026-09-06', valor: 1000n, forma: 'pix' }))).toBe('nada-a-receber')
    expect(motivo(registrarRecebimento([venda()], { id: 'r1', clienteId: VERA, data: '2026-09-05', valor: 0n, forma: 'pix' }))).toBe('valor-invalido')
    expect(motivo(registrarRecebimento([venda()], { id: 'r1', clienteId: VERA, data: '2026-09-05', valor: -100n, forma: 'pix' }))).toBe('valor-invalido')
  })

  test('a observação e a forma passam para o lançamento', () => {
    const { recebimento } = ok(registrarRecebimento([venda()], { id: 'r1', clienteId: VERA, data: '2026-09-05', valor: 1000n, forma: 'outro', observacao: 'trouxe a filha' }))
    expect(recebimento.forma).toBe('outro')
    expect(recebimento.observacao).toBe('trouxe a filha')
  })
})

describe('considerar pago (RN-15, D-031)', () => {
  test('deve 47,03 e dá 47,00: o botão aparece, o desconto é de R$ 0,03 e a ficha fecha', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 4703n)])
    const r1 = recebi([venda], 'r1', '2026-09-05', 4700n)
    expect(podeConsiderarPago([venda, r1])).toBe(true)
    const desconto = ok(considerarPago([venda, r1], { id: 'q1', clienteId: VERA, data: '2026-09-05' }))
    expect(desconto.tipo).toBe('desconto-quitacao')
    expect(desconto.valor).toBe(3n)
    expect(saldo([venda, r1, desconto])).toBe(0n)
    expect(em(parcelas([venda, r1, desconto]), 0).restante).toBe(0n)
  })

  test('o limite é R$ 0,10, inclusive; acima disso o botão não existe', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 5000n)])
    const noLimite: Ficha = [venda, recebi([venda], 'r1', '2026-09-05', 5000n - LIMITE_QUITACAO)]
    expect(podeConsiderarPago(noLimite)).toBe(true)
    expect(ok(considerarPago(noLimite, { id: 'q1', clienteId: VERA, data: '2026-09-05' })).valor).toBe(10n)
    const acima: Ficha = [venda, recebi([venda], 'r1', '2026-09-05', 5000n - LIMITE_QUITACAO - 1n)]
    expect(podeConsiderarPago(acima)).toBe(false)
    expect(motivo(considerarPago(acima, { id: 'q1', clienteId: VERA, data: '2026-09-05' }))).toBe('acima-do-limite-de-quitacao')
  })

  test('sem dívida não há o que perdoar', () => {
    expect(podeConsiderarPago([])).toBe(false)
    expect(motivo(considerarPago([], { id: 'q1', clienteId: VERA, data: '2026-09-05' }))).toBe('nada-a-quitar')
  })
})

describe('estorno (RF-08, RN-07, RI-03) — RT-05', () => {
  const venda = () => fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 5000n), parcela('p2', '2026-11-01', 5000n)])

  test('estorno de venda: as duas linhas ficam, a dívida some, as parcelas somem', () => {
    const base: Ficha = [venda()]
    const estorno = ok(estornar(base, { id: 'e1', clienteId: VERA, data: '2026-09-02', estornaId: 'v1', motivo: 'era da Maria' }))
    const ficha: Ficha = [...base, estorno]
    expect(ficha).toHaveLength(2)
    expect(saldo(ficha)).toBe(0n)
    expect(parcelas(ficha)).toEqual([])
    expect(historico(ficha).map((l) => [l.lancamento.id, l.estornado])).toEqual([
      ['e1', false],
      ['v1', true],
    ])
    expect(estorno.motivo).toBe('era da Maria')
  })

  test('estorno de recebimento: a dívida volta e a parcela reabre', () => {
    const r1 = recebi([venda()], 'r1', '2026-09-05', 5000n)
    const base: Ficha = [venda(), r1]
    expect(em(parcelas(base), 0).restante).toBe(0n)
    const estorno = ok(estornar(base, { id: 'e1', clienteId: VERA, data: '2026-09-06', estornaId: 'r1' }))
    expect(saldo([...base, estorno])).toBe(10000n)
    expect(em(parcelas([...base, estorno]), 0).restante).toBe(5000n)
  })

  test('estorno de desconto de quitação e de venda à vista também existem', () => {
    const v = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 4703n)])
    const r1 = recebi([v], 'r1', '2026-09-05', 4700n)
    const q1 = ok(considerarPago([v, r1], { id: 'q1', clienteId: VERA, data: '2026-09-05' }))
    const e1 = ok(estornar([v, r1, q1], { id: 'e1', clienteId: VERA, data: '2026-09-06', estornaId: 'q1' }))
    expect(saldo([v, r1, q1, e1])).toBe(3n)

    const a1 = ok(novaVendaAVista({ id: 'a1', clienteId: VERA, data: '2026-09-01', itens: [{ descricao: 'x', preco: 3990n }], forma: 'pix' }))
    const e2 = ok(estornar([a1], { id: 'e2', clienteId: VERA, data: '2026-09-02', estornaId: 'a1' }))
    expect(saldo([a1, e2])).toBe(0n)
    expect(em(historico([a1, e2]), 1).estornado).toBe(true)
  })

  test('um alvo só admite um estorno; estorno não se estorna; alvo precisa existir (D-039)', () => {
    const base: Ficha = [venda()]
    const e1 = ok(estornar(base, { id: 'e1', clienteId: VERA, data: '2026-09-02', estornaId: 'v1' }))
    expect(motivo(estornar([...base, e1], { id: 'e2', clienteId: VERA, data: '2026-09-03', estornaId: 'v1' }))).toBe('ja-estornado')
    expect(motivo(estornar([...base, e1], { id: 'e2', clienteId: VERA, data: '2026-09-03', estornaId: 'e1' }))).toBe('lancamento-e-estorno')
    expect(motivo(estornar(base, { id: 'e2', clienteId: VERA, data: '2026-09-03', estornaId: 'nada' }))).toBe('lancamento-nao-encontrado')
  })

  test('débito já pago não se estorna sozinho: a ficha ficaria negativa; estorna o recebimento antes (D-039)', () => {
    const r1 = recebi([venda()], 'r1', '2026-09-05', 6000n)
    const base: Ficha = [venda(), r1]
    expect(motivo(estornar(base, { id: 'e1', clienteId: VERA, data: '2026-09-06', estornaId: 'v1' }))).toBe('ficha-ficaria-negativa')
    // O caminho registrado: primeiro o recebimento, depois a venda.
    const e1 = ok(estornar(base, { id: 'e1', clienteId: VERA, data: '2026-09-06', estornaId: 'r1' }))
    const e2 = ok(estornar([...base, e1], { id: 'e2', clienteId: VERA, data: '2026-09-06', estornaId: 'v1' }))
    expect(saldo([...base, e1, e2])).toBe(0n)
  })

  test('renegociar depois de sincronizado: lança a venda nova antes de estornar a velha (D-039, para E-10)', () => {
    const r1 = recebi([venda()], 'r1', '2026-09-05', 3000n)
    const base: Ficha = [venda(), r1]
    // Ela quer 3× em vez de 2×. A venda velha já subiu; a correção é estorno + venda nova.
    const nova = fiado('v2', '2026-09-01', [
      parcela('n1', '2026-10-01', 3340n),
      parcela('n2', '2026-11-01', 3330n),
      parcela('n3', '2026-12-01', 3330n),
    ])
    const e1 = ok(estornar([...base, nova], { id: 'e1', clienteId: VERA, data: '2026-09-10', estornaId: 'v1' }))
    const ficha: Ficha = [...base, nova, e1]
    expect(saldo(ficha)).toBe(7000n)
    // Os R$ 30,00 recebidos escorreram para a primeira parcela da venda nova.
    expect(parcelas(ficha).map((p) => [p.parcela.id, p.pago, p.restante])).toEqual([
      ['n1', 3000n, 340n],
      ['n2', 0n, 3330n],
      ['n3', 0n, 3330n],
    ])
  })
})

describe('correção no lugar, só enquanto não sincronizou (RF-08, D-013)', () => {
  const venda = () => fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 5000n), parcela('p2', '2026-11-01', 5000n)])

  test('caminhoDeCorrecao: um verbo só, conforme a fila', () => {
    expect(caminhoDeCorrecao(false)).toBe('corrigir')
    expect(caminhoDeCorrecao(true)).toBe('estornar')
  })

  test('depois de sincronizado, não corrige — nem que a correção fosse válida', () => {
    const v = venda()
    expect(motivo(corrigir([v], { ...v, data: '2026-08-31' }, { sincronizado: true }))).toBe('ja-sincronizado')
    expect(motivo(corrigir([v], { ...v, data: '2026-08-31' }, { sincronizado: false }))).toBe('ok')
  })

  test('corrige a data, os itens e o desconto de uma venda; devolve o substituto', () => {
    const v = venda()
    const corrigida = ok(
      corrigir(
        [v],
        { ...v, data: '2026-08-31', itens: [{ descricao: 'perfume', preco: 8000n }], desconto: 0n, parcelas: [parcela('p1', '2026-10-01', 4000n), parcela('p2', '2026-11-01', 4000n)] },
        { sincronizado: false },
      ),
    )
    expect(corrigida.id).toBe('v1')
    expect(saldo([corrigida])).toBe(8000n)
  })

  test('corrige o valor de um recebimento digitado errado, dentro do saldo', () => {
    const v = venda()
    const r1 = recebi([v], 'r1', '2026-09-05', 500n)
    const corrigido = ok(corrigir([v, r1], { ...r1, valor: 5000n }, { sincronizado: false }))
    expect(saldo([v, corrigido])).toBe(5000n)
    // Corrigir não tem troco: acima do saldo é recusa, e a tela mostra o máximo.
    expect(motivo(corrigir([v, r1], { ...r1, valor: 10001n }, { sincronizado: false }))).toBe('ficha-ficaria-negativa')
  })

  test('recusa: id inexistente, tipo diferente, estorno, outra cliente', () => {
    const v = venda()
    const r1 = recebi([v], 'r1', '2026-09-05', 500n)
    const e1 = ok(estornar([v, r1], { id: 'e1', clienteId: VERA, data: '2026-09-06', estornaId: 'r1' }))
    const ficha: Ficha = [v, r1, e1]
    expect(motivo(corrigir(ficha, { ...r1, id: 'r9' }, { sincronizado: false }))).toBe('lancamento-nao-encontrado')
    expect(motivo(corrigir(ficha, { ...r1, id: 'v1' }, { sincronizado: false }))).toBe('tipo-diferente')
    expect(motivo(corrigir(ficha, { ...e1, motivo: 'outro' }, { sincronizado: false }))).toBe('lancamento-e-estorno')
    expect(motivo(corrigir(ficha, { ...r1, clienteId: 'outra' }, { sincronizado: false }))).toBe('cliente-diferente')
  })

  test('uma venda fiado pode virar à vista e vice-versa, enquanto não sincronizou', () => {
    const v = venda()
    const avista = ok(corrigir([v], { tipo: 'venda', pagamento: 'avista', id: v.id, clienteId: VERA, data: v.data, itens: v.itens, desconto: 0n, forma: 'dinheiro' }, { sincronizado: false }))
    expect(saldo([avista])).toBe(0n)
    const deVolta = ok(corrigir([avista], v, { sincronizado: false }))
    expect(saldo([deVolta])).toBe(10000n)
  })
})

describe('renegociação de parcelas (RN-08, D-012)', () => {
  const venda = () =>
    fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 4000n), parcela('p2', '2026-11-01', 3000n), parcela('p3', '2026-12-01', 3000n)])

  test('mantém a soma igual ao total; o valor dela não precisa ser múltiplo de 5', () => {
    const nova = ok(renegociarParcelas([venda()], 'v1', [parcela('p1', '2026-10-01', 3333n), parcela('p2', '2026-11-01', 3333n), parcela('p3', '2026-12-01', 3334n)], { sincronizado: false }))
    expect(nova.parcelas.map((p) => p.valor)).toEqual([3333n, 3333n, 3334n])
    expect(saldo([nova])).toBe(10000n)
  })

  test('pode mudar a quantidade de parcelas e as datas, desde que a soma feche', () => {
    const nova = ok(renegociarParcelas([venda()], 'v1', [parcela('n1', '2026-10-10', 3000n), parcela('n2', '2027-01-10', 7000n)], { sincronizado: false }))
    expect(nova.parcelas).toHaveLength(2)
    expect(motivo(renegociarParcelas([venda()], 'v1', [parcela('n1', '2026-10-10', 3000n), parcela('n2', '2027-01-10', 6000n)], { sincronizado: false }))).toBe('parcelas-nao-fecham')
    expect(motivo(renegociarParcelas([venda()], 'v1', [], { sincronizado: false }))).toBe('sem-parcelas')
  })

  test('parcela já paga não muda: nem valor, nem data, nem sai da lista', () => {
    const v = venda()
    const r1 = recebi([v], 'r1', '2026-09-05', 4000n)
    const ficha: Ficha = [v, r1]
    const pagaIgual = parcela('p1', '2026-10-01', 4000n)
    expect(motivo(renegociarParcelas(ficha, 'v1', [pagaIgual, parcela('n2', '2026-11-15', 6000n)], { sincronizado: false }))).toBe('ok')
    expect(motivo(renegociarParcelas(ficha, 'v1', [parcela('p1', '2026-10-01', 3000n), parcela('n2', '2026-11-15', 7000n)], { sincronizado: false }))).toBe('parcela-paga-alterada')
    expect(motivo(renegociarParcelas(ficha, 'v1', [parcela('p1', '2026-10-02', 4000n), parcela('n2', '2026-11-15', 6000n)], { sincronizado: false }))).toBe('parcela-paga-alterada')
    expect(motivo(renegociarParcelas(ficha, 'v1', [parcela('n1', '2026-10-01', 4000n), parcela('n2', '2026-11-15', 6000n)], { sincronizado: false }))).toBe('parcela-paga-alterada')
  })

  test('parcela paga em parte pode mudar; o que já foi pago escorre para a seguinte', () => {
    const v = venda()
    const r1 = recebi([v], 'r1', '2026-09-05', 1000n)
    const nova = ok(renegociarParcelas([v, r1], 'v1', [parcela('p1', '2026-10-01', 500n), parcela('n2', '2026-11-15', 9500n)], { sincronizado: false }))
    const ficha: Ficha = [nova, r1]
    expect(parcelas(ficha).map((p) => [p.parcela.id, p.pago, p.restante])).toEqual([
      ['p1', 500n, 0n],
      ['n2', 500n, 9000n],
    ])
    expect(saldo(ficha)).toBe(9000n)
  })

  test('segue a janela de D-013 e só existe para débito', () => {
    const v = venda()
    expect(motivo(renegociarParcelas([v], 'v1', [parcela('n1', '2026-10-10', 10000n)], { sincronizado: true }))).toBe('ja-sincronizado')
    const r1 = recebi([v], 'r1', '2026-09-05', 1000n)
    expect(motivo(renegociarParcelas([v, r1], 'r1', [parcela('n1', '2026-10-10', 10000n)], { sincronizado: false }))).toBe('lancamento-nao-encontrado')
    expect(motivo(renegociarParcelas([v], 'v9', [parcela('n1', '2026-10-10', 10000n)], { sincronizado: false }))).toBe('lancamento-nao-encontrado')
  })

  test('vale para saldo anterior também', () => {
    const papel = ok(novoSaldoAnterior({ id: 's1', clienteId: VERA, data: '2026-06-10', parcelas: [parcela('p1', '2026-09-10', 12000n)] }))
    const nova = ok(renegociarParcelas([papel], 's1', [parcela('n1', '2026-09-10', 6000n), parcela('n2', '2026-10-10', 6000n)], { sincronizado: false }))
    expect(nova.tipo).toBe('saldo-anterior')
    expect(saldo([nova])).toBe(12000n)
  })
})
