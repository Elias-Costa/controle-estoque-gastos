import { expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarOperacoesEstoque } from '../src/dados/operacoes-estoque.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { referenciaDoEfeito } from '../src/dominio/estoque.ts'
import { saldo } from '../src/dominio/ficha.ts'
import { conferirAjuste, efeitoDoAjuste, rascunhoDoAjuste } from '../src/interface/rascunho-do-ajuste.ts'
import { lerEstoque } from '../src/interface/leitura-de-estoque.ts'
import { MOTIVOS_DO_AJUSTE } from '../src/interface/palavras-do-estoque.ts'
import { compra, contagem, ok, produto } from './apoio-estoque.ts'

const base = { produtoId: 'perfume', motivo: 'perda', quantidadeTexto: '2', data: '2026-10-19' } as const

test('RF-14 exige motivo deliberado e distingue cada saída do total contado', () => {
  expect(rascunhoDoAjuste('perfume', base.data).motivo).toBe('')
  expect(conferirAjuste({ ...base, motivo: '' }, base.data)).toEqual({ ok: false, motivo: 'motivo-obrigatorio' })
  for (const { valor: motivo } of MOTIVOS_DO_AJUSTE) {
    const entrada = ok(conferirAjuste({ ...base, motivo }, base.data))
    expect(entrada).toEqual(motivo === 'conferencia'
      ? { tipo: 'contagem', produtoId: base.produtoId, data: base.data, totalContado: 2, motivo }
      : { tipo: 'saida', produtoId: base.produtoId, data: base.data, quantidade: 2, motivo })
  }
})

test('saída exige inteiro positivo; total contado admite zero, sem aceitar calendário inválido', () => {
  for (const quantidadeTexto of ['', '0', '-1', '1,5', '1.5', '2x', '9007199254740992']) {
    expect(conferirAjuste({ ...base, quantidadeTexto }, base.data)).toEqual({ ok: false, motivo: 'quantidade-invalida' })
  }
  expect(ok(conferirAjuste({ ...base, motivo: 'conferencia', quantidadeTexto: '0' }, base.data))).toMatchObject({ totalContado: 0 })
  for (const data of ['', '2026-02-30', '2026-10-20']) {
    expect(conferirAjuste({ ...base, data }, base.data)).toEqual({ ok: false, motivo: 'data-invalida' })
  }
  expect(ok(conferirAjuste({ ...base, data: '2024-02-29' }, base.data)).data).toBe('2024-02-29')
})

test('D-054 mostra os dois sentidos e correção da anotação mantém a base antiga', () => {
  const entrada = ok(conferirAjuste({ ...base, motivo: 'conferencia', quantidadeTexto: '7' }, base.data))
  expect(efeitoDoAjuste(entrada, 10)).toBe(-3)
  expect(efeitoDoAjuste(entrada, 5)).toBe(2)
  const original = contagem([compra()], 'c', 6)
  const rascunho = rascunhoDoAjuste('outro', base.data, original)
  expect(rascunho).toEqual({ produtoId: 'perfume', motivo: 'conferencia', quantidadeTexto: '6', data: original.data })
  expect(efeitoDoAjuste(entrada, 6, original)).toBe(-3)
})

test('contagens resolvidas ficam identificadas; nova conferência resolve disputa sem anular as anotações', () => {
  const p = compra(), a = contagem([p], 'a', 7), b = contagem([p], 'b', 7)
  const movimentos = [p, a, b]
  const estado = { clientes: [], produtos: [produto], movimentos, lancamentos: [], fila: [], operacoes: [], grupos: [], versoes: [], encerramentos: [], carimbo: 0n }
  expect(lerEstoque(estado, 'perfume')).toMatchObject({ fisico: 10, contagensAfetadas: true })
  const c = contagem(movimentos, 'c', 7)
  const leitura = lerEstoque({ ...estado, movimentos: [...movimentos, c] }, 'perfume')
  expect(leitura).toMatchObject({ fisico: 7, contagensAfetadas: false })
  for (const id of ['a', 'b']) expect(leitura.historico.find((item) => item.movimento.id === id)).toMatchObject({ resolvida: true, anulada: false, corrigivel: false })
  expect(leitura.historico.find((item) => item.movimento.id === 'c')).toMatchObject({ resolvida: false, corrigivel: true })
})

test('ajustes/correções não mudam ficha ou promessa; contagem compara físico e preserva histórico', async () => {
  const banco = new BancoLocal('ajustes-e26', { indexedDB: new IDBFactory(), IDBKeyRange })
  try {
    const repo = criarRepositorioEstoque(banco), ops = criarOperacoesEstoque(repo)
    const categoria = ok(await ops.cadastrarCategoria('Perfumes'))
    const p = ok(await ops.cadastrarProduto({ nome: 'Perfume', categoriaId: categoria.id, custoManual: 3000n }))
    await banco.clientes.put({ id: 'cliente', nome: 'Vera', atualizadoEm: '2026-10-19T10:00:00Z' })
    ok(await ops.registrarMovimento({ tipo: 'compra', produtoId: p.id, data: base.data, quantidade: 20, custoUnitario: 3335n }))
    ok(await ops.lancarVenda({ clienteId: 'cliente', data: base.data, desconto: 0n, pagamento: 'fiado',
      parcelas: [{ vencimento: '2026-11-19', valor: 5000n }], itens: [{ descricao: p.nome, produtoId: p.id, quantidade: 5, precoUnitario: 1000n, entregue: 2 }] }))
    const financeiro = (await repo.lerEstado()).lancamentos
    expect(saldo(financeiro)).toBe(5000n)
    const ajustes = []
    for (const motivo of ['perda', 'quebra', 'uso-pessoal', 'brinde'] as const) {
      ajustes.push(ok(await ops.registrarMovimento(ok(conferirAjuste({ ...base, produtoId: p.id, motivo }, base.data)))))
    }
    expect(lerEstoque(await repo.lerEstado(), p.id)).toMatchObject({ fisico: 10, prometido: 3, custo: 3335n })
    const original = ajustes[0]!.movimentos[0]!
    const corrigido = ok(await ops.corrigirRegistroMovimento(referenciaDoEfeito(original), {
      tipo: 'saida', produtoId: p.id, quantidade: 3, motivo: 'quebra', data: '2026-10-18',
    }))
    expect(corrigido.movimentos[0]).toMatchObject({ id: original.id, revisao: 2, motivo: 'quebra' })
    const envio = await repo.capturarEnvio(corrigido.operacao.id)
    if (!envio) throw new Error('sem envio')
    await repo.responderEnvio(envio)
    expect(await ops.corrigirRegistroMovimento(referenciaDoEfeito(original), {
      tipo: 'saida', produtoId: p.id, quantidade: 1, motivo: 'perda', data: base.data,
    })).toEqual({ ok: false, motivo: 'alvo-invalido' })
    ok(await ops.corrigirRegistroMovimento(referenciaDoEfeito(corrigido.movimentos[0]!), {
      tipo: 'saida', produtoId: p.id, quantidade: 1, motivo: 'perda', data: base.data,
    }))
    let leitura = lerEstoque(await repo.lerEstado(), p.id)
    expect(leitura).toMatchObject({ fisico: 11, prometido: 3 })
    expect(leitura.historico.find((item) => item.movimento.id === original.id && item.movimento.revisao === 2)).toMatchObject({ anulada: true, corrigivel: false })
    expect(leitura.historico.filter((item) => item.movimento.tipo === 'anulacao')).toHaveLength(1)
    const c = ok(await ops.registrarMovimento({ tipo: 'contagem', produtoId: p.id, totalContado: 7, motivo: 'conferencia', data: base.data }))
    expect(lerEstoque(await repo.lerEstado(), p.id)).toMatchObject({ fisico: 7, prometido: 3 })
    const revisada = ok(await ops.corrigirRegistroMovimento(referenciaDoEfeito(c.movimentos[0]!), {
      tipo: 'contagem', produtoId: p.id, totalContado: 12, motivo: 'conferencia', data: base.data,
    }))
    const movimento = revisada.movimentos[0]!
    expect(movimento.tipo === 'contagem' && movimento.base).toEqual(c.movimentos[0]!.tipo === 'contagem' && c.movimentos[0]!.base)
    leitura = lerEstoque(await repo.lerEstado(), p.id)
    expect(leitura).toMatchObject({ fisico: 12, prometido: 3, custo: 3335n })
    expect((await repo.lerEstado()).lancamentos).toEqual(financeiro)
    expect(leitura.historico.find((item) => item.movimento.tipo === 'entrega')?.movimento).toMatchObject({ custoUnitario: 3335n })
  } finally { banco.close() }
})
