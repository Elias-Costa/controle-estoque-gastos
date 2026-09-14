import { describe, expect, test } from 'bun:test'
import { somar } from '../src/dominio/dinheiro.ts'
import type { Resultado, SaldoAnterior } from '../src/dominio/ficha.ts'
import { novoSaldoAnterior } from '../src/dominio/lancamentos.ts'
import { fraseDaGuardaDoSaldoAnterior } from '../src/interface/palavras-do-saldo-anterior.ts'
import {
  conferirSaldoAnterior,
  datasAPartirDe,
  rascunhoDoSaldoAnterior,
  type RascunhoDoSaldoAnterior,
} from '../src/interface/rascunho-do-saldo-anterior.ts'

/**
 * O saldo anterior enquanto ela digita (E-14, RF-07, D-049): o valor lido pelo domínio, as
 * parcelas a partir de "vence em" com a regra da venda (a editada fica, as outras absorvem),
 * as guardas visíveis antes do toque, e o caminho de volta (saldo gravado → rascunho da
 * correção). Tudo em `bigint`; `hoje` fixado.
 */

const HOJE = '2026-09-14'

function ok<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) throw new Error(`recusado: ${resultado.motivo}`)
  return resultado.valor
}

function rascunho(mudanca: Partial<RascunhoDoSaldoAnterior> = {}): RascunhoDoSaldoAnterior {
  return { valorTexto: '300,00', desde: '2026-06-01', venceEm: '2026-10-05', vezes: 1, edicoes: [], ...mudanca }
}

describe('as datas a partir de "vence em" (D-049, item 2)', () => {
  test('a primeira é a própria; as seguintes de mês em mês, presas ao último dia do mês', () => {
    expect(datasAPartirDe('2026-10-05', 3)).toEqual(['2026-10-05', '2026-11-05', '2026-12-05'])
    expect(datasAPartirDe('2026-01-31', 3)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
    expect(datasAPartirDe('2026-10-05', 1)).toEqual(['2026-10-05'])
  })
})

describe('conferir: valor, parcelas e guardas', () => {
  test('uma parcela, como D-044: o valor inteiro vence em "vence em"', () => {
    const conferencia = conferirSaldoAnterior(rascunho(), HOJE)
    expect(conferencia.valor).toBe(30000n)
    expect(conferencia.parcelas.map((p) => [p.vencimento, p.valor])).toEqual([['2026-10-05', 30000n]])
    expect(conferencia.guardas).toEqual([])
  })

  test('em 3×: divisão de D-030 a partir de "vence em"; a editada fica e as outras absorvem (D-045)', () => {
    const tres = conferirSaldoAnterior(rascunho({ vezes: 3 }), HOJE)
    expect(tres.parcelas.map((p) => [p.vencimento, p.valor])).toEqual([
      ['2026-10-05', 10000n],
      ['2026-11-05', 10000n],
      ['2026-12-05', 10000n],
    ])
    const combinada = conferirSaldoAnterior(rascunho({ vezes: 3, edicoes: [{ valorTexto: '50,00' }] }), HOJE)
    expect(combinada.parcelas.map((p) => p.valor)).toEqual([5000n, 12500n, 12500n])
    expect(somar(combinada.parcelas.map((p) => p.valor))).toBe(30000n)
    expect(combinada.guardas).toEqual([])
  })

  test('sem valor ou valor zero é "nada a anotar", e nenhuma outra guarda aparece; valor ilegível é só isso', () => {
    expect(conferirSaldoAnterior(rascunho({ valorTexto: '' , desde: '', venceEm: '' }), HOJE).guardas).toEqual(['sem-valor'])
    expect(conferirSaldoAnterior(rascunho({ valorTexto: '0' }), HOJE).guardas).toEqual(['sem-valor'])
    expect(conferirSaldoAnterior(rascunho({ valorTexto: 'trezentos', desde: '' }), HOJE).guardas).toEqual(['valor-ilegivel'])
    expect(conferirSaldoAnterior(rascunho({ valorTexto: '0' }), HOJE).parcelas).toEqual([])
  })

  test('"desde" é a data do fato (RN-09): falta ou futuro travam; "vence em" pode ser futuro, mas não pode faltar', () => {
    expect(conferirSaldoAnterior(rascunho({ desde: '' }), HOJE).guardas).toEqual(['falta-a-data'])
    expect(conferirSaldoAnterior(rascunho({ desde: '2026-09-15' }), HOJE).guardas).toEqual(['data-no-futuro'])
    expect(conferirSaldoAnterior(rascunho({ venceEm: '2027-01-01' }), HOJE).guardas).toEqual([])
    const semVencimento = conferirSaldoAnterior(rascunho({ venceEm: '' }), HOJE)
    expect(semVencimento.guardas).toEqual(['falta-o-vencimento'])
    expect(semVencimento.parcelas).toEqual([])
  })

  test('parcelas que não fecham o total e parcela ilegível são guardas, nunca gravação (EL-02)', () => {
    const editouTodas = conferirSaldoAnterior(rascunho({ vezes: 2, edicoes: [{ valorTexto: '100,00' }, { valorTexto: '100,00' }] }), HOJE)
    expect(editouTodas.guardas).toEqual(['parcelas-nao-fecham'])
    expect(fraseDaGuardaDoSaldoAnterior('parcelas-nao-fecham', somar(editouTodas.parcelas.map((p) => p.valor)), editouTodas.valor)).toBe(
      'As parcelas somam R$ 200,00; o saldo é R$ 300,00',
    )
    expect(conferirSaldoAnterior(rascunho({ vezes: 2, edicoes: [{ valorTexto: 'cem' }] }), HOJE).guardas).toEqual(['parcela-ilegivel'])
  })

  test('toda guarda tem frase, menos "sem-valor" (RI-07)', () => {
    expect(fraseDaGuardaDoSaldoAnterior('sem-valor', 0n, 0n)).toBeNull()
    for (const guarda of ['valor-ilegivel', 'falta-a-data', 'data-no-futuro', 'falta-o-vencimento', 'parcela-ilegivel', 'parcelas-nao-fecham'] as const) {
      expect(fraseDaGuardaDoSaldoAnterior(guarda, 0n, 0n)).not.toBeNull()
    }
  })
})

describe('o caminho de volta: saldo gravado → rascunho da correção (D-013, D-049)', () => {
  test('valor total como texto, "desde" da data, "vence em" da 1ª, datas editadas, valor só quando difere da divisão', () => {
    const papel: SaldoAnterior = ok(
      novoSaldoAnterior({
        id: 's1',
        clienteId: 'c1',
        data: '2026-06-01',
        parcelas: [
          { id: 'p1', vencimento: '2026-10-05', valor: 10000n },
          { id: 'p2', vencimento: '2026-11-20', valor: 10000n },
          { id: 'p3', vencimento: '2026-12-05', valor: 10000n },
        ],
      }),
    )
    const volta = rascunhoDoSaldoAnterior(papel)
    expect(volta).toEqual({
      valorTexto: '300,00',
      desde: '2026-06-01',
      venceEm: '2026-10-05',
      vezes: 3,
      edicoes: [{ vencimento: '2026-10-05' }, { vencimento: '2026-11-20' }, { vencimento: '2026-12-05' }],
    })
    // Reconferido, dá as mesmas parcelas — nada muda só por abrir a correção.
    const reconferido = conferirSaldoAnterior(volta, HOJE)
    expect(reconferido.parcelas.map((p) => [p.vencimento, p.valor])).toEqual([
      ['2026-10-05', 10000n],
      ['2026-11-20', 10000n],
      ['2026-12-05', 10000n],
    ])
    expect(reconferido.guardas).toEqual([])

    // Parcelas combinadas à mão (50 / 125 / 125): as três diferem da divisão e entram como editadas.
    const combinado = rascunhoDoSaldoAnterior({
      ...papel,
      parcelas: papel.parcelas.map((parcela, posicao) => ({ ...parcela, valor: posicao === 0 ? 5000n : 12500n })),
    })
    expect(combinado.edicoes.map((e) => e.valorTexto)).toEqual(['50,00', '125,00', '125,00'])
    expect(conferirSaldoAnterior(combinado, HOJE).parcelas.map((p) => p.valor)).toEqual([5000n, 12500n, 12500n])
  })
})
