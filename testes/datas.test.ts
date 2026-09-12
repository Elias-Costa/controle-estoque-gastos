import { describe, expect, test } from 'bun:test'
import { diaCurto, diasDeAtraso, diasEntre, hoje } from '../src/interface/datas.ts'

/** A borda de datas da tela (E-09): relógio local sem fuso, "dd/mm" como ela escreve, dias de atraso de RF-10. */

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
