import { describe, expect, test } from 'bun:test'
import { palavrasDoEstado } from '../src/interface/palavras-do-envio.ts'
import type { EstadoDaSincronizacao } from '../src/sincronizacao/sincronizacao.ts'

/** As palavras do indicador (RF-25, RI-07, D-042 item 6) — hipótese até E-15, mas o mapeamento é fixo. */

const base: EstadoDaSincronizacao = { pendentes: 0, comProblema: 0, enviando: false, sessao: true, ultimaFalha: null, ultimoSucessoEm: null }

describe('palavras do indicador', () => {
  test.each<[Partial<EstadoDaSincronizacao>, string]>([
    [{}, 'Tudo em dia'],
    [{ enviando: true, pendentes: 3 }, 'Enviando…'],
    [{ pendentes: 3 }, '3 para enviar'],
    [{ pendentes: 3, sessao: false, ultimaFalha: 'sessao' }, '3 para enviar'],
    [{ pendentes: 3, ultimaFalha: 'rede' }, '3 para enviar'],
    [{ comProblema: 1 }, '1 com problema'],
    [{ pendentes: 2, comProblema: 1 }, '2 para enviar · 1 com problema'],
    [{ enviando: true, pendentes: 2, comProblema: 1 }, 'Enviando… · 1 com problema'],
  ])('%j → %s', (mudanca, esperado) => {
    expect(palavrasDoEstado({ ...base, ...mudanca })).toBe(esperado)
  })

  test('nenhuma palavra técnica: sem "sincroniz", "nuvem", "servidor", "erro", "rede", "sessão" (RI-07)', () => {
    const estados: Partial<EstadoDaSincronizacao>[] = [{}, { enviando: true }, { pendentes: 1 }, { comProblema: 1 }, { pendentes: 1, ultimaFalha: 'rede' }, { sessao: false, pendentes: 1 }]
    for (const mudanca of estados) {
      expect(palavrasDoEstado({ ...base, ...mudanca }).toLowerCase()).not.toMatch(/sincroniz|nuvem|servidor|erro|rede|sess/)
    }
  })
})
