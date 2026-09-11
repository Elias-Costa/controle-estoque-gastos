import { describe, expect, test } from 'bun:test'
import { FORMATO_UUIDV7, uuidv7 } from '../src/dados/identidade.ts'

/**
 * O id nasce no dispositivo, é UUIDv7 e ordena por tempo (D-029, RI-04). O que se prova
 * aqui é o formato e a ordem entre milissegundos — o que `ARCHITECTURE.md` registra como
 * limitação (sem ordem dentro do mesmo milissegundo) não é prometido e não é testado.
 */

/** Os 48 bits do instante, lidos de volta do texto do id. */
function instanteDoId(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
}

describe('uuidv7 (D-029)', () => {
  test('tem o formato v7: versão 7, variante 8–b, 36 caracteres', () => {
    const id = uuidv7()
    expect(id).toHaveLength(36)
    expect(id).toMatch(FORMATO_UUIDV7)
  })

  test('dez mil ids seguidos são todos distintos', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 10_000; i++) ids.add(uuidv7())
    expect(ids.size).toBe(10_000)
  })

  test('os 48 bits iniciais são o instante de criação', () => {
    const antes = Date.now()
    const id = uuidv7()
    const depois = Date.now()
    expect(instanteDoId(id)).toBeGreaterThanOrEqual(antes)
    expect(instanteDoId(id)).toBeLessThanOrEqual(depois)
    expect(instanteDoId(uuidv7(1_700_000_000_000))).toBe(1_700_000_000_000)
  })

  test('ordena por tempo: um id de um milissegundo depois é maior como texto', () => {
    const cedo = uuidv7(1000)
    const tarde = uuidv7(1001)
    expect(cedo < tarde).toBe(true)
    // E vale para a ordenação padrão de strings, que é a que a ficha e o índice usam.
    expect([tarde, cedo].sort()).toEqual([cedo, tarde])
  })

  test('instante inválido é erro de programador, não id errado', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError)
    expect(() => uuidv7(1.5)).toThrow(RangeError)
    expect(() => uuidv7(NaN)).toThrow(RangeError)
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError)
  })
})
