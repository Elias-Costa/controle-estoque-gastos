import { expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarOperacoesEstoque } from '../src/dados/operacoes-estoque.ts'
import { criarRepositorioEstoque, type EstadoLocalEstoque } from '../src/dados/repositorio-estoque.ts'
import { lerProdutosNoMinimo } from '../src/interface/produtos-no-minimo.ts'
import { compra, contagem, item, ok, produto, venda } from './apoio-estoque.ts'

const estado: EstadoLocalEstoque = { produtos: [], movimentos: [], lancamentos: [], operacoes: [], grupos: [], fila: [], clientes: [], carimbo: 0n }

test('RF-15 inclui abaixo/no limite, exclui acima e vazio, e conserva zero explícito e falta', () => {
  for (const { fisico, prometido, minimo, entra } of [
    { fisico: 3, prometido: 2, minimo: 2, entra: true },
    { fisico: 4, prometido: 2, minimo: 2, entra: true },
    { fisico: 5, prometido: 2, minimo: 2, entra: false },
    { fisico: 0, prometido: 2, minimo: undefined, entra: false },
    { fisico: 2, prometido: 2, minimo: 0, entra: true },
    { fisico: 0, prometido: 2, minimo: 0, entra: true },
    { fisico: 3, prometido: 2, minimo: 0, entra: false },
  ]) {
    const linhas = lerProdutosNoMinimo({ ...estado, produtos: [{ ...produto, estoqueMinimo: minimo }],
      movimentos: fisico > 0 ? [compra('c', fisico)] : [], lancamentos: [venda('v', [item('i', prometido)])] })
    expect(linhas.length).toBe(entra ? 1 : 0)
    if (entra) expect(linhas[0]).toMatchObject({ fisico, prometido, disponivel: Math.max(0, fisico - prometido), falta: Math.max(0, prometido - fisico) })
  }
  expect(lerProdutosNoMinimo(estado)).toEqual([])
})

test('leitura ordena por nome/id, sinaliza contagem afetada e recusa posição inválida', () => {
  const p = compra(), a = contagem([p], 'a', 7), b = contagem([p], 'b', 7)
  const produtos = [{ ...produto, estoqueMinimo: 10 }, { ...produto, id: 'a', nome: 'Água', estoqueMinimo: 0 },
    { ...produto, id: 'b', nome: 'Água', estoqueMinimo: 0 }]
  const linhas = lerProdutosNoMinimo({ ...estado, produtos: [...produtos].reverse(), movimentos: [p, a, b] })
  expect(linhas.map((linha) => linha.produto.id)).toEqual(['a', 'b', produto.id])
  expect(linhas[2]).toMatchObject({ fisico: 10, contagensAfetadas: true })
  expect(() => lerProdutosNoMinimo({ ...estado, produtos, movimentos: [{ ...p, quantidade: -1 }] })).toThrow()
})

test('lista relida acompanha compra, venda, entrega, cancelamento, retorno, saída, contagem e mínimo alterado', async () => {
  const banco = new BancoLocal('minimo-e27', { indexedDB: new IDBFactory(), IDBKeyRange })
  try {
    const repo = criarRepositorioEstoque(banco), ops = criarOperacoesEstoque(repo)
    const categoria = ok(await ops.cadastrarCategoria('Perfumes'))
    const p = ok(await ops.cadastrarProduto({ nome: 'Perfume', categoriaId: categoria.id, estoqueMinimo: 2 }))
    await banco.clientes.put({ id: 'cliente', nome: 'Vera', atualizadoEm: '2026-10-20T10:00:00Z' })
    const ler = async () => lerProdutosNoMinimo(await repo.lerEstado())
    expect(await ler()).toHaveLength(1)
    ok(await ops.registrarMovimento({ tipo: 'compra', produtoId: p.id, quantidade: 5, data: '2026-10-20' }))
    expect(await ler()).toHaveLength(0)
    const grupo = ok(await ops.lancarVenda({ clienteId: 'cliente', data: '2026-10-20', pagamento: 'fiado', desconto: 0n,
      parcelas: [{ vencimento: '2026-11-20', valor: 4000n }], itens: [{ descricao: p.nome, produtoId: p.id, quantidade: 4, entregue: 1, precoUnitario: 1000n }] }))
    const v = grupo.lancamentos.find((l) => l.tipo === 'venda')
    const itemId = v?.tipo === 'venda' ? v.itens[0]?.id : undefined
    if (!v || !itemId) throw new Error('sem venda/item')
    expect((await ler())[0]).toMatchObject({ fisico: 4, prometido: 3, disponivel: 1 })
    ok(await ops.entregar({ vendaId: v.id, itemId, quantidade: 2, data: v.data }))
    expect((await ler())[0]).toMatchObject({ fisico: 2, prometido: 1, disponivel: 1 })
    ok(await ops.cancelarVenda(v.id, v.data, [{ itemId, quantidade: 0 }]))
    expect((await ler())[0]).toMatchObject({ fisico: 2, prometido: 0, disponivel: 2 })
    ok(await ops.registrarRetorno(v.id, v.data, [{ itemId, quantidade: 1 }]))
    expect(await ler()).toHaveLength(0)
    ok(await ops.registrarMovimento({ tipo: 'saida', motivo: 'perda', produtoId: p.id, quantidade: 1, data: v.data }))
    expect((await ler())[0]).toMatchObject({ fisico: 2, prometido: 0 })
    ok(await ops.registrarMovimento({ tipo: 'contagem', motivo: 'conferencia', produtoId: p.id, totalContado: 6, data: v.data }))
    expect(await ler()).toHaveLength(0)
    ok(await ops.alterarProduto({ ...p, estoqueMinimo: 6 }))
    expect(await ler()).toHaveLength(1)
    ok(await ops.alterarProduto({ ...p, estoqueMinimo: undefined }))
    expect(await ler()).toHaveLength(0)
    ok(await ops.alterarProduto({ ...p, estoqueMinimo: 0 }))
    expect(await ler()).toHaveLength(0)
    ok(await ops.registrarMovimento({ tipo: 'contagem', motivo: 'conferencia', produtoId: p.id, totalContado: 0, data: v.data }))
    expect((await ler())[0]).toMatchObject({ fisico: 0, prometido: 0, disponivel: 0 })
  } finally { banco.close() }
})
