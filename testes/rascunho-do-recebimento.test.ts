import { describe, expect, test } from 'bun:test'
import type { Ficha, Resultado } from '../src/dominio/ficha.ts'
import { novoSaldoAnterior, registrarRecebimento } from '../src/dominio/lancamentos.ts'
import { diaDoQuando, quandoDe } from '../src/interface/datas.ts'
import { botaoRecebi, fraseDaGuardaDoRecebimento, fraseDoTroco, linhasDoRecebido, tituloDoRecebimento } from '../src/interface/palavras-do-recebimento.ts'
import { guardaDaData } from '../src/interface/rascunho-da-venda.ts'
import {
  conferirRecebimento,
  observacaoDe,
  rascunhoDoRecebimento,
  saldoParaCorrigir,
  type RascunhoDoRecebimento,
} from '../src/interface/rascunho-do-recebimento.ts'

/**
 * O recebimento enquanto ela digita (E-11, D-046): o que entra na ficha e o que volta como
 * troco (RN-03, D-016), as guardas visíveis antes do toque, o saldo que a correção pode abater
 * e o caminho de volta (recebimento gravado → rascunho). Tudo em `bigint`; `hoje` fixado.
 */

const HOJE = '2026-09-14'

function ok<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) throw new Error(`recusado: ${resultado.motivo}`)
  return resultado.valor
}

function rascunho(valorTexto: string, resto: Partial<RascunhoDoRecebimento> = {}): RascunhoDoRecebimento {
  return { valorTexto, forma: 'dinheiro', observacao: '', data: HOJE, ...resto }
}

/** Deve R$ 47,03 desde o caderno (o caso de D-031). */
const fichaDe4703: Ficha = [ok(novoSaldoAnterior({ id: 's1', clienteId: 'c1', data: '2026-08-01', parcelas: [{ id: 'p1', vencimento: '2026-09-01', valor: 4703n }] }))]

describe('conferirRecebimento — o que entra e o que volta (RN-03, D-016)', () => {
  test('deve 47,00 e manda 50: anota 47,00 e o troco é 3,00 — antes de confirmar', () => {
    const conferencia = conferirRecebimento(rascunho('50,00'), 4700n, HOJE)
    expect(conferencia).toEqual({ valor: 5000n, registrado: 4700n, troco: 300n, guardas: [] })
  })

  test('abaixo do saldo não tem troco; igual ao saldo também não', () => {
    expect(conferirRecebimento(rascunho('30,00'), 4700n, HOJE)).toMatchObject({ registrado: 3000n, troco: 0n })
    expect(conferirRecebimento(rascunho('47,00'), 4700n, HOJE)).toMatchObject({ registrado: 4700n, troco: 0n })
  })

  test('o texto é lido pelo domínio (D-034): "47,03" é literal, "4703" é pela direita, "50" é R$ 0,50', () => {
    expect(conferirRecebimento(rascunho('47,03'), 4703n, HOJE).valor).toBe(4703n)
    expect(conferirRecebimento(rascunho('4703'), 4703n, HOJE).valor).toBe(4703n)
    expect(conferirRecebimento(rascunho('50'), 4703n, HOJE).valor).toBe(50n)
  })

  test('guardas: vazio e zero são "sem valor"; letras são ilegível; sem dia; dia no futuro', () => {
    expect(conferirRecebimento(rascunho(''), 4700n, HOJE).guardas).toEqual(['sem-valor'])
    expect(conferirRecebimento(rascunho('0'), 4700n, HOJE)).toMatchObject({ registrado: 0n, troco: 0n, guardas: ['sem-valor'] })
    expect(conferirRecebimento(rascunho('abc'), 4700n, HOJE)).toMatchObject({ valor: null, registrado: 0n, troco: 0n, guardas: ['valor-ilegivel'] })
    expect(conferirRecebimento(rascunho('47,00', { data: '' }), 4700n, HOJE).guardas).toEqual(['falta-a-data'])
    expect(conferirRecebimento(rascunho('47,00', { data: '2026-09-15' }), 4700n, HOJE).guardas).toEqual(['data-no-futuro'])
    expect(conferirRecebimento(rascunho('', { data: '' }), 4700n, HOJE).guardas).toEqual(['sem-valor', 'falta-a-data'])
  })

  test('guardaDaData é a mesma regra da venda e do recebimento', () => {
    expect(guardaDaData('', HOJE)).toBe('falta-a-data')
    expect(guardaDaData('2026-09-15', HOJE)).toBe('data-no-futuro')
    expect(guardaDaData(HOJE, HOJE)).toBeNull()
    expect(guardaDaData('2026-09-01', HOJE)).toBeNull()
  })
})

describe('a correção de um recebimento (D-013, D-046)', () => {
  test('o saldo para corrigir é a ficha sem o original: o que ele abateu volta a estar em aberto', () => {
    const { recebimento } = ok(registrarRecebimento(fichaDe4703, { id: 'r1', clienteId: 'c1', data: HOJE, valor: 4000n, forma: 'pix' }))
    const ficha: Ficha = [...fichaDe4703, recebimento]
    expect(saldoParaCorrigir(ficha, 'r1')).toBe(4703n)
    // Corrigir 40,00 para 50,00: anota 47,03 e o troco é 2,97 — contra o saldo sem o original.
    expect(conferirRecebimento(rascunho('50,00'), saldoParaCorrigir(ficha, 'r1'), HOJE)).toMatchObject({ registrado: 4703n, troco: 297n })
  })

  test('ida e volta: o recebimento gravado vira o rascunho que a tela preenche', () => {
    const { recebimento } = ok(registrarRecebimento(fichaDe4703, { id: 'r1', clienteId: 'c1', data: '2026-09-13', valor: 4000n, forma: 'pix', observacao: 'metade' }))
    expect(rascunhoDoRecebimento(recebimento)).toEqual({ valorTexto: '40,00', forma: 'pix', observacao: 'metade', data: '2026-09-13' })
    const semObservacao = ok(registrarRecebimento(fichaDe4703, { id: 'r2', clienteId: 'c1', data: HOJE, valor: 703n, forma: 'dinheiro' })).recebimento
    expect(rascunhoDoRecebimento(semObservacao).observacao).toBe('')
  })

  test('observação em branco não é observação', () => {
    expect(observacaoDe(rascunho('1', { observacao: '   ' }))).toBeUndefined()
    expect(observacaoDe(rascunho('1', { observacao: ' metade ' }))).toBe('metade')
  })
})

describe('"Quando foi" (extraído da venda em E-11)', () => {
  test('hoje, ontem ou outro dia a partir de uma data gravada; e a data de volta', () => {
    expect(quandoDe(undefined, HOJE)).toEqual({ escolha: 'hoje', outroDia: '' })
    expect(quandoDe(HOJE, HOJE)).toEqual({ escolha: 'hoje', outroDia: '' })
    expect(quandoDe('2026-09-13', HOJE)).toEqual({ escolha: 'ontem', outroDia: '' })
    expect(quandoDe('2026-09-01', HOJE)).toEqual({ escolha: 'outro', outroDia: '2026-09-01' })
    expect(diaDoQuando({ escolha: 'hoje', outroDia: '' }, HOJE)).toBe(HOJE)
    expect(diaDoQuando({ escolha: 'ontem', outroDia: '' }, HOJE)).toBe('2026-09-13')
    expect(diaDoQuando({ escolha: 'outro', outroDia: '2026-09-01' }, HOJE)).toBe('2026-09-01')
    expect(diaDoQuando({ escolha: 'outro', outroDia: '' }, HOJE)).toBe('')
  })

  test('a última data digitada preenche "Outro dia" do lançamento novo, e só dele; o padrão continua "Hoje" (D-049, RN-09)', () => {
    expect(quandoDe(undefined, HOJE, '2026-08-20')).toEqual({ escolha: 'hoje', outroDia: '2026-08-20' })
    expect(diaDoQuando(quandoDe(undefined, HOJE, '2026-08-20'), HOJE)).toBe(HOJE)
    // A correção mostra a data gravada, nunca a lembrada.
    expect(quandoDe('2026-09-01', HOJE, '2026-08-20')).toEqual({ escolha: 'outro', outroDia: '2026-09-01' })
    expect(quandoDe(HOJE, HOJE, '2026-08-20')).toEqual({ escolha: 'hoje', outroDia: '' })
  })
})

describe('as palavras do recebimento (RI-07, protótipo de 2026-09-08)', () => {
  test('o botão da ficha, o título, o troco e a confirmação', () => {
    expect(botaoRecebi(3000n)).toBe('Recebi R$ 30,00')
    expect(tituloDoRecebimento('Dona Rosa')).toBe('Recebi da Dona Rosa')
    expect(fraseDoTroco(300n)).toBe('Troco de R$ 3,00')
    expect(linhasDoRecebido('Rosa', 3000n, 3000n)).toEqual(['Anotado: R$ 30,00 da Rosa', 'Ainda deve R$ 30,00'])
    expect(linhasDoRecebido('Rosa', 4700n, 0n)).toEqual(['Anotado: R$ 47,00 da Rosa', 'Ela não deve mais nada'])
  })

  test('só as guardas de data viram frase: o campo e o botão indisponível já dizem o resto', () => {
    expect(fraseDaGuardaDoRecebimento('sem-valor')).toBeNull()
    expect(fraseDaGuardaDoRecebimento('valor-ilegivel')).toBeNull()
    expect(fraseDaGuardaDoRecebimento('falta-a-data')).toBe('Falta o dia')
    expect(fraseDaGuardaDoRecebimento('data-no-futuro')).toBe('Esse dia ainda não chegou')
  })
})
