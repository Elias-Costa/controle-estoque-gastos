import { describe, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal, ESQUEMA_V2, type Problema } from '../src/dados/banco.ts'
import { criarOperacoesEstoque, type EntradaVendaLocal } from '../src/dados/operacoes-estoque.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { criarRepositorioLocal } from '../src/dados/repositorio.ts'
import { FORMATO_UUIDV7 } from '../src/dados/identidade.ts'
import { saldo } from '../src/dominio/ficha.ts'
import { projetarEstoque } from '../src/dominio/estoque.ts'
import { custoDoProduto } from '../src/dominio/produtos.ts'
import { prepararCancelamento, prepararMovimentosEstoque, type GrupoEstoque, type VendaEstoque } from '../src/dominio/vendas-estoque.ts'
import { ok } from './apoio-estoque.ts'

const AGORA = '2026-10-18T10:00:00.000Z'
const PROBLEMA: Problema = { codigo: '23000', mensagem: 'conteúdo divergente', em: AGORA }

async function preparar() {
  const indexedDB = new IDBFactory()
  const banco = new BancoLocal('estoque', { indexedDB, IDBKeyRange })
  let instante = AGORA
  let avisos = 0
  const repositorio = criarRepositorioEstoque(banco, () => instante, () => { avisos++ })
  const operacoes = criarOperacoesEstoque(repositorio)
  await banco.clientes.put({ id: 'cliente', nome: 'Vera', atualizadoEm: AGORA })
  const categoria = ok(await operacoes.cadastrarCategoria('Perfumes'))
  const produto = ok(await operacoes.cadastrarProduto({ nome: 'Perfume', categoriaId: categoria.id, custoManual: 2500n, precoVenda: 5000n }))
  return { banco, indexedDB, repositorio, operacoes, produto, categoria, avisos: () => avisos,
    relogio: (valor: string) => { instante = valor } }
}

type Ambiente = Awaited<ReturnType<typeof preparar>>

function entradaVenda(produtoId: string, quantidade = 3, entregue = 1): EntradaVendaLocal {
  return { clienteId: 'cliente', data: '2026-10-18', desconto: 0n, pagamento: 'fiado',
    parcelas: [{ vencimento: '2026-11-18', valor: BigInt(quantidade) * 5000n }],
    itens: [{ descricao: 'Perfume', produtoId, quantidade, precoUnitario: 5000n, entregue }] }
}

function vendaDoGrupo(grupo: GrupoEstoque): VendaEstoque {
  const venda = grupo.lancamentos[0]
  if (!venda || venda.tipo !== 'venda') throw new Error('sem venda')
  const itens = venda.itens.map((item) => {
    if (!item.id || item.quantidade === undefined || item.precoUnitario === undefined) throw new Error('item sem identidade F2')
    return { ...item, id: item.id, quantidade: item.quantidade, precoUnitario: item.precoUnitario }
  })
  return { ...venda, itens }
}

async function fisico(a: Ambiente) { return ok(projetarEstoque(await a.banco.movimentos.toArray(), a.produto.id)).fisico }
async function compra(a: Ambiente, quantidade = 10, custoUnitario: bigint | undefined = 3000n) {
  return ok(await a.operacoes.registrarMovimento({ tipo: 'compra', produtoId: a.produto.id, data: '2026-10-18', quantidade, custoUnitario }))
}
async function envio(a: Ambiente, grupo: GrupoEstoque) {
  const capturado = await a.repositorio.capturarEnvio(grupo.operacao.id)
  if (!capturado) throw new Error('sem envio')
  return capturado
}
async function aceitar(a: Ambiente, grupo: GrupoEstoque) { await a.repositorio.responderEnvio(await envio(a, grupo)) }

describe('persistência F2 — lógica IndexedDB simulada, não prova de aparelho', () => {
  test('upgrade v2 preserva ficha, dinheiro, fila com problema e cursores; não inventa produtos', async () => {
    const indexedDB = new IDBFactory()
    const antiga = new Dexie('upgrade', { indexedDB, IDBKeyRange })
    antiga.version(2).stores(ESQUEMA_V2)
    const cliente = { id: 'c', nome: 'Vera', desativadoEm: '2026-09-18', atualizadoEm: AGORA }
    const lancamento = { tipo: 'saldo-anterior', id: 'saldo', clienteId: 'c', data: '2026-09-01',
      parcelas: [{ id: 'parcela', valor: 9007199254740993n, vencimento: '2026-11-18' }] } as const
    const fila = { ordem: 7, tabela: 'lancamentos', registroId: 'saldo', criadoEm: AGORA, versao: 3, problema: PROBLEMA } as const
    const cursor = { chave: 'lancamentos', valor: AGORA } as const
    await antiga.table('clientes').put(cliente)
    await antiga.table('lancamentos').put(lancamento)
    await antiga.table('fila').put(fila)
    await antiga.table('sincronizacao').put(cursor)
    antiga.close()
    const atual = new BancoLocal('upgrade', { indexedDB, IDBKeyRange })
    await atual.open()
    expect(atual.verno).toBe(8)
    expect(await atual.clientes.get('c')).toEqual(cliente)
    expect(await atual.lancamentos.get('saldo')).toEqual(lancamento)
    expect(await atual.fila.toArray()).toEqual([fila])
    expect(await atual.sincronizacao.toArray()).toEqual([cursor])
    expect(await atual.produtos.count()).toBe(0)
    expect(await atual.operacoes.count()).toBe(0)
    atual.close()
  })

  test('categoria conhecida é reutilizada e abas concorrentes não criam duplicata local', async () => {
    const a = await preparar()
    const outraAba = new BancoLocal('estoque', { indexedDB: a.indexedDB, IDBKeyRange })
    const outro = criarRepositorioEstoque(outraAba)
    const antes = a.avisos()
    const [primeira, segunda] = await Promise.all([a.operacoes.cadastrarCategoria(' perfumes '), outro.cadastrarCategoria('PERFUMES')])
    expect(ok(primeira).id).toBe(a.categoria.id)
    expect(ok(segunda).id).toBe(a.categoria.id)
    expect(await a.banco.categorias.count()).toBe(1)
    expect(a.avisos()).toBe(antes)
    expect((await a.banco.fila.toArray()).map((item) => item.tabela)).toEqual(['categorias', 'produtos'])
    outraAba.close(); a.banco.close()
  })

  test('produto exige categoria existente; vazio e zero permanecem distintos, com fila única e LWW inteiro', async () => {
    const a = await preparar()
    expect(await a.operacoes.cadastrarProduto({ nome: 'X', categoriaId: 'ausente' })).toEqual({ ok: false, motivo: 'categoria-inexistente' })
    const gratuito = ok(await a.operacoes.cadastrarProduto({ nome: 'Amostra', categoriaId: a.categoria.id, precoVenda: 0n, estoqueMinimo: 0 }))
    const vazio = ok(await a.operacoes.cadastrarProduto({ nome: 'Sem preço', categoriaId: a.categoria.id }))
    expect((await a.banco.produtos.get(gratuito.id))?.precoVenda).toBe(0n)
    expect((await a.banco.produtos.get(vazio.id))?.precoVenda).toBeUndefined()
    a.relogio('2026-10-18T11:00:00.000Z')
    ok(await a.operacoes.alterarProduto({ ...a.produto, nome: 'Novo', marca: 'Marca' }))
    expect((await a.banco.produtos.get(a.produto.id))?.atualizadoEm).toBe('2026-10-18T11:00:00.000Z')
    expect(await a.banco.fila.where('registroId').equals(a.produto.id).count()).toBe(1)
    a.banco.close()
  })

  test('venda, baixa e uma fila por operação sobrevivem à reabertura sem rede (RT-11 local)', async () => {
    const a = await preparar()
    await compra(a)
    const grupo = ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id)))
    const venda = vendaDoGrupo(grupo)
    expect(await fisico(a)).toBe(9)
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(15000n)
    expect(await a.banco.fila.where('registroId').equals(venda.id).count()).toBe(0)
    expect(await a.banco.fila.where('registroId').equals(grupo.operacao.id).count()).toBe(1)
    for (const id of [grupo.operacao.id, venda.id, ...venda.itens.map((item) => item.id), ...grupo.movimentos.map((item) => item.id)]) expect(id).toMatch(FORMATO_UUIDV7)
    a.banco.close()
    const reaberto = new BancoLocal('estoque', { indexedDB: a.indexedDB, IDBKeyRange })
    const repo = criarRepositorioEstoque(reaberto)
    expect((await repo.capturarEnvio(grupo.operacao.id))?.versao.grupo).toEqual(grupo)
    expect(ok(projetarEstoque(await reaberto.movimentos.toArray(), a.produto.id)).fisico).toBe(9)
    reaberto.close()
  })

  test('falha ao enfileirar aborta financeiro, estoque, manifesto, evidência e carimbo; não avisa', async () => {
    const a = await preparar()
    await compra(a)
    const antes = { lancamentos: await a.banco.lancamentos.toArray(), movimentos: await a.banco.movimentos.toArray(),
      operacoes: await a.banco.operacoes.toArray(), versoes: await a.banco.versoesEstoque.toArray(),
      fila: await a.banco.fila.toArray(), relogio: await a.banco.relogioEstoque.toArray(), avisos: a.avisos() }
    // Força colisão de chave no IndexedDB depois dos efeitos, sem depender de exceção de hook.
    const falhar = () => 1
    a.banco.fila.hook('creating', falhar)
    let falhou = false
    try { await a.operacoes.lancarVenda(entradaVenda(a.produto.id)) } catch { falhou = true }
    a.banco.fila.hook('creating').unsubscribe(falhar)
    expect(falhou).toBe(true)
    expect(await a.banco.lancamentos.toArray()).toEqual(antes.lancamentos)
    expect(await a.banco.movimentos.toArray()).toEqual(antes.movimentos)
    expect(await a.banco.operacoes.toArray()).toEqual(antes.operacoes)
    expect(await a.banco.versoesEstoque.toArray()).toEqual(antes.versoes)
    expect(await a.banco.fila.toArray()).toEqual(antes.fila)
    expect(await a.banco.relogioEstoque.toArray()).toEqual(antes.relogio)
    expect(a.avisos()).toBe(antes.avisos)
    a.banco.close()
  })

  test('leitura e validação serializam entregas concorrentes em duas abas', async () => {
    const a = await preparar()
    await compra(a)
    const venda = vendaDoGrupo(ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id, 1, 0))))
    const itemId = venda.itens[0]?.id
    if (!itemId) throw new Error('sem item')
    const outraAba = new BancoLocal('estoque', { indexedDB: a.indexedDB, IDBKeyRange })
    const outro = criarOperacoesEstoque(criarRepositorioEstoque(outraAba))
    const entrada = { vendaId: venda.id, itemId, data: '2026-10-18', quantidade: 1 }
    const resultados = await Promise.all([a.operacoes.entregar(entrada), outro.entregar(entrada)])
    expect(resultados.filter((item) => item.ok)).toHaveLength(1)
    expect(resultados.filter((item) => !item.ok)).toEqual([{ ok: false, motivo: 'excede-pendencia' }])
    expect(await fisico(a)).toBe(9)
    outraAba.close(); a.banco.close()
  })

  test('carimbo cresce com relógio igual/recuando, abas e máximo restaurado', async () => {
    const a = await preparar()
    const primeira = await compra(a)
    a.relogio('2026-10-17T10:00:00.000Z')
    const outraAba = new BancoLocal('estoque', { indexedDB: a.indexedDB, IDBKeyRange })
    const outro = criarOperacoesEstoque(criarRepositorioEstoque(outraAba, () => '2026-10-17T10:00:00.000Z'))
    const [segunda, terceira] = await Promise.all([compra(a), outro.registrarMovimento({ tipo: 'compra', produtoId: a.produto.id, data: '2026-10-18', quantidade: 1 })])
    const ordens = [primeira, segunda, ok(terceira)].flatMap((grupo) => grupo.movimentos.filter((item) => item.tipo === 'compra').map((item) => item.ordemCadastro))
    expect(new Set(ordens).size).toBe(3)
    expect(ordens.slice(1).every((item) => item > (ordens[0] ?? 0n))).toBe(true)
    await a.banco.relogioEstoque.clear()
    const quarta = await compra(a)
    const movimento = quarta.movimentos[0]
    if (movimento?.tipo !== 'compra') throw new Error('sem compra')
    expect(ordens.every((item) => movimento.ordemCadastro > item)).toBe(true)
    outraAba.close(); a.banco.close()
  })

  test('corrigir entrada local retém r1 para a contagem e mantém carimbo original (Q39/42)', async () => {
    const a = await preparar()
    const grupo = await compra(a)
    const original = grupo.movimentos[0]
    if (original?.tipo !== 'compra') throw new Error('sem compra')
    ok(await a.operacoes.registrarMovimento({ tipo: 'contagem', produtoId: a.produto.id, data: '2026-10-18', motivo: 'conferencia', totalContado: 7 }))
    const corrigida = ok(await a.operacoes.corrigirRegistroMovimento(original, { tipo: 'compra', produtoId: a.produto.id, data: original.data, quantidade: 8, custoUnitario: 3100n }))
    expect(corrigida.operacao.revisao).toBe(2)
    expect(corrigida.movimentos[0]).toMatchObject({ id: original.id, revisao: 2, ordemCadastro: original.ordemCadastro })
    expect(await a.banco.movimentos.get([original.id, 1])).toEqual(original)
    const projecao = ok(projetarEstoque(await a.banco.movimentos.toArray(), a.produto.id))
    expect(projecao.fisico).toBe(8)
    expect(projecao.contagensAfetadas).toHaveLength(1)
    expect(await a.banco.fila.where('registroId').equals(grupo.operacao.id).count()).toBe(1)
    a.banco.close()
  })

  test('após aceite, correção de compra é inverso/substituto com ordem original', async () => {
    const a = await preparar()
    const grupo = await compra(a)
    await aceitar(a, grupo)
    const original = grupo.movimentos[0]
    if (original?.tipo !== 'compra') throw new Error('sem compra')
    const corrigida = ok(await a.operacoes.corrigirRegistroMovimento(original, { tipo: 'compra', produtoId: a.produto.id, data: original.data, quantidade: 8, custoUnitario: 3100n }))
    expect(corrigida.movimentos).toHaveLength(2)
    expect(corrigida.movimentos.find((item) => item.tipo === 'compra')).toMatchObject({ ordemCadastro: original.ordemCadastro, compraOriginalId: original.id })
    expect(await fisico(a)).toBe(8)
    expect(await a.banco.movimentos.get([original.id, 1])).toEqual(original)
    a.banco.close()
  })

  test('envio antigo confirma só a revisão capturada; edição continua completa e recusa fica visível', async () => {
    const a = await preparar()
    await compra(a)
    const inicial = ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id)))
    const capturado = await envio(a, inicial)
    const venda = vendaDoGrupo(inicial)
    const entrada = { ...entradaVenda(a.produto.id), itens: venda.itens.map((item) => ({ ...item, entregue: 1, precoUnitario: 4000n })),
      pagamento: 'fiado', parcelas: [{ id: venda.pagamento === 'fiado' ? venda.parcelas[0]?.id ?? 'erro' : 'erro', valor: 12000n, vencimento: '2026-11-18' }] } as const
    const revista = ok(await a.operacoes.corrigirVenda(venda.id, entrada, { data: '2026-10-18', natureza: 'financeira' }))
    expect(revista.operacao.revisao).toBe(2)
    expect(revista.movimentos).toEqual(inicial.movimentos)
    await a.repositorio.responderEnvio(capturado)
    expect((await a.banco.fila.where('registroId').equals(inicial.operacao.id).first())?.versao).toBe(2)
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(12000n)
    const novoEnvio = await envio(a, revista)
    await a.repositorio.responderEnvio(novoEnvio, PROBLEMA)
    expect((await a.banco.fila.where('registroId').equals(inicial.operacao.id).first())?.problema).toEqual(PROBLEMA)
    const resolvida = ok(await a.repositorio.encerrar(novoEnvio.versao.id, { data: '2026-10-18', confirmado: true, intencaoPendente: false }))
    expect(resolvida.evidencia.grupo).toEqual(revista)
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(15000n)
    expect(await fisico(a)).toBe(9)
    expect(await a.banco.lancamentos.get(venda.id)).toEqual(venda)
    await a.repositorio.responderEnvio(novoEnvio, PROBLEMA)
    expect(await a.banco.fila.where('registroId').equals(inicial.operacao.id).count()).toBe(0)
    a.banco.close()
  })

  test('mesmos ids e revisão com conteúdo aceito diferente sobrevivem ao encerramento e à reabertura', async () => {
    const a = await preparar()
    const inicial = await compra(a)
    await aceitar(a, inicial)
    const grupo = ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id)))
    const capturado = await envio(a, grupo)
    const venda = vendaDoGrupo(grupo)
    if (venda.pagamento !== 'fiado') throw new Error('sem parcelas')
    const aceita: GrupoEstoque = { ...grupo, lancamentos: [{ ...venda,
      itens: venda.itens.map((item) => ({ ...item, precoUnitario: 4000n, preco: 12000n })),
      parcelas: venda.parcelas.map((item) => ({ ...item, valor: 12000n })) }] }
    // Simula somente o armazenamento da evidência recebida; transporte real é E-20/E-21.
    await a.banco.versoesEstoque.add({ id: 'evidencia-remota', operacaoId: grupo.operacao.id, grupo: aceita, aceita: true })
    await a.repositorio.responderEnvio(capturado, PROBLEMA)
    ok(await a.repositorio.encerrar(capturado.versao.id, { data: '2026-10-18', confirmado: true, intencaoPendente: false }))
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(12000n)
    expect((await a.repositorio.lerEstado()).grupos.find((item) => item.operacao.id === grupo.operacao.id)).toEqual(aceita)
    a.banco.close()
    const banco = new BancoLocal('estoque', { indexedDB: a.indexedDB, IDBKeyRange })
    const repositorio = criarRepositorioEstoque(banco)
    expect((await repositorio.lerEstado()).grupos.find((item) => item.operacao.id === grupo.operacao.id)).toEqual(aceita)
    expect(await banco.versoesEstoque.get(capturado.versao.id)).toMatchObject({ grupo, problema: PROBLEMA })
    banco.close()
  })

  test('estorno pede retorno real e preserva financeiro; retorno posterior não repete estorno (RT-04/05/11)', async () => {
    const a = await preparar()
    await compra(a)
    const venda = vendaDoGrupo(ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id, 3, 2))))
    const item = venda.itens[0]
    if (!item) throw new Error('sem item')
    expect((await a.operacoes.cancelarVenda(venda.id, '2026-10-18', [])).ok).toBe(false)
    const cancelamento = ok(await a.operacoes.cancelarVenda(venda.id, '2026-10-18', [{ itemId: item.id, quantidade: 0 }]))
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(0n)
    expect(await fisico(a)).toBe(8)
    ok(await a.operacoes.registrarRetorno(venda.id, '2026-10-18', [{ itemId: item.id, quantidade: 1 }]))
    expect(await fisico(a)).toBe(9)
    expect(await a.banco.lancamentos.count()).toBe(2)
    expect((await a.operacoes.registrarRetorno(venda.id, '2026-10-18', [{ itemId: item.id, quantidade: 2 }])).ok).toBe(false)
    expect(cancelamento.lancamentos[0]?.tipo).toBe('estorno')
    a.banco.close()
  })

  test('cada motivo de saída e contagem passa pelo domínio; custo manual não sobrepõe compra válida', async () => {
    const a = await preparar()
    await compra(a)
    for (const motivo of ['perda', 'quebra', 'uso-pessoal', 'brinde'] as const) {
      ok(await a.operacoes.registrarMovimento({ tipo: 'saida', produtoId: a.produto.id, data: '2026-10-18', quantidade: 1, motivo }))
    }
    expect(await fisico(a)).toBe(6)
    expect((await a.operacoes.alterarProduto({ ...a.produto, custoManual: 3500n }))).toEqual({ ok: false, motivo: 'custo-definido-por-compra' })
    expect(custoDoProduto(a.produto, ok(projetarEstoque(await a.banco.movimentos.toArray(), a.produto.id)).comprasVigentes)).toBe(3000n)
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(0n)
    a.banco.close()
  })

  test('resposta perdida não autoriza encerramento; recusa antiga não marca revisão nova', async () => {
    const a = await preparar()
    const inicial = await compra(a)
    const capturado = await envio(a, inicial)
    expect(await a.repositorio.encerrar(capturado.versao.id, { data: '2026-10-18', confirmado: true, intencaoPendente: false }))
      .toEqual({ ok: false, motivo: 'recusa-nao-confirmada' })
    const original = inicial.movimentos[0]
    if (!original) throw new Error('sem movimento')
    ok(await a.operacoes.corrigirRegistroMovimento(original, { tipo: 'compra', produtoId: a.produto.id, data: original.data, quantidade: 8 }))
    await a.repositorio.responderEnvio(capturado, PROBLEMA)
    expect((await a.banco.fila.where('registroId').equals(inicial.operacao.id).first())?.problema).toBeUndefined()
    a.banco.close()
  })

  test('encerramento legado retém evidência, retira só provisório e é idempotente após reabertura', async () => {
    const a = await preparar()
    await compra(a)
    const grupo = ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id)))
    await aceitar(a, grupo)
    const venda = vendaDoGrupo(grupo)
    await a.banco.lancamentos.put({ tipo: 'estorno', id: 'legado', clienteId: 'cliente', data: '2026-10-18', estornaId: venda.id })
    await a.banco.fila.add({ tabela: 'lancamentos', registroId: 'legado', criadoEm: AGORA, problema: PROBLEMA })
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(0n)
    const versao = ok(await a.repositorio.registrarRecusaLegada('legado'))
    expect((await a.repositorio.encerrar(versao.id, { data: '2026-10-18', confirmado: false, intencaoPendente: false })).ok).toBe(false)
    const encerrada = ok(await a.repositorio.encerrar(versao.id, { data: '2026-10-18', confirmado: true, intencaoPendente: false }))
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(15000n)
    expect(await fisico(a)).toBe(9)
    expect(encerrada.evidencia.grupo.lancamentos[0]?.id).toBe('legado')
    a.banco.close()
    const banco = new BancoLocal('estoque', { indexedDB: a.indexedDB, IDBKeyRange })
    const repositorio = criarRepositorioEstoque(banco)
    expect(ok(await repositorio.encerrar(versao.id, { data: '2026-10-18', confirmado: true, intencaoPendente: false }))).toEqual(encerrada)
    expect(await banco.encerramentos.count()).toBe(1)
    expect(await banco.fila.where('registroId').equals('legado').count()).toBe(0)
    expect(await banco.fila.where('registroId').equals(encerrada.id).count()).toBe(1)
    banco.close()
  })

  test('falha na resolução com nova operação aborta tudo; confirmação repetida não refaz operação', async () => {
    const a = await preparar()
    const entrada = await compra(a)
    await aceitar(a, entrada)
    const grupo = ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id)))
    await aceitar(a, grupo)
    const venda = vendaDoGrupo(grupo)
    const recusada = ok(await a.operacoes.cancelarVenda(venda.id, '2026-10-18', venda.itens.map((item) => ({ itemId: item.id, quantidade: 0 }))))
    const capturado = await envio(a, recusada)
    await a.repositorio.responderEnvio(capturado, PROBLEMA)
    let preparacoes = 0
    const prepararNova = (estado: Parameters<Parameters<typeof a.repositorio.executar>[0]>[0]) => {
      preparacoes++
      return prepararCancelamento(estado.lancamentos, estado.movimentos, venda, { data: '2026-10-18', estornoId: 'novo-estorno',
        operacao: { id: 'nova-operacao', revisao: 1, dependencias: [] }, revisaoVenda: 1,
        retornos: venda.itens.map((item) => ({ itemId: item.id, quantidade: 0, movimentoId: 'novo-retorno' })) })
    }
    const filaAntes = await a.banco.fila.toArray()
    const avisos = a.avisos()
    const falhar = () => { throw new Error('falha no encerramento') }
    a.banco.fila.hook('creating', falhar)
    await expect(Promise.resolve(a.repositorio.encerrar(capturado.versao.id, { data: '2026-10-18', confirmado: true, intencaoPendente: true, prepararNova }))).rejects.toThrow('falha no encerramento')
    a.banco.fila.hook('creating').unsubscribe(falhar)
    expect(await a.banco.encerramentos.count()).toBe(0)
    expect(await a.banco.lancamentos.get('novo-estorno')).toBeUndefined()
    expect(await a.banco.fila.toArray()).toEqual(filaAntes)
    expect(a.avisos()).toBe(avisos)
    const encerrada = ok(await a.repositorio.encerrar(capturado.versao.id, { data: '2026-10-18', confirmado: true, intencaoPendente: true, prepararNova }))
    expect(encerrada.novaOperacao?.operacao.id).toBe('nova-operacao')
    expect(await a.banco.lancamentos.get('novo-estorno')).toBeDefined()
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(0n)
    expect(await a.banco.fila.where('registroId').equals('nova-operacao').count()).toBe(1)
    const contagem = preparacoes
    ok(await a.repositorio.encerrar(capturado.versao.id, { data: '2026-10-18', confirmado: true, intencaoPendente: true, prepararNova }))
    expect(preparacoes).toBe(contagem)
    expect(await a.banco.encerramentos.count()).toBe(1)
    a.banco.close()
  })

  test('encerrar nova tentativa revisada não ressuscita revisão antiga de uma resolução anterior', async () => {
    const a = await preparar()
    const grupo = await compra(a)
    const primeiro = await envio(a, grupo)
    await a.repositorio.responderEnvio(primeiro, PROBLEMA)
    const encerrada = ok(await a.repositorio.encerrar(primeiro.versao.id, { data: '2026-10-18', confirmado: true, intencaoPendente: true,
      prepararNova: (estado) => prepararMovimentosEstoque(estado.movimentos, { id: 'compra-nova', revisao: 1, dependencias: [] },
        [{ tipo: 'compra', id: 'movimento-novo', revisao: 1, operacaoId: 'compra-nova', produtoId: a.produto.id,
          data: '2026-10-18', quantidade: 10, ordemCadastro: estado.carimbo, conhecidos: [] }]) }))
    if (!encerrada.novaOperacao) throw new Error('sem nova operação')
    const revisada = ok(await a.operacoes.corrigirRegistroMovimento({ id: 'movimento-novo', revisao: 1 },
      { tipo: 'compra', produtoId: a.produto.id, data: '2026-10-18', quantidade: 8 }))
    const segundo = await envio(a, revisada)
    await a.repositorio.responderEnvio(segundo, PROBLEMA)
    ok(await a.repositorio.encerrar(segundo.versao.id, { data: '2026-10-18', confirmado: true, intencaoPendente: false }))
    expect(await fisico(a)).toBe(0)
    expect(await a.banco.operacoes.count()).toBe(0)
    expect(await a.banco.fila.where('registroId').equals('compra-nova').count()).toBe(0)
    expect(await a.banco.encerramentos.count()).toBe(2)
    a.banco.close()
  })

  test('correção só financeira após aceite preserva entregas, custos e usa novas parcelas', async () => {
    const a = await preparar()
    await compra(a)
    const grupo = ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id)))
    await aceitar(a, grupo)
    const venda = vendaDoGrupo(grupo)
    if (venda.pagamento !== 'fiado') throw new Error('sem parcelas')
    const corrigida = ok(await a.operacoes.corrigirVenda(venda.id, { ...entradaVenda(a.produto.id),
      itens: venda.itens.map((item) => ({ ...item, entregue: 1, precoUnitario: 4000n })),
      pagamento: 'fiado', parcelas: venda.parcelas.map((item) => ({ ...item, valor: 12000n })) },
      { data: '2026-10-18', natureza: 'financeira' }))
    expect(corrigida.lancamentos).toHaveLength(2)
    expect(corrigida.movimentos).toHaveLength(0)
    expect(vendaDoGrupo(corrigida).itens[0]?.id).toBe(venda.itens[0]?.id)
    const nova = vendaDoGrupo(corrigida)
    if (nova.pagamento !== 'fiado') throw new Error('sem parcelas novas')
    expect(nova.parcelas[0]?.id).not.toBe(venda.parcelas[0]?.id)
    expect(await fisico(a)).toBe(9)
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(12000n)
    a.banco.close()
  })

  test('correção da quantidade anotada revisa venda e entrega juntas, sem reescrever custo', async () => {
    const a = await preparar()
    await compra(a)
    const grupo = ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id)))
    const venda = vendaDoGrupo(grupo)
    const entrega = grupo.movimentos[0]
    if (!entrega) throw new Error('sem entrega')
    const corrigida = ok(await a.operacoes.corrigirVenda(venda.id, { ...entradaVenda(a.produto.id, 2, 2),
      itens: venda.itens.map((item) => ({ ...item, quantidade: 2, entregue: 2 })),
      pagamento: 'fiado', parcelas: [{ valor: 10000n, vencimento: '2026-11-18' }] },
      { data: '2026-10-18', natureza: 'anotacao', entregas: [{ alvo: entrega, produtoId: a.produto.id, quantidade: 2, custoUnitario: 9999n }] }))
    expect(corrigida.movimentos[0]).toMatchObject({ id: entrega.id, revisao: 2, custoUnitario: 3000n })
    expect(await fisico(a)).toBe(8)
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(10000n)
    expect(await a.banco.fila.where('registroId').equals(grupo.operacao.id).count()).toBe(1)
    a.banco.close()
  })

  test('venda à vista mista mantém preço exato, avulso sem baixa e item gratuito', async () => {
    const a = await preparar()
    const grupo = ok(await a.operacoes.lancarVenda({ pagamento: 'avista', forma: 'pix', clienteId: 'cliente',
      data: '2026-10-18', desconto: 0n, itens: [
        { descricao: 'Avulso', quantidade: 1, precoUnitario: 9007199254740993n, entregue: 0 },
        { descricao: 'Amostra', produtoId: a.produto.id, quantidade: 1, precoUnitario: 0n, entregue: 1 }] }))
    expect(vendaDoGrupo(grupo).itens[0]?.preco).toBe(9007199254740993n)
    expect(grupo.movimentos).toHaveLength(1)
    expect(await fisico(a)).toBe(-1)
    expect(saldo(await a.banco.lancamentos.toArray())).toBe(0n)
    a.banco.close()
  })

  test('captura recusa grupo incompleto ou divergente; evidência não substitui registro próprio', async () => {
    const a = await preparar()
    const grupo = ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id)))
    const movimento = grupo.movimentos[0]
    if (!movimento) throw new Error('sem movimento')
    await a.banco.movimentos.delete([movimento.id, movimento.revisao])
    await expect(Promise.resolve(a.repositorio.capturarEnvio(grupo.operacao.id))).rejects.toThrow('Envio sem movimento')
    expect(await a.banco.fila.where('registroId').equals(grupo.operacao.id).count()).toBe(1)
    a.banco.close()
  })

  test('a porta F1 consulta a fila por operação ao perguntar sobre lançamento F2', async () => {
    const a = await preparar()
    const grupo = ok(await a.operacoes.lancarVenda(entradaVenda(a.produto.id)))
    const venda = vendaDoGrupo(grupo)
    const legado = criarRepositorioLocal(a.banco)
    expect(await legado.sincronizado(venda.id)).toBe(false)
    await expect(Promise.resolve(legado.gravarLancamento(venda))).rejects.toThrow('exige operação completa')
    await expect(Promise.resolve(legado.gravarLancamento({ tipo: 'estorno', id: 'incompleto', clienteId: 'cliente', data: '2026-10-18', estornaId: venda.id })))
      .rejects.toThrow('exige operação completa')
    expect(await a.banco.lancamentos.get('incompleto')).toBeUndefined()
    const capturado = await envio(a, grupo)
    await a.repositorio.responderEnvio(capturado, PROBLEMA)
    expect(await legado.comProblema(venda.id)).toBe(true)
    a.banco.close()
  })
})
