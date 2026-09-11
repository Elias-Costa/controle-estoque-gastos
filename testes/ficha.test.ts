import { describe, expect, test } from 'bun:test'
import { emReais, repartir, somar } from '../src/dominio/dinheiro.ts'
import {
  ehDebito,
  historico,
  parcelas,
  proximaParcela,
  saldo,
  situacaoDaParcela,
  totalDaVenda,
  validar,
  type Estorno,
  type Ficha,
  type Lancamento,
  type Parcela,
  type Recebimento,
  type Resultado,
  type SaldoAnterior,
  type VendaAVista,
  type VendaFiado,
} from '../src/dominio/ficha.ts'
import {
  considerarPago,
  estornar,
  novaVendaAVista,
  novaVendaFiado,
  novoSaldoAnterior,
  podeConsiderarPago,
  registrarRecebimento,
  renegociarParcelas,
} from '../src/dominio/lancamentos.ts'

/**
 * A ficha, lado da leitura (E-04): RN-01 (saldo derivado), RN-02 (abatimento na parcela mais
 * antiga — RT-02), RF-02 (próxima parcela, situação, histórico) e as invariantes de `validar`.
 *
 * No fim, a prova de EL-02 (RT-04): fichas construídas ao acaso, pelas operações reais e
 * inclusive por estornos, com o saldo derivado comparado a **duas** somas independentes
 * escritas de outro jeito — uma que soma pelos itens e pula o que foi estornado, outra que
 * trata o estorno como lançamento inverso (RN-07) e não pula nada. Divergência falha o teste
 * e imprime a semente.
 */

const VERA = 'cliente-vera'

/** Desembrulha um resultado que precisa ter sido aceito. Falha com o motivo se não foi. */
function ok<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) throw new Error(`recusado: ${resultado.motivo}`)
  return resultado.valor
}

/** Elemento numa posição que precisa existir — `noUncheckedIndexedAccess` não deixa presumir. */
function em<T>(lista: readonly T[], posicao: number): T {
  const item = lista[posicao]
  if (item === undefined) throw new Error(`não há posição ${posicao} numa lista de ${lista.length}`)
  return item
}

function parcela(id: string, vencimento: string, valor: bigint): Parcela {
  return { id, vencimento, valor }
}

/** Venda fiado com um item só, no valor da soma das parcelas. */
function fiado(id: string, data: string, lista: Parcela[]): VendaFiado {
  const total = somar(lista.map((p) => p.valor))
  return ok(novaVendaFiado({ id, clienteId: VERA, data, itens: [{ descricao: 'perfume', preco: total }], parcelas: lista }))
}

function avista(id: string, data: string, preco: bigint): VendaAVista {
  return ok(novaVendaAVista({ id, clienteId: VERA, data, itens: [{ descricao: 'batom', preco }], forma: 'pix' }))
}

function anterior(id: string, data: string, lista: Parcela[]): SaldoAnterior {
  return ok(novoSaldoAnterior({ id, clienteId: VERA, data, parcelas: lista }))
}

function recebi(ficha: Ficha, id: string, data: string, valor: bigint): Recebimento {
  return ok(registrarRecebimento(ficha, { id, clienteId: VERA, data, valor, forma: 'dinheiro' })).recebimento
}

function estorno(ficha: Ficha, id: string, data: string, estornaId: string): Estorno {
  return ok(estornar(ficha, { id, clienteId: VERA, data, estornaId }))
}

describe('saldo — derivado dos lançamentos, nunca guardado (RN-01)', () => {
  test('ficha vazia não deve nada', () => {
    expect(saldo([])).toBe(0n)
  })

  test('venda fiado é a dívida inteira, pelas parcelas combinadas', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 4000n), parcela('p2', '2026-11-01', 3000n), parcela('p3', '2026-12-01', 3000n)])
    expect(saldo([venda])).toBe(10000n)
    expect(totalDaVenda(venda)).toBe(10000n)
  })

  test('recebimento abate; o resultado é bigint', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 10000n)])
    const ficha: Ficha = [venda, recebi([venda], 'r1', '2026-09-05', 3000n)]
    expect(saldo(ficha)).toBe(7000n)
    expect(typeof saldo(ficha)).toBe('bigint')
  })

  test('venda à vista não entra no saldo: nasce paga (RN-04, D-039)', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 5000n)])
    expect(saldo([venda, avista('a1', '2026-09-02', 3990n)])).toBe(5000n)
    expect(saldo([avista('a1', '2026-09-02', 3990n)])).toBe(0n)
  })

  test('saldo anterior é dívida como qualquer fiado (RF-07)', () => {
    const papel = anterior('s1', '2026-08-01', [parcela('p1', '2026-09-01', 12000n)])
    expect(saldo([papel])).toBe(12000n)
  })

  test('desconto de quitação abate como recebimento (RN-15)', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 4703n)])
    const ficha: Ficha = [venda, recebi([venda], 'r1', '2026-09-05', 4700n)]
    const desconto = ok(considerarPago(ficha, { id: 'q1', clienteId: VERA, data: '2026-09-05' }))
    expect(desconto.valor).toBe(3n)
    expect(saldo([...ficha, desconto])).toBe(0n)
  })

  test('estorno de venda tira a dívida; estorno de recebimento devolve (RN-07)', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 10000n)])
    const outra = fiado('v2', '2026-09-02', [parcela('p2', '2026-10-02', 5000n)])
    const r1 = recebi([venda, outra], 'r1', '2026-09-05', 3000n)
    const base: Ficha = [venda, outra, r1]
    expect(saldo(base)).toBe(12000n)
    expect(saldo([...base, estorno(base, 'e1', '2026-09-06', 'v2')])).toBe(7000n)
    expect(saldo([...base, estorno(base, 'e2', '2026-09-06', 'r1')])).toBe(15000n)
  })
})

describe('parcelas — abate a mais antiga, o excedente escorre (RN-02, D-006) — RT-02', () => {
  const duas = () => fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 5000n), parcela('p2', '2026-11-01', 5000n)])

  test('parcial: 30 sobre [50, 50] deixa 20 na primeira e a segunda intacta', () => {
    const venda = duas()
    const lista = parcelas([venda, recebi([venda], 'r1', '2026-09-05', 3000n)])
    expect(lista.map((p) => [p.parcela.id, p.pago, p.restante])).toEqual([
      ['p1', 3000n, 2000n],
      ['p2', 0n, 5000n],
    ])
  })

  test('exato: 50 quita a primeira e não toca a segunda', () => {
    const venda = duas()
    const lista = parcelas([venda, recebi([venda], 'r1', '2026-09-05', 5000n)])
    expect(lista.map((p) => [p.pago, p.restante])).toEqual([
      [5000n, 0n],
      [0n, 5000n],
    ])
  })

  test('atravessa várias: 120 sobre [50, 50, 50] quita duas e deixa 30 na terceira', () => {
    const venda = fiado('v1', '2026-09-01', [
      parcela('p1', '2026-10-01', 5000n),
      parcela('p2', '2026-11-01', 5000n),
      parcela('p3', '2026-12-01', 5000n),
    ])
    const lista = parcelas([venda, recebi([venda], 'r1', '2026-09-05', 12000n)])
    expect(lista.map((p) => [p.pago, p.restante])).toEqual([
      [5000n, 0n],
      [5000n, 0n],
      [2000n, 3000n],
    ])
  })

  test('atravessa vendas pela ordem de vencimento, não pela ordem das vendas', () => {
    // A venda A é mais antiga, mas a parcela da venda B vence primeiro: é ela que recebe.
    const a = fiado('va', '2026-09-01', [parcela('a1', '2026-10-15', 5000n), parcela('a2', '2026-11-15', 5000n)])
    const b = fiado('vb', '2026-09-10', [parcela('b1', '2026-10-01', 3000n)])
    const lista = parcelas([a, b, recebi([a, b], 'r1', '2026-09-20', 4000n)])
    expect(lista.map((p) => [p.parcela.id, p.pago, p.restante])).toEqual([
      ['b1', 3000n, 0n],
      ['a1', 1000n, 4000n],
      ['a2', 0n, 5000n],
    ])
  })

  test('empate de vencimento: o débito de data mais antiga primeiro, depois o id', () => {
    const tarde = fiado('v-tarde', '2026-09-10', [parcela('t1', '2026-10-01', 1000n)])
    const cedo = fiado('v-cedo', '2026-09-01', [parcela('c1', '2026-10-01', 1000n)])
    const mesmoDia1 = fiado('v-id-b', '2026-09-05', [parcela('m1', '2026-10-01', 1000n)])
    const mesmoDia2 = fiado('v-id-a', '2026-09-05', [parcela('m2', '2026-10-01', 1000n)])
    const lista = parcelas([tarde, cedo, mesmoDia1, mesmoDia2])
    expect(lista.map((p) => p.parcela.id)).toEqual(['c1', 'm2', 'm1', 't1'])
  })

  test('a ordem em que os recebimentos aconteceram não muda o resultado', () => {
    const venda = duas()
    const primeiro = recebi([venda], 'r1', '2026-09-05', 3000n)
    const segundo = recebi([venda, primeiro], 'r2', '2026-09-03', 5000n)
    const direta = parcelas([venda, primeiro, segundo]).map((p) => [p.pago, p.restante])
    const invertida = parcelas([venda, segundo, primeiro]).map((p) => [p.pago, p.restante])
    expect(direta).toEqual([
      [5000n, 0n],
      [3000n, 2000n],
    ])
    expect(invertida).toEqual(direta)
  })

  test('desconto de quitação abate a parcela como se fosse recebimento', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 4703n)])
    const r1 = recebi([venda], 'r1', '2026-09-05', 4700n)
    const desconto = ok(considerarPago([venda, r1], { id: 'q1', clienteId: VERA, data: '2026-09-05' }))
    expect(em(parcelas([venda, r1, desconto]), 0).restante).toBe(0n)
  })

  test('estorno de recebimento reabre a parcela; venda estornada some da lista', () => {
    const venda = duas()
    const r1 = recebi([venda], 'r1', '2026-09-05', 5000n)
    const base: Ficha = [venda, r1]
    expect(em(parcelas(base), 0).restante).toBe(0n)
    expect(em(parcelas([...base, estorno(base, 'e1', '2026-09-06', 'r1')]), 0).restante).toBe(5000n)
    expect(parcelas([venda, estorno([venda], 'e2', '2026-09-06', 'v1')])).toEqual([])
  })

  test('parcela de valor zero (R$ 0,01 em 2×, D-030) nasce paga', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 1n), parcela('p2', '2026-11-01', 0n)])
    expect(parcelas([venda]).map((p) => p.restante)).toEqual([1n, 0n])
  })

  test('a soma dos restantes é o saldo, numa ficha misturada', () => {
    const a = fiado('va', '2026-09-01', [parcela('a1', '2026-10-15', 5000n), parcela('a2', '2026-11-15', 5000n)])
    const b = anterior('sb', '2026-08-01', [parcela('b1', '2026-09-01', 2500n)])
    const c = avista('ac', '2026-09-03', 3990n)
    const r1 = recebi([a, b, c], 'r1', '2026-09-20', 4000n)
    const ficha: Ficha = [a, b, c, r1]
    expect(somar(parcelas(ficha).map((p) => p.restante))).toBe(saldo(ficha))
    expect(saldo(ficha)).toBe(8500n)
  })
})

describe('próxima parcela e situação (RF-02)', () => {
  test('a próxima é a mais antiga com algo faltando; sem dívida é null', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 5000n), parcela('p2', '2026-11-01', 5000n)])
    expect(proximaParcela([venda])?.parcela.id).toBe('p1')
    const r1 = recebi([venda], 'r1', '2026-09-05', 5000n)
    expect(proximaParcela([venda, r1])?.parcela.id).toBe('p2')
    const r2 = recebi([venda, r1], 'r2', '2026-09-06', 5000n)
    expect(proximaParcela([venda, r1, r2])).toBeNull()
    expect(proximaParcela([])).toBeNull()
  })

  test('paga, vencida ou a vencer — o dia de vencimento ainda não está vencido', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 5000n), parcela('p2', '2026-11-01', 5000n)])
    const ficha: Ficha = [venda, recebi([venda], 'r1', '2026-09-05', 5000n)]
    const [primeira, segunda] = parcelas(ficha)
    if (primeira === undefined || segunda === undefined) throw new Error('duas parcelas esperadas')
    expect(situacaoDaParcela(primeira, '2026-12-31')).toBe('paga')
    expect(situacaoDaParcela(segunda, '2026-10-31')).toBe('a-vencer')
    expect(situacaoDaParcela(segunda, '2026-11-01')).toBe('a-vencer')
    expect(situacaoDaParcela(segunda, '2026-11-02')).toBe('vencida')
  })
})

describe('histórico — ordem cronológica inversa, estorno como linha própria (RF-02, RF-08)', () => {
  test('o mais recente primeiro; empate de data pelo id, que ordena por criação', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 5000n)])
    const cedo = recebi([venda], 'r-a', '2026-09-05', 1000n)
    const tarde = recebi([venda, cedo], 'r-b', '2026-09-05', 1000n)
    const depois = avista('a1', '2026-09-07', 3990n)
    expect(historico([venda, tarde, depois, cedo]).map((l) => l.lancamento.id)).toEqual(['a1', 'r-b', 'r-a', 'v1'])
  })

  test('estorno mantém as duas linhas: o alvo marcado, o estorno com a data dele e o valor do alvo', () => {
    const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 5000n)])
    const r1 = recebi([venda], 'r1', '2026-09-05', 2000n)
    const e1 = estorno([venda, r1], 'e1', '2026-09-08', 'r1')
    const linhas = historico([venda, r1, e1])
    expect(linhas.map((l) => [l.lancamento.id, l.valor, l.estornado])).toEqual([
      ['e1', 2000n, false],
      ['r1', 2000n, true],
      ['v1', 5000n, false],
    ])
  })

  test('venda à vista e saldo anterior aparecem, cada um com o seu total e o seu tipo', () => {
    const papel = anterior('s1', '2026-08-01', [parcela('p1', '2026-09-01', 2500n), parcela('p2', '2026-10-01', 2500n)])
    const linhas = historico([avista('a1', '2026-09-03', 3990n), papel])
    expect(linhas.map((l) => [l.lancamento.tipo, l.valor])).toEqual([
      ['venda', 3990n],
      ['saldo-anterior', 5000n],
    ])
  })
})

describe('validar — as invariantes da ficha num lugar só', () => {
  const venda = fiado('v1', '2026-09-01', [parcela('p1', '2026-10-01', 5000n)])
  const base: Ficha = [venda]

  const motivo = (ficha: Ficha) => {
    const resultado = validar(ficha)
    return resultado.ok ? 'ok' : resultado.motivo
  }

  test('ficha vazia e ficha simples são válidas', () => {
    expect(motivo([])).toBe('ok')
    expect(motivo(base)).toBe('ok')
  })

  test('todos os lançamentos são da mesma cliente', () => {
    expect(motivo([venda, { ...venda, id: 'v2', clienteId: 'outra' }])).toBe('cliente-diferente')
  })

  test('nenhum id se repete — entre lançamentos, e entre lançamento e parcela', () => {
    expect(motivo([venda, { ...venda, parcelas: [parcela('p9', '2026-10-01', 5000n)] }])).toBe('id-repetido')
    expect(motivo([venda, { ...venda, id: 'v2', parcelas: [parcela('p1', '2026-10-01', 5000n)] }])).toBe('id-repetido')
    expect(motivo([{ ...venda, parcelas: [parcela('v1', '2026-10-01', 5000n)] }])).toBe('id-repetido')
  })

  test('toda data é um dia — do lançamento e da parcela', () => {
    expect(motivo([{ ...venda, data: '01/09/2026' }])).toBe('data-invalida')
    expect(motivo([{ ...venda, data: '2026-13-01' }])).toBe('data-invalida')
    expect(motivo([{ ...venda, parcelas: [parcela('p1', '2026-10-32', 5000n)] }])).toBe('data-invalida')
  })

  test('venda: tem item, preço não negativo, desconto dentro da soma, parcelas fechando o total', () => {
    expect(motivo([{ ...venda, itens: [] }])).toBe('sem-itens')
    expect(motivo([{ ...venda, itens: [{ descricao: 'x', preco: -1n }] }])).toBe('preco-negativo')
    expect(motivo([{ ...venda, desconto: 5001n }])).toBe('desconto-invalido')
    expect(motivo([{ ...venda, desconto: -1n }])).toBe('desconto-invalido')
    expect(motivo([{ ...venda, parcelas: [] }])).toBe('sem-parcelas')
    expect(motivo([{ ...venda, parcelas: [parcela('p1', '2026-10-01', 6000n), parcela('p2', '2026-11-01', -1000n)] }])).toBe('parcela-negativa')
    expect(motivo([{ ...venda, parcelas: [parcela('p1', '2026-10-01', 4999n)] }])).toBe('parcelas-nao-fecham')
    expect(motivo([{ ...venda, desconto: 1000n, parcelas: [parcela('p1', '2026-10-01', 4000n)] }])).toBe('ok')
  })

  test('recebimento e desconto: valor positivo; desconto até o limite', () => {
    const r1 = recebi(base, 'r1', '2026-09-05', 1000n)
    expect(motivo([venda, { ...r1, valor: 0n }])).toBe('valor-invalido')
    expect(motivo([venda, { ...r1, valor: -5n }])).toBe('valor-invalido')
    const desconto = { tipo: 'desconto-quitacao', id: 'q1', clienteId: VERA, data: '2026-09-05' } as const
    expect(motivo([venda, { ...desconto, valor: 0n }])).toBe('valor-invalido')
    expect(motivo([venda, { ...desconto, valor: 11n }])).toBe('acima-do-limite-de-quitacao')
    expect(motivo([venda, { ...desconto, valor: 10n }])).toBe('ok')
  })

  test('estorno: alvo existe, não é estorno, e só um por alvo', () => {
    const e1: Estorno = { tipo: 'estorno', id: 'e1', clienteId: VERA, data: '2026-09-06', estornaId: 'v1' }
    expect(motivo([venda, { ...e1, estornaId: 'nada' }])).toBe('lancamento-nao-encontrado')
    expect(motivo([venda, e1, { ...e1, id: 'e2', estornaId: 'e1' }])).toBe('lancamento-e-estorno')
    expect(motivo([venda, e1, { ...e1, id: 'e2' }])).toBe('ja-estornado')
    expect(motivo([venda, e1])).toBe('ok')
  })

  test('o saldo nunca é negativo (D-016)', () => {
    const r1 = recebi(base, 'r1', '2026-09-05', 5000n)
    const e1: Estorno = { tipo: 'estorno', id: 'e1', clienteId: VERA, data: '2026-09-06', estornaId: 'v1' }
    expect(motivo([venda, r1, e1])).toBe('ficha-ficaria-negativa')
  })
})

/**
 * Gerador determinístico (LCG de 32 bits). Sem biblioteca, de propósito: a semente aparece
 * na falha, e a rodada se repete com ela.
 */
class Aleatorio {
  private estado: number
  constructor(semente: number) {
    this.estado = semente >>> 0
  }
  /** Inteiro em [0, maximo). */
  inteiro(maximo: number): number {
    this.estado = (Math.imul(this.estado, 1664525) + 1013904223) >>> 0
    return this.estado % maximo
  }
  centavos(maximo: number): bigint {
    return BigInt(this.inteiro(maximo))
  }
  escolha<T>(lista: readonly T[]): T {
    return em(lista, this.inteiro(lista.length))
  }
}

const doisDigitos = (n: number) => String(n).padStart(2, '0')

/** Ids que têm um estorno apontando para eles, contados sem passar pelo domínio. */
function idsEstornados(ficha: Ficha): Set<string> {
  return new Set(ficha.filter((l): l is Estorno => l.tipo === 'estorno').map((l) => l.estornaId))
}

/** Soma independente 1: pelos itens da venda (não pelas parcelas), pulando o que foi estornado. */
function somaPelosItens(ficha: Ficha): bigint {
  const estornados = idsEstornados(ficha)
  let total = 0n
  for (const l of ficha) {
    if (l.tipo === 'estorno' || estornados.has(l.id)) continue
    if (l.tipo === 'venda' && l.pagamento === 'fiado') {
      for (const item of l.itens) total += item.preco
      total -= l.desconto
    } else if (l.tipo === 'saldo-anterior') {
      for (const p of l.parcelas) total += p.valor
    } else if (l.tipo === 'recebimento' || l.tipo === 'desconto-quitacao') {
      total -= l.valor
    }
  }
  return total
}

/** Soma independente 2: cada linha com sinal, e o estorno como o inverso do alvo (RN-07). Não pula nada. */
function somaComSinal(ficha: Ficha): bigint {
  const porId = new Map(ficha.map((l): [string, Lancamento] => [l.id, l]))
  const efeito = (l: Lancamento): bigint => {
    switch (l.tipo) {
      case 'venda':
        return l.pagamento === 'fiado' ? somar(l.parcelas.map((p) => p.valor)) : 0n
      case 'saldo-anterior':
        return somar(l.parcelas.map((p) => p.valor))
      case 'recebimento':
      case 'desconto-quitacao':
        return -l.valor
      case 'estorno': {
        const alvo = porId.get(l.estornaId)
        return alvo === undefined ? 0n : -efeito(alvo)
      }
    }
  }
  return somar(ficha.map(efeito))
}

/** Quanto foi abatido de fato: recebimentos e descontos vigentes, contados sem passar pelo domínio. */
function abatidoIndependente(ficha: Ficha): bigint {
  const estornados = idsEstornados(ficha)
  let total = 0n
  for (const l of ficha) {
    if ((l.tipo === 'recebimento' || l.tipo === 'desconto-quitacao') && !estornados.has(l.id)) total += l.valor
  }
  return total
}

describe('EL-02 — o saldo derivado bate com a soma independente (RT-04)', () => {
  test('fórmula: listas cruas ao acaso, inclusive estornos e fichas negativas', () => {
    // Sem passar pelas operações: aqui só a fórmula está em jogo, e uma ficha financeiramente
    // inválida (saldo negativo, recebimento acima da dívida) também precisa somar igual dos
    // três jeitos. O estorno continua estruturalmente válido — alvo que existe, que não é
    // estorno e ainda não estornado (D-039) —, porque fora disso "o inverso do alvo" não tem
    // definição, e a soma com sinal deixaria de ser uma segunda opinião.
    const falhas: string[] = []
    for (let semente = 1; semente <= 300; semente += 1) {
      const r = new Aleatorio(semente)
      const ficha: Lancamento[] = []
      const dia = () => `2026-${doisDigitos(1 + r.inteiro(12))}-${doisDigitos(1 + r.inteiro(28))}`
      const tamanho = 20 + r.inteiro(40)
      for (let n = 0; n < tamanho; n += 1) {
        const id = `${semente}-${n}`
        const sorteio = r.inteiro(6)
        if (sorteio === 0) {
          const valores = repartir(r.centavos(20000), 1 + r.inteiro(4))
          ficha.push({
            tipo: 'venda',
            pagamento: 'fiado',
            id,
            clienteId: VERA,
            data: dia(),
            itens: [{ descricao: 'x', preco: somar(valores) + 500n }],
            desconto: 500n,
            parcelas: valores.map((valor, i) => parcela(`${id}-p${i}`, dia(), valor)),
          })
        } else if (sorteio === 1) {
          ficha.push({ tipo: 'venda', pagamento: 'avista', id, clienteId: VERA, data: dia(), itens: [{ descricao: 'x', preco: r.centavos(5000) }], desconto: 0n, forma: 'pix' })
        } else if (sorteio === 2) {
          ficha.push({ tipo: 'saldo-anterior', id, clienteId: VERA, data: dia(), parcelas: [parcela(`${id}-p0`, dia(), r.centavos(10000))] })
        } else if (sorteio === 3) {
          ficha.push({ tipo: 'recebimento', id, clienteId: VERA, data: dia(), valor: 1n + r.centavos(8000), forma: 'dinheiro' })
        } else if (sorteio === 4) {
          ficha.push({ tipo: 'desconto-quitacao', id, clienteId: VERA, data: dia(), valor: 1n + r.centavos(10) })
        } else {
          const estornados = idsEstornados(ficha)
          const candidatos = ficha.filter((l) => l.tipo !== 'estorno' && !estornados.has(l.id))
          if (candidatos.length === 0) continue
          ficha.push({ tipo: 'estorno', id, clienteId: VERA, data: dia(), estornaId: r.escolha(candidatos).id })
        }
      }
      const derivado = saldo(ficha)
      if (derivado !== somaPelosItens(ficha)) falhas.push(`semente ${semente}: saldo ${emReais(derivado)} ≠ soma pelos itens ${emReais(somaPelosItens(ficha))}`)
      if (derivado !== somaComSinal(ficha)) falhas.push(`semente ${semente}: saldo ${emReais(derivado)} ≠ soma com sinal ${emReais(somaComSinal(ficha))}`)
    }
    expect(falhas).toEqual([])
  })

  test('operações: 200 fichas × 60 lançamentos ao acaso, conferidas a cada passo', () => {
    const falhas: string[] = []
    const aceitos = { fiado: 0, avista: 0, anterior: 0, recebimento: 0, troco: 0, quitacao: 0, estorno: 0, renegociacao: 0 }
    const recusas = { negativa: 0, jaEstornado: 0, nadaAReceber: 0, foraDoLimite: 0, sincronizado: 0 }

    for (let semente = 1; semente <= 200; semente += 1) {
      const r = new Aleatorio(semente * 7919)
      let ficha: Ficha = []
      let contador = 0
      const novoId = () => `${semente}-${(contador += 1)}`
      const dia = () => `2026-${doisDigitos(1 + r.inteiro(12))}-${doisDigitos(1 + r.inteiro(28))}`
      const falha = (passo: number, texto: string) => falhas.push(`semente ${semente}, passo ${passo}: ${texto}`)

      for (let passo = 0; passo < 60; passo += 1) {
        const sorteio = r.inteiro(100)
        const saldoAntes = saldo(ficha)

        if (sorteio < 22) {
          const desconto = r.centavos(300)
          const valores = repartir(r.centavos(20000), 1 + r.inteiro(4))
          const venda = novaVendaFiado({
            id: novoId(),
            clienteId: VERA,
            data: dia(),
            itens: [{ descricao: 'creme', preco: somar(valores) }, { descricao: 'batom', preco: desconto }],
            desconto,
            parcelas: valores.map((valor) => parcela(novoId(), dia(), valor)),
          })
          if (!venda.ok) falha(passo, `venda fiado recusada: ${venda.motivo}`)
          else {
            ficha = [...ficha, venda.valor]
            aceitos.fiado += 1
          }
        } else if (sorteio < 28) {
          const venda = novaVendaAVista({ id: novoId(), clienteId: VERA, data: dia(), itens: [{ descricao: 'x', preco: r.centavos(5000) }], forma: 'pix' })
          if (!venda.ok) falha(passo, `venda à vista recusada: ${venda.motivo}`)
          else {
            ficha = [...ficha, venda.valor]
            aceitos.avista += 1
          }
        } else if (sorteio < 33) {
          const papel = novoSaldoAnterior({ id: novoId(), clienteId: VERA, data: dia(), parcelas: [parcela(novoId(), dia(), r.centavos(10000))] })
          if (!papel.ok) falha(passo, `saldo anterior recusado: ${papel.motivo}`)
          else {
            ficha = [...ficha, papel.valor]
            aceitos.anterior += 1
          }
        } else if (sorteio < 62) {
          // Um em cada quatro recebimentos deixa um resíduo de até R$ 0,10 — o caso de D-031
          // ("deve 47,03 e dá 47,00"), que ao acaso quase nunca aconteceria.
          const residuo = saldoAntes > 10n && r.inteiro(4) === 0
          const valor = residuo ? saldoAntes - r.centavos(11) : 1n + r.centavos(Number(saldoAntes) + 1000)
          const resultado = registrarRecebimento(ficha, { id: novoId(), clienteId: VERA, data: dia(), valor, forma: 'dinheiro' })
          if (saldoAntes === 0n) {
            if (resultado.ok || resultado.motivo !== 'nada-a-receber') falha(passo, 'recebimento sem dívida não foi recusado')
            else recusas.nadaAReceber += 1
          } else if (!resultado.ok) falha(passo, `recebimento recusado: ${resultado.motivo}`)
          else {
            const { recebimento, troco } = resultado.valor
            const esperadoTroco = valor > saldoAntes ? valor - saldoAntes : 0n
            if (troco !== esperadoTroco) falha(passo, `troco ${emReais(troco)} ≠ ${emReais(esperadoTroco)}`)
            if (recebimento.valor + troco !== valor) falha(passo, 'registrado + troco ≠ recebido')
            ficha = [...ficha, recebimento]
            aceitos.recebimento += 1
            if (troco > 0n) aceitos.troco += 1
          }
        } else if (sorteio < 70) {
          const resultado = considerarPago(ficha, { id: novoId(), clienteId: VERA, data: dia() })
          if (podeConsiderarPago(ficha)) {
            if (!resultado.ok) falha(passo, `quitação recusada com saldo ${emReais(saldoAntes)}: ${resultado.motivo}`)
            else {
              ficha = [...ficha, resultado.valor]
              aceitos.quitacao += 1
              if (saldo(ficha) !== 0n) falha(passo, 'quitação não zerou o saldo')
            }
          } else if (resultado.ok) falha(passo, `quitação aceita com saldo ${emReais(saldoAntes)}`)
          else if (resultado.motivo === 'acima-do-limite-de-quitacao') recusas.foraDoLimite += 1
          else if (resultado.motivo !== 'nada-a-quitar') falha(passo, `quitação: motivo inesperado ${resultado.motivo}`)
        } else if (sorteio < 85) {
          const candidatos = ficha.filter((l) => l.tipo !== 'estorno')
          if (candidatos.length === 0) continue
          const alvo = r.escolha(candidatos)
          const resultado = estornar(ficha, { id: novoId(), clienteId: VERA, data: dia(), estornaId: alvo.id })
          if (resultado.ok) {
            ficha = [...ficha, resultado.valor]
            aceitos.estorno += 1
          } else if (resultado.motivo === 'ficha-ficaria-negativa') recusas.negativa += 1
          else if (resultado.motivo === 'ja-estornado') recusas.jaEstornado += 1
          else falha(passo, `estorno: motivo inesperado ${resultado.motivo}`)
        } else {
          const debitos = ficha.filter(ehDebito)
          if (debitos.length === 0) continue
          const debito = r.escolha(debitos)
          // Mantém o que está pago (inclusive parcela de valor zero) e redistribui o resto.
          const estado = parcelas(ficha).filter((p) => p.debito.id === debito.id)
          const mantidas = estado.filter((p) => p.restante === 0n).map((p) => p.parcela)
          const resto = somar(debito.parcelas.map((p) => p.valor)) - somar(mantidas.map((p) => p.valor))
          const novas = repartir(resto, 1 + r.inteiro(3)).map((valor) => parcela(novoId(), dia(), valor))
          const sincronizado = r.inteiro(4) === 0
          const resultado = renegociarParcelas(ficha, debito.id, [...mantidas, ...novas], { sincronizado })
          if (sincronizado) {
            if (resultado.ok || resultado.motivo !== 'ja-sincronizado') falha(passo, 'renegociação de débito sincronizado não foi recusada')
            else recusas.sincronizado += 1
          } else if (!resultado.ok) {
            // Se o débito está estornado, ele não tem parcela derivada, e "mantidas" vem vazia:
            // a lista nova ainda soma o total, e a substituição continua válida. Qualquer
            // recusa aqui é defeito.
            falha(passo, `renegociação recusada: ${resultado.motivo}`)
          } else {
            const novo = resultado.valor
            ficha = ficha.map((l) => (l.id === novo.id ? novo : l))
            aceitos.renegociacao += 1
          }
        }

        // As invariantes, depois de cada passo — é aqui que EL-02 é provada.
        const derivado = saldo(ficha)
        if (derivado !== somaPelosItens(ficha)) falha(passo, `saldo ${emReais(derivado)} ≠ soma pelos itens ${emReais(somaPelosItens(ficha))}`)
        if (derivado !== somaComSinal(ficha)) falha(passo, `saldo ${emReais(derivado)} ≠ soma com sinal ${emReais(somaComSinal(ficha))}`)
        if (derivado < 0n) falha(passo, `saldo negativo: ${emReais(derivado)}`)
        const lista = parcelas(ficha)
        if (somar(lista.map((p) => p.restante)) !== derivado) falha(passo, 'soma dos restantes ≠ saldo')
        if (somar(lista.map((p) => p.pago)) !== abatidoIndependente(ficha)) falha(passo, 'soma dos pagos ≠ total abatido')
        if (lista.some((p) => p.pago < 0n || p.pago > p.parcela.valor)) falha(passo, 'parcela com pago fora de [0, valor]')
        const validacao = validar(ficha)
        if (!validacao.ok) falha(passo, `ficha inválida: ${validacao.motivo}`)
        const linhas = historico(ficha)
        if (linhas.length !== ficha.length) falha(passo, 'histórico perdeu linha')
        if (linhas.filter((l) => l.estornado).length !== ficha.filter((l) => l.tipo === 'estorno').length) falha(passo, 'marcação de estornado não bate')
      }
    }

    expect(falhas.slice(0, 5)).toEqual([])
    expect(falhas).toHaveLength(0)
    // O teste só prova alguma coisa se cada caminho aconteceu de verdade, e não uma vez.
    expect(aceitos.fiado).toBeGreaterThan(1000)
    expect(aceitos.avista).toBeGreaterThan(200)
    expect(aceitos.anterior).toBeGreaterThan(200)
    expect(aceitos.recebimento).toBeGreaterThan(1000)
    expect(aceitos.troco).toBeGreaterThan(100)
    expect(aceitos.quitacao).toBeGreaterThan(30)
    expect(aceitos.estorno).toBeGreaterThan(500)
    expect(aceitos.renegociacao).toBeGreaterThan(300)
    expect(recusas.negativa).toBeGreaterThan(100)
    expect(recusas.jaEstornado).toBeGreaterThan(50)
    expect(recusas.nadaAReceber).toBeGreaterThan(200)
    expect(recusas.foraDoLimite).toBeGreaterThan(100)
    expect(recusas.sincronizado).toBeGreaterThan(100)
  })
})
