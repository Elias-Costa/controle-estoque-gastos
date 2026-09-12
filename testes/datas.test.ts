import { describe, expect, test } from 'bun:test'
import { diaCurto, diasDeAtraso, diasDepois, diasEntre, hoje, mesesDepois } from '../src/interface/datas.ts'

/**
 * A borda de datas da tela (E-09, E-10): relógio local sem fuso, "dd/mm" como ela escreve,
 * dias de atraso de RF-10, "ontem" e a sugestão mensal das parcelas (RF-05).
 */

describe('hoje — pelo relógio do aparelho, campo a campo', () => {
  test('não passa pelo UTC: 23h59 do dia 12 em Brasília continua sendo dia 12', () => {
    // Construído em horário local: `toISOString()` daria o dia 13 quando o fuso é negativo.
    expect(hoje(new Date(2026, 8, 12, 23, 59))).toBe('2026-09-12')
  })

  test('mês e dia com dois dígitos', () => {
    expect(hoje(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('diaCurto — como ela escreve na fichinha', () => {
  test('"2026-09-28" vira "28/09"', () => {
    expect(diaCurto('2026-09-28')).toBe('28/09')
  })
})

describe('dias entre datas e dias de atraso (RF-10: "há quantos dias")', () => {
  test('conta dias inteiros, inclusive atravessando mês e ano', () => {
    expect(diasEntre('2026-09-01', '2026-09-09')).toBe(8)
    expect(diasEntre('2026-12-30', '2027-01-02')).toBe(3)
    expect(diasEntre('2026-09-09', '2026-09-01')).toBe(-8)
  })

  test('vencida há N dias; hoje ou no futuro é zero', () => {
    expect(diasDeAtraso('2026-09-04', '2026-09-12')).toBe(8)
    expect(diasDeAtraso('2026-09-12', '2026-09-12')).toBe(0)
    expect(diasDeAtraso('2026-09-20', '2026-09-12')).toBe(0)
  })
})

describe('diasDepois — "Ontem" na venda (RN-09)', () => {
  test('um dia para trás atravessa o mês e o ano', () => {
    expect(diasDepois('2026-09-12', -1)).toBe('2026-09-11')
    expect(diasDepois('2026-10-01', -1)).toBe('2026-09-30')
    expect(diasDepois('2027-01-01', -1)).toBe('2026-12-31')
    expect(diasDepois('2026-09-12', 0)).toBe('2026-09-12')
  })
})

describe('mesesDepois — a sugestão mensal das parcelas (RF-05), presa ao último dia do mês', () => {
  test('mesmo dia no mês seguinte quando ele existe', () => {
    expect(mesesDepois('2026-09-12', 1)).toBe('2026-10-12')
    expect(mesesDepois('2026-09-12', 4)).toBe('2027-01-12')
  })

  test('31/01 + 1 é 28/02, não 03/03; 31/03 + 1 é 30/04; 30/01 + 1 em ano bissexto é 29/02', () => {
    expect(mesesDepois('2026-01-31', 1)).toBe('2026-02-28')
    expect(mesesDepois('2026-03-31', 1)).toBe('2026-04-30')
    expect(mesesDepois('2028-01-30', 1)).toBe('2028-02-29')
  })

  test('o grampo não gruda: 31/01 + 2 volta a ser 31/03', () => {
    expect(mesesDepois('2026-01-31', 2)).toBe('2026-03-31')
  })
})
