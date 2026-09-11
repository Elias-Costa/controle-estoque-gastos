import { describe, expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { FORMATO_UUIDV7 } from '../src/dados/identidade.ts'
import {
  cadastrarCliente,
  corrigirLancamento,
  estornarLancamento,
  lancarSaldoAnterior,
  lancarVendaAVista,
  lancarVendaFiado,
  moverParaOutraCliente,
  quitar,
  receber,
  renegociar,
} from '../src/dados/operacoes.ts'
import { criarRepositorioLocal, type Repositorio } from '../src/dados/repositorio.ts'
import { repartir } from '../src/dominio/dinheiro.ts'
import { parcelas, saldo, type Cliente, type Resultado } from '../src/dominio/ficha.ts'

/**
 * As operações (E-05, D-040): o id nasce aqui em toda criação (D-029), a ficha é lida, o
 * domínio decide, e só o aceito é gravado — com item na fila. O que se prova neste arquivo e
 * em nenhum outro: **todo id persistido é UUIDv7** e **itens na fila === registros aceitos**.
 * IndexedDB de mentira, isolado por teste; nada aqui é afirmação sobre o WebKit.
 */

function preparar(): { banco: BancoLocal; repositorio: Repositorio } {
  const banco = new BancoLocal('teste', { indexedDB: new IDBFactory(), IDBKeyRange })
  return { banco, repositorio: criarRepositorioLocal(banco) }
}

function ok<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) throw new Error(`recusado: ${resultado.motivo}`)
  return resultado.valor
}

function motivo<T>(resultado: Resultado<T>): string {
  return resultado.ok ? 'ok' : resultado.motivo
}

async function vera(repositorio: Repositorio): Promise<Cliente> {
  return ok(await cadastrarCliente(repositorio, { nome: 'Vera' }))
}

/** Venda fiado de R$ 100,00 em 3× pela divisão automática (D-030): 33,40 / 33,30 / 33,30. */
async function vendaEm3x(repositorio: Repositorio, clienteId: string) {
  const valores = repartir(10000n, 3)
  const vencimentos = ['2026-10-01', '2026-11-01', '2026-12-01']
  return ok(
    await lancarVendaFiado(repositorio, {
      clienteId,
      data: '2026-09-01',
      itens: [{ descricao: 'perfume', preco: 10000n }],
      parcelas: valores.map((valor, i) => ({ valor, vencimento: vencimentos[i] ?? '2026-12-01' })),
    }),
  )
}

describe('todo id nasce aqui e é UUIDv7 (D-029, RI-04)', () => {
  test('cliente, vendas, saldo anterior, recebimento, quitação, estorno — e cada parcela', async () => {
    const { repositorio } = preparar()
    const cliente = await vera(repositorio)
    expect(cliente.id).toMatch(FORMATO_UUIDV7)

    const fiado = await vendaEm3x(repositorio, cliente.id)
    expect(fiado.id).toMatch(FORMATO_UUIDV7)
    for (const parcela of fiado.parcelas) expect(parcela.id).toMatch(FORMATO_UUIDV7)
    expect(new Set(fiado.parcelas.map((parcela) => parcela.id)).size).toBe(3)

    const avista = ok(await lancarVendaAVista(repositorio, { clienteId: cliente.id, data: '2026-09-02', itens: [{ descricao: 'batom', preco: 2500n }], forma: 'pix' }))
    expect(avista.id).toMatch(FORMATO_UUIDV7)

    const papel = ok(await lancarSaldoAnterior(repositorio, { clienteId: cliente.id, data: '2026-06-10', parcelas: [{ vencimento: '2026-09-10', valor: 4703n }] }))
    expect(papel.id).toMatch(FORMATO_UUIDV7)
    expect(papel.parcelas[0]?.id).toMatch(FORMATO_UUIDV7)

    const { recebimento } = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 4700n, forma: 'dinheiro' }))
    expect(recebimento.id).toMatch(FORMATO_UUIDV7)

    const estorno = ok(await estornarLancamento(repositorio, { clienteId: cliente.id, data: '2026-09-06', estornaId: avista.id }))
    expect(estorno.id).toMatch(FORMATO_UUIDV7)

    // Tudo que foi persistido tem id v7 — conferido na base, não no que a função devolveu.
    const ficha = await repositorio.lerFicha(cliente.id)
    expect(ficha).toHaveLength(5)
    for (const lancamento of ficha) expect(lancamento.id).toMatch(FORMATO_UUIDV7)
  })
})

describe('a ficha atravessa a base e continua batendo (RN-01, RN-02, RN-03)', () => {
  test('venda em 3×, dois recebimentos com troco no segundo: saldo e parcelas derivados do que foi gravado', async () => {
    const { banco, repositorio } = preparar()
    const cliente = await vera(repositorio)
    const fiado = await vendaEm3x(repositorio, cliente.id)
    expect(fiado.parcelas.map((parcela) => parcela.valor)).toEqual([3340n, 3330n, 3330n])

    const primeiro = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 5000n, forma: 'dinheiro' }))
    expect(primeiro.troco).toBe(0n)
    let ficha = await repositorio.lerFicha(cliente.id)
    expect(saldo(ficha)).toBe(5000n)
    expect(parcelas(ficha).map((item) => item.pago)).toEqual([3340n, 1660n, 0n])

    const segundo = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-20', valor: 6000n, forma: 'pix' }))
    expect(segundo.recebimento.valor).toBe(5000n)
    expect(segundo.troco).toBe(1000n)
    ficha = await repositorio.lerFicha(cliente.id)
    expect(saldo(ficha)).toBe(0n)
    expect(parcelas(ficha).every((item) => item.restante === 0n)).toBe(true)

    // Um cadastro, uma venda, dois recebimentos: quatro escritas, quatro itens.
    expect(await banco.fila.count()).toBe(4)
    expect(motivo(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-21', valor: 100n, forma: 'pix' }))).toBe('nada-a-receber')
    expect(await banco.fila.count()).toBe(4)
  })

  test('deve 47,03 e dá 47,00: considera pago, e o desconto fecha a ficha (RN-15, D-031)', async () => {
    const { repositorio } = preparar()
    const cliente = await vera(repositorio)
    ok(await lancarSaldoAnterior(repositorio, { clienteId: cliente.id, data: '2026-06-10', parcelas: [{ vencimento: '2026-09-10', valor: 4703n }] }))
    ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 4700n, forma: 'dinheiro' }))
    expect(motivo(await quitar(repositorio, { clienteId: cliente.id, data: '2026-09-05' }))).toBe('ok')
    expect(saldo(await repositorio.lerFicha(cliente.id))).toBe(0n)
    expect(motivo(await quitar(repositorio, { clienteId: cliente.id, data: '2026-09-05' }))).toBe('nada-a-quitar')
  })

  test('estorno do recebimento: a dívida volta; alvo inexistente é recusa sem gravação', async () => {
    const { banco, repositorio } = preparar()
    const cliente = await vera(repositorio)
    await vendaEm3x(repositorio, cliente.id)
    const { recebimento } = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 5000n, forma: 'dinheiro' }))
    ok(await estornarLancamento(repositorio, { clienteId: cliente.id, data: '2026-09-06', estornaId: recebimento.id, motivo: 'era da Maria' }))
    expect(saldo(await repositorio.lerFicha(cliente.id))).toBe(10000n)
    const antes = await banco.fila.count()
    expect(motivo(await estornarLancamento(repositorio, { clienteId: cliente.id, data: '2026-09-06', estornaId: 'nao-existe' }))).toBe('lancamento-nao-encontrado')
    expect(await banco.fila.count()).toBe(antes)
  })
})

describe('recusa não grava nada (RI-02 do lado certo: nada sobe que o domínio não aceitou)', () => {
  test('lançamento para cliente que não existe é recusado antes de qualquer gravação (D-040)', async () => {
    const { banco, repositorio } = preparar()
    expect(motivo(await lancarVendaFiado(repositorio, { clienteId: 'ninguem', data: '2026-09-01', itens: [{ descricao: 'x', preco: 100n }], parcelas: [{ vencimento: '2026-10-01', valor: 100n }] }))).toBe('cliente-nao-encontrado')
    expect(motivo(await lancarVendaAVista(repositorio, { clienteId: 'ninguem', data: '2026-09-01', itens: [{ descricao: 'x', preco: 100n }], forma: 'pix' }))).toBe('cliente-nao-encontrado')
    expect(motivo(await lancarSaldoAnterior(repositorio, { clienteId: 'ninguem', data: '2026-09-01', parcelas: [{ vencimento: '2026-10-01', valor: 100n }] }))).toBe('cliente-nao-encontrado')
    expect(motivo(await receber(repositorio, { clienteId: 'ninguem', data: '2026-09-01', valor: 100n, forma: 'pix' }))).toBe('cliente-nao-encontrado')
    expect(motivo(await quitar(repositorio, { clienteId: 'ninguem', data: '2026-09-01' }))).toBe('cliente-nao-encontrado')
    expect(motivo(await estornarLancamento(repositorio, { clienteId: 'ninguem', data: '2026-09-01', estornaId: 'x' }))).toBe('cliente-nao-encontrado')
    expect(await banco.lancamentos.count()).toBe(0)
    expect(await banco.fila.count()).toBe(0)
  })

  test('a recusa do domínio passa intacta: nome vazio, parcelas que não fecham', async () => {
    const { banco, repositorio } = preparar()
    expect(motivo(await cadastrarCliente(repositorio, { nome: '   ' }))).toBe('nome-obrigatorio')
    const cliente = await vera(repositorio)
    expect(
      motivo(await lancarVendaFiado(repositorio, { clienteId: cliente.id, data: '2026-09-01', itens: [{ descricao: 'x', preco: 100n }], parcelas: [{ vencimento: '2026-10-01', valor: 90n }] })),
    ).toBe('parcelas-nao-fecham')
    expect(await banco.clientes.count()).toBe(1)
    expect(await banco.fila.count()).toBe(1)
  })
})

describe('correções: a janela de D-013 entra como argumento; a fila não ganha segundo item', () => {
  test('corrigirLancamento: depois de sincronizado recusa sem gravar; antes, regrava a mesma linha', async () => {
    const { banco, repositorio } = preparar()
    const cliente = await vera(repositorio)
    await vendaEm3x(repositorio, cliente.id)
    const { recebimento } = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 500n, forma: 'dinheiro' }))
    expect(await banco.fila.count()).toBe(3)

    expect(motivo(await corrigirLancamento(repositorio, { ...recebimento, valor: 5000n }, { sincronizado: true }))).toBe('ja-sincronizado')
    expect(saldo(await repositorio.lerFicha(cliente.id))).toBe(9500n)

    const corrigido = ok(await corrigirLancamento(repositorio, { ...recebimento, valor: 5000n }, { sincronizado: false }))
    expect(corrigido.id).toBe(recebimento.id)
    expect(saldo(await repositorio.lerFicha(cliente.id))).toBe(5000n)
    expect(await banco.lancamentos.count()).toBe(2)
    expect(await banco.fila.count()).toBe(3)
  })

  test('renegociar: a parcela que ficou mantém o id; a nova ganha um UUIDv7', async () => {
    const { repositorio } = preparar()
    const cliente = await vera(repositorio)
    const fiado = await vendaEm3x(repositorio, cliente.id)
    ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 3340n, forma: 'dinheiro' }))
    const paga = fiado.parcelas[0]
    if (paga === undefined) throw new Error('sem parcela')

    const nova = ok(
      await renegociar(
        repositorio,
        { clienteId: cliente.id, debitoId: fiado.id, parcelas: [paga, { vencimento: '2026-12-15', valor: 6660n }] },
        { sincronizado: false },
      ),
    )
    expect(nova.parcelas.map((parcela) => parcela.id)[0]).toBe(paga.id)
    expect(nova.parcelas[1]?.id).toMatch(FORMATO_UUIDV7)
    expect(nova.parcelas[1]?.id).not.toBe(paga.id)
    expect(saldo(await repositorio.lerFicha(cliente.id))).toBe(6660n)
  })

  test('moverParaOutraCliente: a venda sai da ficha da Vera e entra na da Maria, com o mesmo id', async () => {
    const { banco, repositorio } = preparar()
    const cliente = await vera(repositorio)
    const maria = ok(await cadastrarCliente(repositorio, { nome: 'Maria' }))
    const fiado = await vendaEm3x(repositorio, cliente.id)
    expect(await banco.fila.count()).toBe(3)

    const movida = ok(await moverParaOutraCliente(repositorio, { lancamentoId: fiado.id, deClienteId: cliente.id, paraClienteId: maria.id }, { sincronizado: false }))
    expect(movida.id).toBe(fiado.id)
    expect(movida.clienteId).toBe(maria.id)
    expect(await repositorio.lerFicha(cliente.id)).toEqual([])
    expect(saldo(await repositorio.lerFicha(maria.id))).toBe(10000n)
    // A mesma linha, regravada: continua sendo um item só na fila.
    expect(await banco.fila.count()).toBe(3)

    expect(motivo(await moverParaOutraCliente(repositorio, { lancamentoId: fiado.id, deClienteId: maria.id, paraClienteId: 'ninguem' }, { sincronizado: false }))).toBe('cliente-nao-encontrado')
    expect(motivo(await moverParaOutraCliente(repositorio, { lancamentoId: fiado.id, deClienteId: maria.id, paraClienteId: cliente.id }, { sincronizado: true }))).toBe('ja-sincronizado')
    expect(saldo(await repositorio.lerFicha(maria.id))).toBe(10000n)
  })
})

describe('nenhuma escrita sem item na fila (RI-02, EL-01)', () => {
  test('ao fim de uma sequência com aceites e recusas, a fila tem exatamente um item por registro gravado', async () => {
    const { banco, repositorio } = preparar()
    const cliente = await vera(repositorio)
    const maria = ok(await cadastrarCliente(repositorio, { nome: 'Maria' }))
    const fiado = await vendaEm3x(repositorio, cliente.id)
    ok(await lancarVendaAVista(repositorio, { clienteId: maria.id, data: '2026-09-02', itens: [{ descricao: 'batom', preco: 2500n }], forma: 'pix' }))
    const { recebimento } = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 500n, forma: 'dinheiro' }))
    ok(await corrigirLancamento(repositorio, { ...recebimento, valor: 600n }, { sincronizado: false }))
    ok(await estornarLancamento(repositorio, { clienteId: cliente.id, data: '2026-09-06', estornaId: recebimento.id }))
    expect(motivo(await receber(repositorio, { clienteId: 'ninguem', data: '2026-09-07', valor: 1n, forma: 'pix' }))).toBe('cliente-nao-encontrado')
    expect(motivo(await estornarLancamento(repositorio, { clienteId: cliente.id, data: '2026-09-07', estornaId: fiado.id }))).toBe('ok')

    const registros = new Set([
      ...(await banco.clientes.toArray()).map((linha) => linha.id),
      ...(await banco.lancamentos.toArray()).map((linha) => linha.id),
    ])
    const fila = await banco.fila.toArray()
    expect(fila).toHaveLength(registros.size)
    expect(new Set(fila.map((item) => item.registroId))).toEqual(registros)
  })
})
