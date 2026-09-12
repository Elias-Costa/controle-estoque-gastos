import { describe, expect, test } from 'bun:test'
import type { ClienteLocal } from '../src/dados/banco.ts'
import type { Lancamento } from '../src/dominio/ficha.ts'
import {
  clienteDaNuvem,
  clienteParaNuvem,
  lancamentoDaNuvem,
  lancamentoParaNuvem,
  normalizarCarimbo,
  type LancamentoNaNuvem,
} from '../src/sincronizacao/borda.ts'

/**
 * A borda (E-07, D-041, D-042): o que vai para a nuvem e o que volta é o mesmo objeto do
 * domínio, campo a campo — `bigint` exato como texto de dígitos, `snake_case` nas colunas,
 * `null` na ida e campo ausente na volta, carimbo normalizado. E o que não tem forma **lança**,
 * em vez de virar um lançamento estranho na ficha dela.
 */

const GRANDE = 9007199254740993n // 2^53 + 1: o que `number` não representa

const cliente: ClienteLocal = { id: 'c1', nome: 'Vera', telefone: '(11) 9 8765-4321', atualizadoEm: '2026-09-12T10:05:00.000Z' }

const vendaFiado: Lancamento = {
  tipo: 'venda',
  pagamento: 'fiado',
  id: 'v1',
  clienteId: 'c1',
  data: '2026-09-01',
  itens: [{ descricao: 'perfume', preco: 3990n }, { descricao: 'creme', preco: GRANDE }],
  desconto: 5n,
  parcelas: [{ id: 'p1', vencimento: '2026-10-01', valor: GRANDE }, { id: 'p2', vencimento: '2026-11-01', valor: 3985n }],
}
const vendaAVista: Lancamento = { tipo: 'venda', pagamento: 'avista', id: 'v2', clienteId: 'c1', data: '2026-09-02', itens: [{ descricao: 'batom', preco: 2500n }], desconto: 0n, forma: 'pix' }
const saldoAnterior: Lancamento = { tipo: 'saldo-anterior', id: 's1', clienteId: 'c1', data: '2026-06-10', parcelas: [{ id: 's1-p1', vencimento: '2026-09-10', valor: 12000n }] }
const recebimentoComObs: Lancamento = { tipo: 'recebimento', id: 'r1', clienteId: 'c1', data: '2026-09-05', valor: 3990n, forma: 'dinheiro', observacao: 'na feira' }
const recebimentoSemObs: Lancamento = { tipo: 'recebimento', id: 'r2', clienteId: 'c1', data: '2026-09-05', valor: 1n, forma: 'outro' }
const desconto: Lancamento = { tipo: 'desconto-quitacao', id: 'd1', clienteId: 'c1', data: '2026-09-06', valor: 3n }
const estornoComMotivo: Lancamento = { tipo: 'estorno', id: 'e1', clienteId: 'c1', data: '2026-09-07', estornaId: 'r1', motivo: 'valor errado' }
const estornoSemMotivo: Lancamento = { tipo: 'estorno', id: 'e2', clienteId: 'c1', data: '2026-09-07', estornaId: 'r2' }

describe('cliente', () => {
  test('ida: snake_case, opcional ausente vira null, atualizado_em é o carimbo do aparelho', () => {
    expect(clienteParaNuvem(cliente)).toEqual({
      id: 'c1',
      nome: 'Vera',
      telefone: '(11) 9 8765-4321',
      apelido: null,
      observacao: null,
      atualizado_em: '2026-09-12T10:05:00.000Z',
    })
  })

  test('volta: o que era null some, e o carimbo +00:00 do PostgREST vira Z — comparável como texto', () => {
    const lido = clienteDaNuvem({ ...clienteParaNuvem(cliente), atualizado_em: '2026-09-12T10:05:00+00:00', recebido_em: 'ignorado' })
    expect(lido).toEqual(cliente)
    expect(Object.keys(lido).sort()).toEqual(['atualizadoEm', 'id', 'nome', 'telefone'])
  })

  test('ida e volta é identidade para os campos opcionais presentes', () => {
    const completo: ClienteLocal = { ...cliente, apelido: 'do salão', observacao: 'paga no dia 10' }
    expect(clienteDaNuvem(clienteParaNuvem(completo))).toEqual(completo)
  })
})

describe('lançamento: ida e volta dos cinco tipos', () => {
  const todos = [vendaFiado, vendaAVista, saldoAnterior, recebimentoComObs, recebimentoSemObs, desconto, estornoComMotivo, estornoSemMotivo]

  test.each(todos.map((lancamento): [string, Lancamento] => [`${lancamento.tipo}/${lancamento.id}`, lancamento]))(
    '%s volta igual ao que foi, com bigint exato',
    (_nome, lancamento) => {
      expect(lancamentoDaNuvem(lancamentoParaNuvem(lancamento))).toEqual(lancamento)
    },
  )

  test('a venda fiado vai com as colunas do tipo, as outras nulas, dinheiro como texto de dígitos', () => {
    expect(lancamentoParaNuvem(vendaFiado)).toEqual({
      id: 'v1',
      cliente_id: 'c1',
      data: '2026-09-01',
      tipo: 'venda',
      pagamento: 'fiado',
      forma: null,
      itens: [{ descricao: 'perfume', preco: '3990' }, { descricao: 'creme', preco: '9007199254740993' }],
      desconto: '5',
      parcelas: [{ id: 'p1', vencimento: '2026-10-01', valor: '9007199254740993' }, { id: 'p2', vencimento: '2026-11-01', valor: '3985' }],
      valor: null,
      observacao: null,
      estorna_id: null,
      motivo: null,
    })
  })

  test('o estorno vai com estorna_id e nada de dinheiro; o recebimento com valor e forma', () => {
    const estorno = lancamentoParaNuvem(estornoSemMotivo)
    expect(estorno.estorna_id).toBe('r2')
    expect(estorno.valor).toBeNull()
    expect(estorno.motivo).toBeNull()
    const recebimento = lancamentoParaNuvem(recebimentoComObs)
    expect(recebimento).toMatchObject({ valor: '3990', forma: 'dinheiro', observacao: 'na feira', itens: null, parcelas: null })
  })

  test('2^53+1 atravessa como texto e volta bigint — nunca number', () => {
    const volta = lancamentoDaNuvem(lancamentoParaNuvem(vendaFiado))
    if (volta.tipo !== 'venda' || volta.pagamento !== 'fiado') throw new Error('tipo trocado')
    expect(typeof volta.parcelas[0]?.valor).toBe('bigint')
    expect(volta.parcelas[0]?.valor).toBe(GRANDE)
    expect(volta.itens[1]?.preco).toBe(GRANDE)
    expect(typeof volta.desconto).toBe('bigint')
  })

  test('colunas a mais que a nuvem devolve (dono, criado_em) são ignoradas', () => {
    const linha = { ...lancamentoParaNuvem(desconto), dono: 'x', criado_em: '2026-09-12T00:00:00+00:00' }
    expect(lancamentoDaNuvem(linha)).toEqual(desconto)
  })
})

describe('o que não tem forma lança, em vez de virar lançamento estranho', () => {
  const recebimento = lancamentoParaNuvem(recebimentoSemObs)

  test.each<[string, Partial<Record<keyof LancamentoNaNuvem, unknown>>]>([
    ['dinheiro com ponto', { valor: '39.9' }],
    ['dinheiro negativo', { valor: '-1' }],
    ['dinheiro como número JSON', { valor: 3990 }],
    ['dinheiro vazio', { valor: '' }],
    ['tipo desconhecido', { tipo: 'compra' }],
    ['forma desconhecida', { forma: 'cheque' }],
    ['id ausente', { id: null }],
  ])('%s', (_nome, mudanca) => {
    expect(() => lancamentoDaNuvem({ ...recebimento, ...mudanca })).toThrow(/malformada/)
  })

  test('venda com pagamento desconhecido; parcela com valor não inteiro; item sem descrição', () => {
    const venda = lancamentoParaNuvem(vendaFiado)
    expect(() => lancamentoDaNuvem({ ...venda, pagamento: 'cartao' })).toThrow(/lancamento\.pagamento/)
    expect(() => lancamentoDaNuvem({ ...venda, parcelas: [{ id: 'p1', vencimento: '2026-10-01', valor: '1.5' }] })).toThrow(/parcelas\[0\]\.valor/)
    expect(() => lancamentoDaNuvem({ ...venda, itens: [{ preco: '10' }] })).toThrow(/itens\[0\]\.descricao/)
  })

  test('cliente sem nome; carimbo que não é data; linha que não é objeto', () => {
    expect(() => clienteDaNuvem({ id: 'c1', nome: null, atualizado_em: '2026-09-12T10:05:00Z' })).toThrow(/cliente\.nome/)
    expect(() => clienteDaNuvem({ id: 'c1', nome: 'Vera', atualizado_em: 'ontem' })).toThrow(/atualizado_em/)
    expect(() => clienteDaNuvem(null)).toThrow(/malformada/)
    expect(() => lancamentoDaNuvem('texto')).toThrow(/malformada/)
  })

  test('normalizarCarimbo: +00:00, Z e microssegundos viram o mesmo ISO com milissegundos', () => {
    expect(normalizarCarimbo('x', '2026-09-12T10:05:00+00:00')).toBe('2026-09-12T10:05:00.000Z')
    expect(normalizarCarimbo('x', '2026-09-12T10:05:00.123456+00:00')).toBe('2026-09-12T10:05:00.123Z')
    expect(normalizarCarimbo('x', '2026-09-12T07:05:00-03:00')).toBe('2026-09-12T10:05:00.000Z')
  })
})
