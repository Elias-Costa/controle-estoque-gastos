import { describe, expect, test } from 'bun:test'
import { somar } from '../src/dominio/dinheiro.ts'
import type { Cliente, Ficha, Parcela, Resultado, SaldoAnterior, VendaFiado } from '../src/dominio/ficha.ts'
import { estornar, novaVendaAVista, novaVendaFiado, novoSaldoAnterior, registrarRecebimento } from '../src/dominio/lancamentos.ts'
import { filtrarEOrdenar, linhasDaFicha, resumir } from '../src/interface/leitura-da-ficha.ts'
import { avisoDeAtraso, descricaoDosItens, linhaDaProxima, quantoDeve } from '../src/interface/palavras-da-ficha.ts'

/**
 * O que a lista e a ficha mostram (E-09, RF-02, RF-10 em versão de lista): tudo derivado da
 * ficha do domínio, com `hoje` fixado. As regras herdadas do protótipo validado em 2026-09-08
 * — parcela paga não vira linha, "N de M" é por compra, busca sem acento — estão provadas aqui
 * para que uma reescrita da tela não as perca em silêncio.
 */

const HOJE = '2026-09-12'

function ok<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) throw new Error(`recusado: ${resultado.motivo}`)
  return resultado.valor
}

function cliente(id: string, nome: string, apelido?: string): Cliente {
  return { id, nome, apelido }
}

function parcela(id: string, vencimento: string, valor: bigint): Parcela {
  return { id, vencimento, valor }
}

function fiado(clienteId: string, id: string, data: string, itens: string[], lista: Parcela[]): VendaFiado {
  const total = somar(lista.map((p) => p.valor))
  const cada = total / BigInt(itens.length)
  return ok(
    novaVendaFiado({
      id,
      clienteId,
      data,
      itens: itens.map((descricao, i) => ({ descricao, preco: i === 0 ? total - cada * BigInt(itens.length - 1) : cada })),
      parcelas: lista,
    }),
  )
}

function anterior(clienteId: string, id: string, data: string, lista: Parcela[]): SaldoAnterior {
  return ok(novoSaldoAnterior({ id, clienteId, data, parcelas: lista }))
}

/** A Cláudia do protótipo: 2×, a primeira vencida há 8 dias. Deve R$ 60,00. */
const CLAUDIA = cliente('c1', 'Cláudia', 'do salão')
const fichaDaClaudia: Ficha = [
  fiado('c1', 'v1', '2026-08-04', ['Shampoo', 'condicionador'], [parcela('p1', '2026-09-04', 3000n), parcela('p2', '2026-10-05', 3000n)]),
]

/** A Dona Rosa: 4×, já pagou a primeira no Pix, a próxima vence daqui a 5 dias. */
const ROSA = cliente('c2', 'Dona Rosa', 'vizinha do 302')
const vendaDaRosa = fiado(
  'c2',
  'v2',
  '2026-08-17',
  ['Creme', 'perfume', 'sabonete'],
  [
    parcela('p3', '2026-08-17', 3000n),
    parcela('p4', '2026-09-17', 3000n),
    parcela('p5', '2026-10-17', 3000n),
    parcela('p6', '2026-11-17', 3000n),
  ],
)
const fichaDaRosa: Ficha = [
  vendaDaRosa,
  ok(registrarRecebimento([vendaDaRosa], { id: 'r1', clienteId: 'c2', data: '2026-09-04', valor: 3000n, forma: 'pix' })).recebimento,
]

describe('resumir — o que a lista mostra de cada ficha', () => {
  test('quem está atrasada: saldo, próxima vencida e há quantos dias', () => {
    const resumo = resumir(CLAUDIA, fichaDaClaudia, HOJE)
    expect(resumo.saldo).toBe(6000n)
    expect(resumo.proxima).toEqual({ restante: 3000n, vencimento: '2026-09-04', vencida: true })
    expect(resumo.diasDeAtraso).toBe(8)
    expect(quantoDeve(resumo.saldo)).toBe('R$ 60,00')
    expect(avisoDeAtraso(resumo.diasDeAtraso)).toBe('atrasada há 8 dias')
    expect(linhaDaProxima(resumo.proxima, resumo.vazia)).toBe('R$ 30,00 venceu em 04/09')
  })

  test('quem está em dia: a próxima é a segunda parcela, sem atraso', () => {
    const resumo = resumir(ROSA, fichaDaRosa, HOJE)
    expect(resumo.saldo).toBe(9000n)
    expect(resumo.proxima).toEqual({ restante: 3000n, vencimento: '2026-09-17', vencida: false })
    expect(resumo.diasDeAtraso).toBe(0)
    expect(linhaDaProxima(resumo.proxima, resumo.vazia)).toBe('Próxima: R$ 30,00 em 17/09')
  })

  test('ficha vazia diz "Não deve nada"; ficha quitada diz "Está tudo pago" (D-044)', () => {
    const vazia = resumir(cliente('c3', 'Marlene'), [], HOJE)
    expect(vazia.saldo).toBe(0n)
    expect(quantoDeve(vazia.saldo)).toBe('em dia')
    expect(linhaDaProxima(vazia.proxima, vazia.vazia)).toBe('Não deve nada')

    const venda = fiado('c3', 'v3', '2026-08-09', ['Hidratante'], [parcela('p7', '2026-09-06', 8000n)])
    const quitada: Ficha = [venda, ok(registrarRecebimento([venda], { id: 'r2', clienteId: 'c3', data: '2026-09-06', valor: 8000n, forma: 'dinheiro' })).recebimento]
    const resumo = resumir(cliente('c3', 'Marlene'), quitada, HOJE)
    expect(resumo.proxima).toBeNull()
    expect(linhaDaProxima(resumo.proxima, resumo.vazia)).toBe('Está tudo pago')
  })

  test('saldo anterior de uma parcela: vence na data combinada, não na data "desde" (RF-07, D-044)', () => {
    const papel: Ficha = [anterior('c4', 's1', '2026-07-01', [parcela('p8', '2026-09-30', 12000n)])]
    const resumo = resumir(cliente('c4', 'Ivone'), papel, HOJE)
    expect(resumo.saldo).toBe(12000n)
    expect(resumo.proxima?.vencida).toBe(false)
    expect(resumo.diasDeAtraso).toBe(0)
  })
})

describe('filtrarEOrdenar — busca sem acento, ordem alfabética (D-044)', () => {
  const resumos = [
    resumir(ROSA, fichaDaRosa, HOJE),
    resumir(CLAUDIA, fichaDaClaudia, HOJE),
    resumir(cliente('c5', 'Ângela'), [], HOJE),
    resumir(cliente('c6', 'beatriz'), [], HOJE),
  ]
  const nomes = (busca: string) => filtrarEOrdenar(resumos, busca).map((r) => r.cliente.nome)

  test('sem busca: todas, em ordem alfabética pt-BR — acento e maiúscula não separam', () => {
    expect(nomes('')).toEqual(['Ângela', 'beatriz', 'Cláudia', 'Dona Rosa'])
  })

  test('"cla" acha "Cláudia"; "salao" acha pelo apelido "do salão"', () => {
    expect(nomes('cla')).toEqual(['Cláudia'])
    expect(nomes('salao')).toEqual(['Cláudia'])
    expect(nomes('  ROSA ')).toEqual(['Dona Rosa'])
  })

  test('sem ninguém: lista vazia, e é a tela que diz "Ninguém com esse nome"', () => {
    expect(nomes('zulmira')).toEqual([])
  })
})

describe('linhasDaFicha — o histórico como o protótipo mostra (RF-02)', () => {
  test('parcelas em aberto e eventos, do mais recente ao mais antigo; parcela paga não vira linha', () => {
    const linhas = linhasDaFicha(fichaDaRosa, HOJE)
    expect(linhas.map((l) => [l.data, l.descricao, l.valor, l.tipo])).toEqual([
      ['2026-11-17', 'Parcela 4 de 4', 3000n, 'a-vencer'],
      ['2026-10-17', 'Parcela 3 de 4', 3000n, 'a-vencer'],
      ['2026-09-17', 'Parcela 2 de 4', 3000n, 'a-vencer'],
      ['2026-09-04', 'Pagou no Pix', 3000n, 'pagamento'],
      ['2026-08-17', 'Creme, perfume e sabonete', 12000n, 'evento'],
    ])
    expect(linhas.every((l) => !l.estornado)).toBe(true)
  })

  test('parcela vencida sai marcada; "Parcela" sem "N de M" quando a compra foi em uma vez', () => {
    const linhas = linhasDaFicha(fichaDaClaudia, HOJE)
    expect(linhas.map((l) => [l.descricao, l.tipo])).toEqual([
      ['Parcela 2 de 2', 'a-vencer'],
      ['Parcela 1 de 2', 'vencida'],
      ['Shampoo e condicionador', 'evento'],
    ])

    const umaVez: Ficha = [fiado('c7', 'v7', '2026-09-01', ['Batom'], [parcela('p9', '2026-10-01', 2500n)])]
    expect(linhasDaFicha(umaVez, HOJE).map((l) => l.descricao)).toEqual(['Parcela', 'Batom'])
  })

  test('venda à vista é compra paga na hora; saldo anterior é "Já devia"; estorno cita o alvo e marca a linha dele', () => {
    const avista = ok(novaVendaAVista({ id: 'a1', clienteId: 'c8', data: '2026-09-10', itens: [{ descricao: 'Perfume', preco: 9900n }], forma: 'pix' }))
    const papel = anterior('c8', 's2', '2026-06-01', [parcela('p10', '2026-09-30', 5000n)])
    const ficha: Ficha = [avista, papel]
    const desfeito = ok(estornar(ficha, { id: 'e1', clienteId: 'c8', data: '2026-09-11', estornaId: 'a1' }))
    const linhas = linhasDaFicha([...ficha, desfeito], HOJE)
    expect(linhas.map((l) => [l.descricao, l.valor, l.estornado])).toEqual([
      ['Parcela', 5000n, false],
      ['Desfez: Perfume · pagou na hora', 9900n, false],
      ['Perfume · pagou na hora', 9900n, true],
      ['Já devia', 5000n, false],
    ])
  })

  test('descrição dos itens como ela escreveu: vírgulas e um "e" no fim', () => {
    expect(descricaoDosItens([{ descricao: 'Creme', preco: 1n }])).toBe('Creme')
    expect(descricaoDosItens([{ descricao: 'Creme', preco: 1n }, { descricao: 'Batom', preco: 1n }])).toBe('Creme e Batom')
    expect(descricaoDosItens([{ descricao: '  ', preco: 1n }, { descricao: '', preco: 1n }])).toBe('Levou 2 coisas')
  })
})
