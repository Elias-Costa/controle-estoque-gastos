import { describe, expect, test } from 'bun:test'
import { avaliarLembretes, calendarioLembretes, haLembretes, observacaoInicialLembretes, registrarRodadaLembretes,
  type FotografiaLembretes } from '../src/dominio/lembretes.ts'
import { compra, produto, venda } from './apoio-estoque.ts'

const vazio: FotografiaLembretes = { clientes: [], lancamentos: [], produtos: [], movimentos: [], fatosCaixa: [] }
function avaliar(fontes: Partial<FotografiaLembretes>, instante = '2026-10-31T12:00:00Z', anterior = observacaoInicialLembretes()) {
  return avaliarLembretes({ ...vazio, ...fontes }, anterior, instante)
}

describe('D-068/079: motivos e relógio sem efeito financeiro', () => {
  test('Fortaleza independe do fuso do aparelho e separa virada e oportunidades', () => {
    expect(calendarioLembretes('2026-11-01T02:59:59Z').dia).toBe('2026-10-31')
    expect(calendarioLembretes('2026-11-01T03:00:00Z').dia).toBe('2026-11-01')
    for (const [instante, oportunidade] of [['11:59:59', null], ['12:00:00', '09:00'], ['12:15:00', '09:15'],
      ['12:30:00', '09:30'], ['12:31:00', null], ['23:00:00', null]] as const) {
      expect(calendarioLembretes(`2026-10-31T${instante}Z`).oportunidade).toBe(oportunidade)
    }
    expect(calendarioLembretes('2026-10-31T12:00:00Z').venceEm).toBe('2026-10-31T13:00:00.000Z')
  })
  test('sem motivo não gera aviso; dia 1 usa mês anterior inclusive virada de ano e centavos grandes', () => {
    expect(haLembretes(avaliar({}).motivos)).toBe(false)
    const resultado = avaliar({ fatosCaixa: [{ id: 'g', revisao: 1, tipo: 'despesa', data: '2026-12-31',
      valor: 900719925474099301n, categoria: 'Teste', classificacao: 'pessoal', mercadoria: false }] }, '2027-01-01T03:00:00Z')
    expect(resultado.motivos.caixa?.tudo).toEqual({ entrou: 0n, saiu: 900719925474099301n, diferenca: -900719925474099301n })
    expect(resultado.motivos.caixa?.mes).toBe('2026-12')
    expect(haLembretes(resultado.motivos)).toBe(true)
  })
  test('parcelas somente até hoje, saldo restante e ficha ativa; pagamento e estorno reavaliados', () => {
    const debito = venda()
    const fontes = { clientes: [{ id: 'cliente' }], lancamentos: [debito] }
    expect(avaliar(fontes).motivos.fichas).toEqual([])
    expect(avaliar(fontes, '2026-11-01T12:00:00Z').motivos.fichas).toEqual([{ clienteId: 'cliente', vencimento: '2026-11-01' }])
    expect(avaliar({ ...fontes, clientes: [{ id: 'cliente', desativadoEm: '2026-10-31' }] }, '2026-11-02T12:00:00Z').motivos.fichas).toEqual([])
    const pagamento = { id: 'p', clienteId: 'cliente', data: '2026-11-01', tipo: 'recebimento', valor: 15000n, forma: 'pix' } as const
    expect(avaliar({ ...fontes, lancamentos: [debito, pagamento] }, '2026-11-02T12:00:00Z').motivos.fichas).toEqual([])
    expect(avaliar({ ...fontes, lancamentos: [debito, pagamento, { id: 'e', tipo: 'estorno', clienteId: 'cliente',
      data: '2026-11-02', estornaId: 'p' }] }, '2026-11-02T12:00:00Z').motivos.fichas).toHaveLength(1)
  })
  test('mínimo ausente não participa; zero e físico menos promessa mantêm sua semântica', () => {
    expect(avaliar({ produtos: [produto] }).motivos.minimo).toEqual([])
    expect(avaliar({ produtos: [{ ...produto, estoqueMinimo: 0 }] }).motivos.minimo).toEqual([{ produtoId: produto.id, conferir: false }])
    expect(avaliar({ produtos: [{ ...produto, estoqueMinimo: 7 }], movimentos: [compra()], lancamentos: [venda()] }).motivos.minimo).toHaveLength(1)
    expect(avaliar({ produtos: [{ ...produto, estoqueMinimo: 6 }], movimentos: [compra()], lancamentos: [venda()] }).motivos.minimo).toHaveLength(0)
  })
  test('entrada, permanência, saída e reentrada observadas; repetição diária só na segunda', () => {
    const fontes = { produtos: [{ ...produto, estoqueMinimo: 0 }] }
    const primeira = avaliar(fontes)
    const consumida = registrarRodadaLembretes(primeira.observacao, primeira.motivos)
    expect(avaliar(fontes, '2026-10-31T23:00:00Z', consumida).motivos.minimo).toHaveLength(1)
    expect(avaliar(fontes, '2026-11-01T12:00:00Z', consumida).motivos.minimo).toHaveLength(0)
    expect(avaliar(fontes, '2026-11-02T12:00:00Z', consumida).motivos.minimo).toHaveLength(1)
    const fora = avaliar({ ...fontes, movimentos: [compra()] }, '2026-11-01T12:00:00Z', consumida)
    expect(fora.observacao.baixos).toEqual([])
    expect(avaliar(fontes, '2026-11-01T12:00:00Z', fora.observacao).motivos.minimo).toHaveLength(1)
  })
  test('entrada permanece pendente se nenhuma rodada começou e sai antes da rodada', () => {
    const fontes = { produtos: [{ ...produto, estoqueMinimo: 0 }] }
    const antes = avaliar(fontes)
    expect(avaliar(fontes, '2026-11-03T12:00:00Z', antes.observacao).motivos.minimo).toHaveLength(1)
    const depois = avaliar({ ...fontes, movimentos: [compra()] }, '2026-11-03T12:00:00Z', antes.observacao)
    expect(depois.observacao.pendentes).toEqual([])
    expect(depois.motivos.minimo).toEqual([])
  })
})
