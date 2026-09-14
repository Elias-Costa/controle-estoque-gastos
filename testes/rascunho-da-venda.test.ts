import { describe, expect, test } from 'bun:test'
import { repartir, somar } from '../src/dominio/dinheiro.ts'
import type { Parcela, Resultado, VendaFiado } from '../src/dominio/ficha.ts'
import { novaVendaAVista, novaVendaFiado } from '../src/dominio/lancamentos.ts'
import { fraseDaGuarda, fraseDaRecusa, linhasDaConfirmacao, quandoDaParcela } from '../src/interface/palavras-da-venda.ts'
import {
  conferir,
  datasSugeridas,
  lerItens,
  montarParcelas,
  parcelasCorrigidas,
  rascunhoDaVenda,
  textoDeCentavos,
  type Rascunho,
} from '../src/interface/rascunho-da-venda.ts'

/**
 * A venda enquanto ela digita (E-10, D-045): total, parcelas com a regra "a editada fica, as
 * outras absorvem", guardas visíveis antes do toque, e o caminho de volta (venda gravada →
 * rascunho para a correção). Tudo em `bigint`; `hoje` fixado.
 */

const HOJE = '2026-09-12'

function ok<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) throw new Error(`recusado: ${resultado.motivo}`)
  return resultado.valor
}

/** O rascunho da tarefa cronometrada (RT-15): dois itens, fiado, hoje. */
function rascunhoDeDoisItens(sobrescrever: Partial<Rascunho> = {}): Rascunho {
  return {
    itens: [
      { descricao: 'Creme', precoTexto: '39,90' },
      { descricao: 'Perfume', precoTexto: '25' },
      { descricao: '', precoTexto: '' },
    ],
    descontoTexto: '',
    pagamento: 'fiado',
    forma: 'dinheiro',
    vezes: 1,
    edicoes: [],
    data: HOJE,
    ...sobrescrever,
  }
}

describe('itens e total — lidos pelo domínio (D-034), item em branco ignorado', () => {
  test('"39,90" e "25" (pela direita, R$ 0,25) somam; o terceiro item, vazio, não conta nem trava', () => {
    const conferencia = conferir(rascunhoDeDoisItens(), HOJE)
    expect(conferencia.itensDaVenda).toEqual([
      { descricao: 'Creme', preco: 3990n },
      { descricao: 'Perfume', preco: 25n },
    ])
    expect(conferencia.total).toBe(4015n)
    expect(conferencia.guardas).toEqual([])
  })

  test('lerItens distingue vazio, sem preço e ilegível', () => {
    expect(lerItens([{ descricao: ' ', precoTexto: '' }])[0]).toMatchObject({ vazio: true, semPreco: true, preco: null })
    expect(lerItens([{ descricao: 'Batom', precoTexto: '' }])[0]).toMatchObject({ vazio: false, semPreco: true, preco: null })
    expect(lerItens([{ descricao: 'Batom', precoTexto: '39,905' }])[0]).toMatchObject({ vazio: false, semPreco: false, preco: null })
    expect(lerItens([{ descricao: '', precoTexto: '1.250' }])[0]).toMatchObject({ vazio: false, preco: 125000n })
  })

  test('descrição sem preço trava com "falta o preço"; preço que o domínio não lê trava com "não entendi"', () => {
    const faltando = conferir(rascunhoDeDoisItens({ itens: [{ descricao: 'Creme', precoTexto: '3990' }, { descricao: 'Batom', precoTexto: '' }] }), HOJE)
    expect(faltando.guardas).toEqual(['falta-preco'])
    expect(faltando.total).toBe(3990n)
    const ilegivel = conferir(rascunhoDeDoisItens({ itens: [{ descricao: 'Creme', precoTexto: '39,905' }] }), HOJE)
    expect(ilegivel.guardas).toEqual(['preco-ilegivel', 'sem-valor'])
  })

  test('nada digitado é "sem valor": indisponível, sem frase (regra do protótipo)', () => {
    const vazio = conferir(rascunhoDeDoisItens({ itens: [{ descricao: '', precoTexto: '' }] }), HOJE)
    expect(vazio.guardas).toEqual(['sem-valor'])
    expect(fraseDaGuarda('sem-valor', 0n, 0n)).toBeNull()
  })
})

describe('desconto no total (RF-03, D-045 item 4)', () => {
  test('abate do total e das parcelas; maior que a venda ou ilegível é guarda', () => {
    const com = conferir(rascunhoDeDoisItens({ descontoTexto: '4,15' }), HOJE)
    expect(com.desconto).toBe(415n)
    expect(com.total).toBe(3600n)
    expect(com.parcelas.map((p) => p.valor)).toEqual([3600n])

    expect(conferir(rascunhoDeDoisItens({ descontoTexto: '50' }), HOJE).desconto).toBe(50n)
    expect(conferir(rascunhoDeDoisItens({ descontoTexto: '100,00' }), HOJE).guardas).toEqual(['desconto-maior', 'sem-valor'])
    expect(conferir(rascunhoDeDoisItens({ descontoTexto: 'x' }), HOJE).guardas).toEqual(['desconto-ilegivel'])
  })
})

describe('parcelas — datas de mês em mês a partir da venda; a editada fica, as outras absorvem (D-012, D-030, D-045)', () => {
  test('sugestão: 3× de uma venda em 12/09 vence em 12/10, 12/11 e 12/12', () => {
    expect(datasSugeridas('2026-09-12', 3)).toEqual(['2026-10-12', '2026-11-12', '2026-12-12'])
    expect(datasSugeridas('2026-01-31', 2)).toEqual(['2026-02-28', '2026-03-31'])
  })

  test('sem edição é a divisão automática de D-030: R$ 64,90 em 3× → 21,70 / 21,60 / 21,60', () => {
    const parcelas = montarParcelas(6490n, datasSugeridas(HOJE, 3), [])
    expect(parcelas.map((p) => p.valor)).toEqual([2170n, 2160n, 2160n])
    expect(parcelas.map((p) => p.vencimento)).toEqual(['2026-10-12', '2026-11-12', '2026-12-12'])
    expect(parcelas.every((p) => !p.editada && !p.ilegivel)).toBe(true)
  })

  test('"paga 30 agora e o resto depois": a 1ª fica em 30,00 e as outras dividem os 34,90 ("30" seria R$ 0,30, D-034)', () => {
    const parcelas = montarParcelas(6490n, datasSugeridas(HOJE, 3), [{ valorTexto: '30,00' }])
    expect(parcelas.map((p) => [p.valor, p.editada])).toEqual([
      [3000n, true],
      [1745n, false],
      [1745n, false],
    ])
    expect(somar(parcelas.map((p) => p.valor))).toBe(6490n)
  })

  test('valor que ela digita não precisa ser múltiplo de 5; o resto continua sendo (D-012)', () => {
    const parcelas = montarParcelas(10000n, datasSugeridas(HOJE, 3), [{}, { valorTexto: '33,33' }])
    expect(parcelas.map((p) => p.valor)).toEqual([3337n, 3333n, 3330n])
    expect(somar(parcelas.map((p) => p.valor))).toBe(10000n)
    expect(repartir(6667n, 2)).toEqual([3337n, 3330n])
  })

  test('data editada vale; data vazia volta à sugerida; edição de valor vazia é "não mexeu"', () => {
    const parcelas = montarParcelas(6000n, datasSugeridas(HOJE, 2), [{ vencimento: '2026-09-20' }, { vencimento: '', valorTexto: '  ' }])
    expect(parcelas.map((p) => [p.vencimento, p.valor, p.editada])).toEqual([
      ['2026-09-20', 3000n, false],
      ['2026-11-12', 3000n, false],
    ])
  })

  test('editou todas e não fecha, ou o resto ficaria negativo: guarda "as parcelas somam X; a venda é Y"', () => {
    const todas = conferir(rascunhoDeDoisItens({ vezes: 2, edicoes: [{ valorTexto: '2000' }, { valorTexto: '2000' }] }), HOJE)
    expect(todas.guardas).toEqual(['parcelas-nao-fecham'])
    expect(fraseDaGuarda('parcelas-nao-fecham', 4000n, 4015n)).toBe('As parcelas somam R$ 40,00; a venda é R$ 40,15')

    const negativo = conferir(rascunhoDeDoisItens({ vezes: 2, edicoes: [{ valorTexto: '5000' }] }), HOJE)
    expect(negativo.guardas).toEqual(['parcelas-nao-fecham'])
    expect(negativo.parcelas.map((p) => p.valor)).toEqual([5000n, 0n])

    const fecha = conferir(rascunhoDeDoisItens({ vezes: 2, edicoes: [{ valorTexto: '2000' }, { valorTexto: '20,15' }] }), HOJE)
    expect(fecha.guardas).toEqual([])
  })

  test('valor de parcela que o domínio não lê é guarda própria, antes da soma', () => {
    const conferencia = conferir(rascunhoDeDoisItens({ vezes: 2, edicoes: [{ valorTexto: '20,155' }] }), HOJE)
    expect(conferencia.guardas).toEqual(['parcela-ilegivel'])
  })

  test('à vista não tem parcela', () => {
    const conferencia = conferir(rascunhoDeDoisItens({ pagamento: 'avista', vezes: 3 }), HOJE)
    expect(conferencia.parcelas).toEqual([])
    expect(conferencia.guardas).toEqual([])
  })
})

describe('a data do fato (RN-09): editável para o passado, nunca para o futuro, nunca vazia', () => {
  test('ontem e um mês atrás passam; vazia e amanhã travam', () => {
    expect(conferir(rascunhoDeDoisItens({ data: '2026-09-11' }), HOJE).guardas).toEqual([])
    expect(conferir(rascunhoDeDoisItens({ data: '2026-08-12' }), HOJE).guardas).toEqual([])
    expect(conferir(rascunhoDeDoisItens({ data: '' }), HOJE).guardas).toEqual(['falta-a-data'])
    expect(conferir(rascunhoDeDoisItens({ data: '2026-09-13' }), HOJE).guardas).toEqual(['data-no-futuro'])
  })

  test('as parcelas seguem a data da venda, não a de hoje', () => {
    const conferencia = conferir(rascunhoDeDoisItens({ data: '2026-08-12', vezes: 2 }), HOJE)
    expect(conferencia.parcelas.map((p) => p.vencimento)).toEqual(['2026-09-12', '2026-10-12'])
  })
})

describe('de volta ao rascunho — a correção (D-013, D-045)', () => {
  const parcela = (id: string, vencimento: string, valor: bigint): Parcela => ({ id, vencimento, valor })

  test('textoDeCentavos: o que ela teria digitado, sem ponto de milhar', () => {
    expect(textoDeCentavos(3990n)).toBe('39,90')
    expect(textoDeCentavos(25n)).toBe('0,25')
    expect(textoDeCentavos(125000n)).toBe('1250,00')
    expect(textoDeCentavos(0n)).toBe('0,00')
  })

  test('fiado com a divisão automática: datas entram editadas, valores não — mudar um preço redistribui', () => {
    const venda = ok(
      novaVendaFiado({
        id: 'v1',
        clienteId: 'c1',
        data: '2026-09-01',
        itens: [{ descricao: 'Creme', preco: 6490n }],
        parcelas: [parcela('p1', '2026-10-01', 2170n), parcela('p2', '2026-11-05', 2160n), parcela('p3', '2026-12-01', 2160n)],
      }),
    )
    const rascunho = rascunhoDaVenda(venda)
    expect(rascunho).toMatchObject({ pagamento: 'fiado', vezes: 3, data: '2026-09-01', descontoTexto: '' })
    expect(rascunho.itens).toEqual([{ descricao: 'Creme', precoTexto: '64,90' }])
    expect(rascunho.edicoes).toEqual([{ vencimento: '2026-10-01' }, { vencimento: '2026-11-05' }, { vencimento: '2026-12-01' }])

    // Sem mexer em nada, a conferência devolve a venda como estava.
    const igual = conferir(rascunho, HOJE)
    expect(igual.parcelas.map((p) => [p.vencimento, p.valor])).toEqual([
      ['2026-10-01', 2170n],
      ['2026-11-05', 2160n],
      ['2026-12-01', 2160n],
    ])
    // Corrigiu o preço: o resto se redistribui, as datas dela ficam.
    const corrigido = conferir({ ...rascunho, itens: [{ descricao: 'Creme', precoTexto: '6000' }] }, HOJE)
    expect(corrigido.parcelas.map((p) => [p.vencimento, p.valor])).toEqual([
      ['2026-10-01', 2000n],
      ['2026-11-05', 2000n],
      ['2026-12-01', 2000n],
    ])
  })

  test('parcela combinada à mão continua combinada: o valor que difere de repartir entra editado', () => {
    const venda: VendaFiado = ok(
      novaVendaFiado({
        id: 'v2',
        clienteId: 'c1',
        data: '2026-09-01',
        itens: [{ descricao: 'Creme', preco: 6490n }],
        desconto: 490n,
        parcelas: [parcela('p1', '2026-09-01', 3000n), parcela('p2', '2026-10-01', 3000n)],
      }),
    )
    const rascunho = rascunhoDaVenda(venda)
    expect(rascunho.descontoTexto).toBe('4,90')
    expect(rascunho.edicoes).toEqual([{ vencimento: '2026-09-01' }, { vencimento: '2026-10-01' }])
    const venda3 = { ...venda, parcelas: [parcela('p1', '2026-09-01', 2000n), parcela('p2', '2026-10-01', 4000n)] }
    expect(rascunhoDaVenda(venda3).edicoes).toEqual([
      { vencimento: '2026-09-01', valorTexto: '20,00' },
      { vencimento: '2026-10-01', valorTexto: '40,00' },
    ])
  })

  test('à vista guarda a forma; parcelasCorrigidas mantém o id pela posição e deixa a sobra nova', () => {
    const avista = ok(novaVendaAVista({ id: 'a1', clienteId: 'c1', data: '2026-09-01', itens: [{ descricao: 'Batom', preco: 2500n }], forma: 'pix' }))
    expect(rascunhoDaVenda(avista)).toMatchObject({ pagamento: 'avista', forma: 'pix', vezes: 1, edicoes: [] })

    const montadas = montarParcelas(9000n, datasSugeridas(HOJE, 3), [])
    const originais = [parcela('p1', '2026-10-01', 4500n), parcela('p2', '2026-11-01', 4500n)]
    expect(parcelasCorrigidas(montadas, originais)).toEqual([
      { id: 'p1', vencimento: '2026-10-12', valor: 3000n },
      { id: 'p2', vencimento: '2026-11-12', valor: 3000n },
      { vencimento: '2026-12-12', valor: 3000n },
    ])
  })
})

describe('as palavras da venda (RI-07) — as do protótipo e as hipóteses de D-045', () => {
  test('confirmação: fiado diz o saldo novo; à vista diz o que pagou e o que ainda deve, ou que não deve nada', () => {
    expect(linhasDaConfirmacao('Rosa', true, 6490n, 6490n)).toEqual(['Anotado na fichinha da Rosa', 'Agora ela deve R$ 64,90'])
    expect(linhasDaConfirmacao('Rosa', false, 6490n, 0n)).toEqual(['Rosa levou e pagou R$ 64,90', 'Ela não deve nada'])
    expect(linhasDaConfirmacao('Rosa', false, 6490n, 4500n)).toEqual(['Rosa levou e pagou R$ 64,90', 'Ainda deve R$ 45,00'])
    expect(linhasDaConfirmacao('Rosa', true, 100n, 0n)[1]).toBe('Ela não deve nada')
  })

  test('a linha da parcela e as recusas em palavras dela, nunca o código', () => {
    expect(quandoDaParcela(1, '2026-10-12')).toBe('1ª em 12/10')
    expect(fraseDaRecusa('ja-sincronizado')).toBe('Já foi enviada. Desfaça e anote de novo.')
    expect(fraseDaRecusa('ficha-ficaria-negativa')).toBe('Ela já pagou parte. Desfaça o recebimento antes.')
    expect(fraseDaRecusa('sem-itens')).not.toMatch(/sem-itens/)
  })
})
