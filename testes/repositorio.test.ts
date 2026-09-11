import { describe, expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarRepositorioLocal, type Repositorio } from '../src/dados/repositorio.ts'
import type {
  Cliente,
  DescontoQuitacao,
  Estorno,
  Lancamento,
  Recebimento,
  SaldoAnterior,
  VendaAVista,
  VendaFiado,
} from '../src/dominio/ficha.ts'

/**
 * O repositório sobre a base local (E-05, D-040): ida e volta dos tipos do domínio sem
 * mapeamento, com `bigint` intacto; a ficha só da cliente; e a regra que fecha EL-01 do lado
 * local — **toda gravação deixa um item na fila, na mesma transação, e no máximo um por
 * registro**. IndexedDB de mentira, isolado por teste; nada aqui é afirmação sobre o WebKit.
 */

const GRANDE = 9007199254740993n // 2^53 + 1: o menor inteiro que `number` não representa

function preparar(): { banco: BancoLocal; repositorio: Repositorio } {
  const banco = new BancoLocal('teste', { indexedDB: new IDBFactory(), IDBKeyRange })
  let tique = 0
  const repositorio = criarRepositorioLocal(banco, () => `2026-09-11T10:00:0${tique++}.000Z`)
  return { banco, repositorio }
}

const vera: Cliente = { id: 'c-vera', nome: 'Vera', telefone: '(11) 9 8765-4321' }
const maria: Cliente = { id: 'c-maria', nome: 'Maria', apelido: 'do salão' }

const vendaFiado: VendaFiado = {
  tipo: 'venda',
  pagamento: 'fiado',
  id: 'v1',
  clienteId: 'c-vera',
  data: '2026-09-01',
  itens: [{ descricao: 'perfume', preco: 3990n }, { descricao: 'creme', preco: GRANDE }],
  desconto: 0n,
  parcelas: [{ id: 'p1', vencimento: '2026-10-01', valor: GRANDE }, { id: 'p2', vencimento: '2026-11-01', valor: 3990n }],
}
const vendaAVista: VendaAVista = {
  tipo: 'venda',
  pagamento: 'avista',
  id: 'v2',
  clienteId: 'c-vera',
  data: '2026-09-02',
  itens: [{ descricao: 'batom', preco: 2500n }],
  desconto: 500n,
  forma: 'pix',
}
const saldoAnterior: SaldoAnterior = {
  tipo: 'saldo-anterior',
  id: 's1',
  clienteId: 'c-maria',
  data: '2026-06-10',
  parcelas: [{ id: 's1-p1', vencimento: '2026-09-10', valor: 12000n }],
}
const recebimento: Recebimento = { tipo: 'recebimento', id: 'r1', clienteId: 'c-vera', data: '2026-09-05', valor: 3990n, forma: 'dinheiro', observacao: 'na feira' }
const desconto: DescontoQuitacao = { tipo: 'desconto-quitacao', id: 'd1', clienteId: 'c-vera', data: '2026-09-06', valor: 3n }
const estorno: Estorno = { tipo: 'estorno', id: 'e1', clienteId: 'c-vera', data: '2026-09-07', estornaId: 'r1', motivo: 'valor errado' }

describe('ida e volta sem mapeamento (D-040)', () => {
  test('cliente volta igual, com os campos opcionais que tinha', async () => {
    const { repositorio } = preparar()
    await repositorio.gravarCliente(vera)
    await repositorio.gravarCliente(maria)
    expect(await repositorio.lerCliente('c-vera')).toEqual(vera)
    expect(await repositorio.lerCliente('c-ninguem')).toBeUndefined()
    expect((await repositorio.listarClientes()).map((cliente) => cliente.nome).sort()).toEqual(['Maria', 'Vera'])
  })

  test('os cinco tipos de lançamento voltam iguais, e o dinheiro volta bigint exato — inclusive 2^53+1 numa parcela', async () => {
    const { repositorio } = preparar()
    const todos: Lancamento[] = [vendaFiado, vendaAVista, saldoAnterior, recebimento, desconto, estorno]
    for (const lancamento of todos) await repositorio.gravarLancamento(lancamento)

    // A ficha vem na ordem do índice (id); com UUIDv7 isso é a ordem de criação, mas estes
    // ids são de brinquedo — o domínio ordena o que precisa, então aqui a ordem não importa.
    const porId = (a: Lancamento, b: Lancamento) => a.id.localeCompare(b.id)
    const ficha = [...(await repositorio.lerFicha('c-vera'))].sort(porId)
    expect(ficha).toEqual([vendaFiado, vendaAVista, recebimento, desconto, estorno].sort(porId))
    const lida = ficha.find((lancamento) => lancamento.id === 'v1')
    if (lida?.tipo !== 'venda' || lida.pagamento !== 'fiado') throw new Error('a venda fiado não voltou como venda fiado')
    expect(typeof lida.parcelas[0]?.valor).toBe('bigint')
    expect(lida.parcelas[0]?.valor).toBe(GRANDE)
    expect(typeof lida.itens[1]?.preco).toBe('bigint')
    expect(typeof lida.desconto).toBe('bigint')
  })

  test('a ficha é só da cliente: o saldo anterior da Maria não aparece na da Vera', async () => {
    const { repositorio } = preparar()
    await repositorio.gravarLancamento(vendaFiado)
    await repositorio.gravarLancamento(saldoAnterior)
    expect((await repositorio.lerFicha('c-vera')).map((lancamento) => lancamento.id)).toEqual(['v1'])
    expect((await repositorio.lerFicha('c-maria')).map((lancamento) => lancamento.id)).toEqual(['s1'])
    expect(await repositorio.lerFicha('c-ninguem')).toEqual([])
  })
})

describe('a fila de sincronização acompanha toda gravação (RI-02, EL-01, D-040)', () => {
  test('cada gravação deixa exatamente um item, apontando para a tabela e o registro', async () => {
    const { banco, repositorio } = preparar()
    await repositorio.gravarCliente(vera)
    await repositorio.gravarLancamento(vendaFiado)
    await repositorio.gravarLancamento(recebimento)
    expect(await banco.fila.orderBy('ordem').toArray()).toEqual([
      { ordem: 1, tabela: 'clientes', registroId: 'c-vera', criadoEm: '2026-09-11T10:00:00.000Z' },
      { ordem: 2, tabela: 'lancamentos', registroId: 'v1', criadoEm: '2026-09-11T10:00:01.000Z' },
      { ordem: 3, tabela: 'lancamentos', registroId: 'r1', criadoEm: '2026-09-11T10:00:02.000Z' },
    ])
  })

  test('regravar o mesmo id substitui a linha (D-013) e NÃO cria segundo item: um pendente por registro', async () => {
    const { banco, repositorio } = preparar()
    await repositorio.gravarLancamento(recebimento)
    await repositorio.gravarLancamento({ ...recebimento, valor: 5000n })
    await repositorio.gravarCliente(vera)
    await repositorio.gravarCliente({ ...vera, telefone: '(11) 9 0000-0000' })

    const lido = await banco.lancamentos.get('r1')
    if (lido?.tipo !== 'recebimento') throw new Error('não voltou recebimento')
    expect(lido.valor).toBe(5000n)
    expect(await banco.lancamentos.count()).toBe(1)
    expect((await banco.clientes.get('c-vera'))?.telefone).toBe('(11) 9 0000-0000')

    const fila = await banco.fila.orderBy('ordem').toArray()
    expect(fila.map((item) => item.registroId)).toEqual(['r1', 'c-vera'])
    // O item guarda o instante da PRIMEIRA entrada: ele nunca saiu da fila.
    expect(fila[0]?.criadoEm).toBe('2026-09-11T10:00:00.000Z')
  })

  test('a ordem da fila é a ordem de entrada, atravessando tabelas', async () => {
    const { banco, repositorio } = preparar()
    await repositorio.gravarLancamento(saldoAnterior)
    await repositorio.gravarCliente(maria)
    await repositorio.gravarCliente(vera)
    await repositorio.gravarLancamento(vendaFiado)
    expect((await banco.fila.orderBy('ordem').toArray()).map((item) => `${item.tabela}/${item.registroId}`)).toEqual([
      'lancamentos/s1',
      'clientes/c-maria',
      'clientes/c-vera',
      'lancamentos/v1',
    ])
  })

  test('ler não enfileira nada', async () => {
    const { banco, repositorio } = preparar()
    await repositorio.gravarCliente(vera)
    await repositorio.lerCliente('c-vera')
    await repositorio.lerFicha('c-vera')
    await repositorio.listarClientes()
    expect(await banco.fila.count()).toBe(1)
  })
})

describe('o que o repositório não tem, de propósito', () => {
  test('não há apagar: correção é estorno ou substituição pelo mesmo id (RI-03, D-013)', () => {
    const { repositorio } = preparar()
    expect(Object.keys(repositorio).sort()).toEqual(['gravarCliente', 'gravarLancamento', 'lerCliente', 'lerFicha', 'listarClientes'])
  })
})
