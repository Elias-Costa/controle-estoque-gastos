import { describe, expect, test } from 'bun:test'
import { emReais, lerDinheiro, multiplicar, repartir, somar } from '../src/dominio/dinheiro.ts'

/**
 * RT-01 — aritmética monetária em centavos (RN-10, EL-03).
 *
 * Os números destes testes são os de `D-030` (parcelas em múltiplos de 5 centavos, a
 * primeira carrega a diferença) e de `D-012` (a sobra vai na primeira). O exemplo antigo
 * de RT-01 — "3× R$ 33,33 fechando R$ 100,00" — antecede `D-030`; o que ele afirma, e
 * continua valendo, é que a soma das parcelas é o total, sem centavo perdido.
 *
 * A leitura do que ela digita segue `D-034` e sua emenda de 2026-09-11 (E-03): sem
 * separador preenche pela direita; com separador lê literal; ponto seguido de três
 * dígitos é milhar; mais de duas casas decimais não é lido.
 */

describe('repartir — parcelas em múltiplos de 5, a primeira carrega a diferença (D-012, D-030)', () => {
  test('R$ 64,90 em 3× → 21,70 / 21,60 / 21,60', () => {
    expect(repartir(6490n, 3)).toEqual([2170n, 2160n, 2160n])
  })

  test('R$ 100,00 em 3× → 33,40 / 33,30 / 33,30, somando exatamente R$ 100,00', () => {
    const parcelas = repartir(10000n, 3)
    expect(parcelas).toEqual([3340n, 3330n, 3330n])
    expect(somar(parcelas)).toBe(10000n)
  })

  test('R$ 39,99 em 3× → 13,39 / 13,30 / 13,30', () => {
    expect(repartir(3999n, 3)).toEqual([1339n, 1330n, 1330n])
  })

  test('R$ 0,01 em 2× → 0,01 / 0,00', () => {
    expect(repartir(1n, 2)).toEqual([1n, 0n])
  })

  test('R$ 999.999,99 em 3× → 333.333,39 / 333.333,30 / 333.333,30', () => {
    const parcelas = repartir(99999999n, 3)
    expect(parcelas).toEqual([33333339n, 33333330n, 33333330n])
    expect(somar(parcelas)).toBe(99999999n)
  })

  test('R$ 999.999,99 em 12× fecha o total, com a primeira carregando o resto', () => {
    const parcelas = repartir(99999999n, 12)
    expect(parcelas).toHaveLength(12)
    expect(somar(parcelas)).toBe(99999999n)
    expect(parcelas[0]).toBe(99999999n - 8333330n * 11n)
    expect(parcelas.slice(1)).toEqual(new Array<bigint>(11).fill(8333330n))
  })

  test('uma parcela só é o próprio total, mesmo fora do múltiplo de 5', () => {
    expect(repartir(4703n, 1)).toEqual([4703n])
  })

  test('total zero reparte em zeros', () => {
    expect(repartir(0n, 4)).toEqual([0n, 0n, 0n, 0n])
  })

  test('propriedade exaustiva: 0..10.000 centavos × 1..12 parcelas', () => {
    // Sem biblioteca de propriedade, de propósito: o espaço é pequeno o bastante para ser
    // percorrido inteiro, e um teste exaustivo não depende de semente nem de sorte.
    const falhas: string[] = []
    let verificadas = 0
    for (let total = 0n; total <= 10000n; total += 1n) {
      for (let vezes = 1; vezes <= 12; vezes += 1) {
        const parcelas = repartir(total, vezes)
        const primeira = parcelas[0] ?? -1n
        const problema =
          parcelas.length !== vezes ? 'tamanho errado'
          : somar(parcelas) !== total ? 'soma diferente do total'
          : parcelas.some((p) => p < 0n) ? 'parcela negativa'
          : parcelas.slice(1).some((p) => p % 5n !== 0n) ? 'parcela comum fora do múltiplo de 5'
          : parcelas.slice(1).some((p) => p > primeira) ? 'primeira menor que outra'
          : null
        if (problema) falhas.push(`${emReais(total)} em ${vezes}×: ${problema} → ${parcelas.join('/')}`)
        verificadas += 1
      }
    }
    expect(falhas.slice(0, 5)).toEqual([])
    expect(falhas).toHaveLength(0)
    expect(verificadas).toBe(10001 * 12)
  })

  test('recusa número de parcelas inválido', () => {
    expect(() => repartir(1000n, 0)).toThrow(RangeError)
    expect(() => repartir(1000n, -1)).toThrow(RangeError)
    expect(() => repartir(1000n, 1.5)).toThrow(RangeError)
    expect(() => repartir(1000n, NaN)).toThrow(RangeError)
  })

  test('recusa total negativo', () => {
    expect(() => repartir(-1n, 2)).toThrow(RangeError)
  })
})

describe('lerDinheiro — o que ela digita vira centavos (D-034)', () => {
  const casos: ReadonlyArray<readonly [string, bigint | null, string]> = [
    // Sem separador: preenche pela direita, como a maquininha.
    ['3990', 3990n, 'R$ 39,90'],
    ['25', 25n, 'R$ 0,25 — o custo conhecido de D-034; RT-15 mede'],
    ['0', 0n, 'zero é um valor; se a venda aceita zero é guarda da tela'],
    ['007', 7n, 'zeros à esquerda não valem nada'],
    // Com separador decimal: lê literal.
    ['39,90', 3990n, 'a tecla observada na sessão'],
    ['39.9', 3990n, 'ponto é vírgula; uma casa é dezena de centavo'],
    ['25,', 2500n, 'vírgula pendente enquanto ela digita'],
    [',50', 50n, 'sem parte inteira'],
    ['0,05', 5n, ''],
    ['25,00', 2500n, ''],
    ['1250,00', 125000n, 'sem ponto de milhar, com vírgula'],
    // Ponto de milhar em pt-BR: o texto é lido como reais (emenda de D-034).
    ['1.250', 125000n, 'mil duzentos e cinquenta, nunca R$ 12,50 nem R$ 1,25'],
    ['1.250,00', 125000n, ''],
    ['1.250,5', 125050n, ''],
    ['1.250.000', 125000000n, ''],
    ['12.345', 1234500n, ''],
    ['39.905', 3990500n, 'ponto seguido de três dígitos é milhar, não três casas — é por isso que a vírgula é a tecla segura'],
    // Espaço em volta é ignorado.
    ['  39,90  ', 3990n, ''],
    // Não é um valor.
    ['', null, 'nada digitado não é R$ 0,00'],
    ['   ', null, ''],
    ['39,905', null, 'três casas: não tem leitura exata em centavos; não trunca'],
    ['39.9055', null, 'quatro casas depois do ponto: nem milhar nem centavo'],
    ['1,2,3', null, ''],
    ['1.2.3', null, ''],
    ['12.3456', null, 'ponto seguido de quatro dígitos não é milhar nem centavo'],
    ['12345.678', null, 'agrupamento de milhar precisa ser o da língua'],
    ['abc', null, ''],
    ['-5', null, 'ela não digita valor negativo'],
    ['R$ 5', null, 'o campo recebe o que ela tecla, não o que a tela formata'],
    ['1 250', null, ''],
  ]

  for (const [texto, esperado, porque] of casos) {
    const rotulo = esperado === null ? 'não é um valor' : emReais(esperado)
    test(`"${texto}" → ${rotulo}${porque ? ` (${porque})` : ''}`, () => {
      expect(lerDinheiro(texto)).toBe(esperado)
    })
  }
})

describe('emReais — formatação em pt-BR', () => {
  test('zero e centavos soltos', () => {
    expect(emReais(0n)).toBe('R$ 0,00')
    expect(emReais(5n)).toBe('R$ 0,05')
    expect(emReais(50n)).toBe('R$ 0,50')
  })

  test('valores do catálogo dela', () => {
    expect(emReais(3990n)).toBe('R$ 39,90')
    expect(emReais(2500n)).toBe('R$ 25,00')
  })

  test('ponto de milhar a cada três dígitos', () => {
    expect(emReais(125000n)).toBe('R$ 1.250,00')
    expect(emReais(99999999n)).toBe('R$ 999.999,99')
    expect(emReais(123456789n)).toBe('R$ 1.234.567,89')
  })

  test('negativo carrega o sinal na frente do R$', () => {
    expect(emReais(-150n)).toBe('-R$ 1,50')
  })

  test('ida e volta: o que se formata se lê de volta igual', () => {
    for (const valor of [0n, 5n, 3990n, 125000n, 99999999n]) {
      // `emReais` produz "R$ x"; o campo recebe só o número, então o prefixo sai antes de ler.
      expect(lerDinheiro(emReais(valor).replace('R$ ', ''))).toBe(valor)
    }
  })
})

describe('somar e multiplicar', () => {
  test('lista vazia soma zero', () => {
    expect(somar([])).toBe(0n)
  })

  test('soma de lista', () => {
    expect(somar([3990n, 2500n, 10n])).toBe(6500n)
  })

  test('preço × quantidade é exato', () => {
    expect(multiplicar(3990n, 3)).toBe(11970n)
    expect(multiplicar(3990n, 0)).toBe(0n)
  })

  test('recusa quantidade inválida', () => {
    expect(() => multiplicar(3990n, 1.5)).toThrow(RangeError)
    expect(() => multiplicar(3990n, -1)).toThrow(RangeError)
    expect(() => multiplicar(3990n, NaN)).toThrow(RangeError)
  })
})

describe('EL-03 — nenhum number no caminho monetário', () => {
  test('todo retorno monetário é bigint', () => {
    expect(typeof somar([1n, 2n])).toBe('bigint')
    expect(typeof multiplicar(3990n, 3)).toBe('bigint')
    for (const parcela of repartir(6490n, 3)) expect(typeof parcela).toBe('bigint')
    expect(typeof lerDinheiro('39,90')).toBe('bigint')
    expect(typeof lerDinheiro('3990')).toBe('bigint')
    expect(typeof lerDinheiro('1.250')).toBe('bigint')
  })

  test('o inteiro que number não representa atravessa inteiro', () => {
    // 2^53 + 1 é o menor inteiro que `number` não representa; foi o marcador de E-00.
    const acimaDoNumber = 9007199254740993n
    expect(somar([acimaDoNumber])).toBe(acimaDoNumber)
    expect(somar(repartir(acimaDoNumber, 7))).toBe(acimaDoNumber)
    expect(lerDinheiro('90071992547409,93')).toBe(acimaDoNumber)
    expect(emReais(acimaDoNumber)).toBe('R$ 90.071.992.547.409,93')
  })
})
