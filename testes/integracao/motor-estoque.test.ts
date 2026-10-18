import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { BancoLocal } from '../../src/dados/banco.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { criarOperacoesEstoque, type EntradaVendaLocal } from '../../src/dados/operacoes-estoque.ts'
import { cadastrarCliente, lancarVendaFiado } from '../../src/dados/operacoes.ts'
import { criarRepositorioLocal } from '../../src/dados/repositorio.ts'
import { criarRepositorioEstoque } from '../../src/dados/repositorio-estoque.ts'
import { baseConhecida, projetarEstoque } from '../../src/dominio/estoque.ts'
import { saldo } from '../../src/dominio/ficha.ts'
import { custoDoProduto } from '../../src/dominio/produtos.ts'
import { conteudoDoEfeito, type ResultadoEstoque } from '../../src/dominio/regras-estoque.ts'
import { prepararCancelamento, prepararMovimentosEstoque, type VendaEstoque } from '../../src/dominio/vendas-estoque.ts'
import { criarNuvemSupabase, type Nuvem } from '../../src/sincronizacao/nuvem.ts'
import { documentoEstoque } from '../../src/sincronizacao/borda-estoque.ts'
import { iniciarSincronizacao } from '../../src/sincronizacao/sincronizacao.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
const DIA = '2026-10-18', GRANDE = 9007199254740993n
let clienteRemoto: SupabaseClient
let nuvem: Nuvem
const bancos: BancoLocal[] = []
function ok<T>(r: ResultadoEstoque<T>): T { if (!r.ok) throw new Error(r.motivo); return r.valor }
beforeAll(async () => {
  if (!LIGADA) return
  clienteRemoto = createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.VITE_SUPABASE_ANON_KEY ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await clienteRemoto.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '', password: process.env.SUPABASE_TESTE_SENHA ?? '' })
  if (error) throw new Error(`Login fictício E-21: ${error.message}`)
  nuvem = criarNuvemSupabase(clienteRemoto)
})
afterAll(async () => { for (const b of bancos) b.close(); if (LIGADA) await clienteRemoto.auth.signOut() })

function aparelho(transporte: () => Nuvem = () => nuvem) {
  const banco = new BancoLocal(uuidv7(), { indexedDB: new IDBFactory(), IDBKeyRange })
  bancos.push(banco)
  let carimbo = '2026-10-18T12:00:00.000Z'
  const repo = criarRepositorioLocal(banco, () => carimbo)
  const estoque = criarRepositorioEstoque(banco, () => carimbo)
  const operacoes = criarOperacoesEstoque(estoque)
  async function ciclo() {
    const motor = iniciarSincronizacao({ banco, nuvem: transporte(), agendar: () => () => undefined, janela: null, documento: null })
    await motor.sincronizar()
    const estado = motor.estado(); motor.parar()
    expect(estado.ultimaFalha).toBeNull()
    if (estado.comProblema) console.warn('Fila E-21 recusada:', await banco.fila.toArray())
    return estado
  }
  return { banco, repo, estoque, operacoes, ciclo, relogio: (v: string) => { carimbo = v } }
}
type Aparelho = ReturnType<typeof aparelho>
async function preparar(a: Aparelho, quantidade = 10) {
  const cliente = ok(await cadastrarCliente(a.repo, { nome: `Vera fictícia E-21 ${uuidv7()}` }))
  const categoria = ok(await a.operacoes.cadastrarCategoria(`Perfumes ${uuidv7()}`))
  const produto = ok(await a.operacoes.cadastrarProduto({ nome: 'Perfume', categoriaId: categoria.id, custoManual: GRANDE,
    precoVenda: 5000n, estoqueMinimo: 0, marca: '', codigoCatalogo: 'A1' }))
  const compra = ok(await a.operacoes.registrarMovimento({ tipo: 'compra', produtoId: produto.id, data: DIA, quantidade, custoUnitario: GRANDE }))
  return { cliente, categoria, produto, compra }
}
function venda(clienteId: string, produtoId: string, quantidade = 3, entregue = 1): Extract<EntradaVendaLocal, { pagamento: 'fiado' }> {
  return { clienteId, data: DIA, pagamento: 'fiado', desconto: 0n, parcelas: [{ vencimento: DIA, valor: BigInt(quantidade) * 5000n }],
    itens: [{ descricao: 'Perfume', produtoId, quantidade, entregue }] }
}
async function fisico(a: Aparelho, produtoId: string) { return ok(projetarEstoque(await a.banco.movimentos.toArray(), produtoId)).fisico }
async function retrato(a: Aparelho, clienteId: string, produtoId: string) {
  const estado = await a.estoque.lerEstado()
  return conteudoDoEfeito({ cliente: await a.banco.clientes.get(clienteId), produto: await a.banco.produtos.get(produtoId),
    lancamentos: estado.lancamentos.filter((l) => l.clienteId === clienteId).sort((a, b) => a.id.localeCompare(b.id)),
    movimentos: estado.movimentos.filter((m) => m.produtoId === produtoId).sort((a, b) => a.id.localeCompare(b.id) || a.revisao - b.revisao),
    grupos: estado.grupos.filter((g) => g.movimentos.some((m) => m.produtoId === produtoId) || g.lancamentos.some((l) => l.clienteId === clienteId)).sort((a, b) => a.operacao.id.localeCompare(b.operacao.id)) })
}

describe.skipIf(!LIGADA)('E-21 motor real → PostgREST → IndexedDB simulado (Chromium em suíte própria)', () => {
  test('ciclo completo, resposta perdida, revisão anterior nunca enviada, entrega, estorno e restauração F1 + F2', async () => {
    let perder = false
    const a = aparelho(() => ({ ...nuvem, enviarGrupo: async (...args) => {
      const resposta = await nuvem.enviarGrupo(...args)
      if (resposta.ok && perder) { perder = false; return { ok: false, falha: { tipo: 'rede', mensagem: 'resposta descartada após commit real' } } }
      return resposta
    } }))
    const { cliente, produto, compra } = await preparar(a)
    const m = compra.movimentos[0]; if (!m) throw new Error('sem compra')
    ok(await a.operacoes.corrigirRegistroMovimento(m, { tipo: 'compra', data: DIA, produtoId: produto.id, quantidade: 8, custoUnitario: GRANDE }))
    ok(await lancarVendaFiado(a.repo, { clienteId: cliente.id, data: DIA, itens: [{ descricao: 'Avulso F1', preco: 1000n }], parcelas: [{ vencimento: DIA, valor: 1000n }] }))
    const v = ok(await a.operacoes.lancarVenda(venda(cliente.id, produto.id)))
    const l = v.lancamentos[0]; if (!l || l.tipo !== 'venda' || !l.itens[0]?.id) throw new Error('sem venda')
    perder = true
    const motor = iniciarSincronizacao({ banco: a.banco, nuvem: { ...nuvem, enviarGrupo: async (...args) => {
      const r = await nuvem.enviarGrupo(...args)
      return r.ok ? { ok: false, falha: { tipo: 'rede', mensagem: 'perdida' } } : r
    } }, agendar: () => () => undefined })
    await motor.sincronizar(); expect(motor.estado().ultimaFalha).toBe('rede'); motor.parar()
    perder = false
    expect((await a.ciclo()).comProblema).toBe(0)
    expect(await a.banco.fila.count()).toBe(0)
    ok(await a.operacoes.entregar({ vendaId: l.id, itemId: l.itens[0].id, quantidade: 1, data: DIA }))
    await a.ciclo()
    ok(await a.operacoes.cancelarVenda(l.id, DIA, [{ itemId: l.itens[0].id, quantidade: 1 }]))
    await a.ciclo()
    expect(await fisico(a, produto.id)).toBe(7)
    expect(saldo(await a.repo.lerFicha(cliente.id))).toBe(1000n)
    const antes = await retrato(a, cliente.id, produto.id)
    const b = aparelho(); await b.ciclo()
    expect(await retrato(b, cliente.id, produto.id)).toBe(antes)
    expect(await b.banco.categorias.get(produto.categoriaId)).toBeDefined()
    expect(await b.banco.fila.count()).toBe(0)
    expect((await b.banco.relogioEstoque.get('cadastro'))?.ultimo).toBeGreaterThanOrEqual(m.tipo === 'compra' ? m.ordemCadastro : 0n)
  }, 120_000)

  test('categorias concorrentes mantêm vínculos; Q48 compra desconhecida/manual LWW e anulação restauram a referência', async () => {
    const a = aparelho(), b = aparelho()
    const categoriaA = ok(await a.operacoes.cadastrarCategoria(`Iguais ${uuidv7()}`))
    const categoriaB = ok(await b.operacoes.cadastrarCategoria(` ${categoriaA.nome.toUpperCase()} `))
    const pA = ok(await a.operacoes.cadastrarProduto({ nome: 'A', categoriaId: categoriaA.id, custoManual: 2500n }))
    const pB = ok(await b.operacoes.cadastrarProduto({ nome: 'B', categoriaId: categoriaB.id }))
    await a.ciclo(); await b.ciclo(); await a.ciclo()
    expect((await a.banco.produtos.get(pB.id))?.categoriaId).toBe(categoriaB.id)
    expect((await b.banco.produtos.get(pA.id))?.categoriaId).toBe(categoriaA.id)
    // B registra a compra; A altera manualmente sem conhecê-la. A versão inteira vence por relógio.
    const compra = ok(await b.operacoes.registrarMovimento({ tipo: 'compra', produtoId: pA.id, data: DIA, quantidade: 1, custoUnitario: 3000n }))
    a.relogio('2026-10-19T12:00:00.000Z')
    ok(await a.operacoes.alterarProduto({ ...pA, nome: 'Manual vencedor', custoManual: 3500n }))
    await b.ciclo(); await a.ciclo(); await b.ciclo()
    const proj = ok(projetarEstoque(await a.banco.movimentos.toArray(), pA.id))
    expect(custoDoProduto((await a.banco.produtos.get(pA.id))!, proj.comprasVigentes)).toBe(3000n)
    const m = compra.movimentos[0]; if (!m) throw new Error('sem compra')
    // Anulação pura pelo contrato já aprovado; não inventar uma compra substituta para o ensaio.
    ok(await a.estoque.executar((estado) => {
      const id = uuidv7()
      const alvo = { id: m.id, revisao: m.revisao }
      return prepararMovimentosEstoque(estado.movimentos, { id, revisao: 1, dependencias: [alvo] },
        [{ tipo: 'anulacao', id: uuidv7(), operacaoId: id, revisao: 1, produtoId: pA.id, data: DIA,
          conhecidos: baseConhecida(estado.movimentos, pA.id), alvo }], alvo)
    }))
    await a.ciclo(); await b.ciclo()
    const apos = ok(projetarEstoque(await b.banco.movimentos.toArray(), pA.id))
    expect(custoDoProduto((await b.banco.produtos.get(pA.id))!, apos.comprasVigentes)).toBe(3500n)
  }, 120_000)

  test('dois aparelhos vendem o último item offline: preserva as duas entregas e mostra físico -1', async () => {
    const a = aparelho(), b = aparelho()
    const { cliente, produto } = await preparar(a, 1)
    await a.ciclo(); await b.ciclo()
    ok(await a.operacoes.lancarVenda(venda(cliente.id, produto.id, 1, 1)))
    ok(await b.operacoes.lancarVenda(venda(cliente.id, produto.id, 1, 1)))
    await a.ciclo(); await b.ciclo(); await a.ciclo()
    expect(await fisico(a, produto.id)).toBe(-1)
    expect(await fisico(b, produto.id)).toBe(-1)
    expect(saldo(await a.repo.lerFicha(cliente.id))).toBe(10000n)
    expect(await a.banco.fila.count()).toBe(0)
    expect(await b.banco.fila.count()).toBe(0)
    expect(await retrato(a, cliente.id, produto.id)).toBe(await retrato(b, cliente.id, produto.id))
  }, 120_000)

  test('Q47 revisão aceita do mesmo id, resposta antiga e encerramento com resposta perdida/restauração', async () => {
    let perderEncerramento = true
    const a = aparelho(() => ({ ...nuvem, enviarEncerramento: async (doc) => {
      const resposta = await nuvem.enviarEncerramento(doc)
      if (resposta.ok && perderEncerramento) { perderEncerramento = false; return { ok: false, falha: { tipo: 'rede', mensagem: 'resposta perdida depois do commit' } } }
      return resposta
    } }))
    const { produto, compra } = await preparar(a)
    await a.ciclo()
    const nova = ok(await a.operacoes.registrarMovimento({ tipo: 'compra', produtoId: produto.id, data: DIA, quantidade: 2 }))
    const envioAntigo = await a.estoque.capturarEnvio(nova.operacao.id); if (!envioAntigo) throw new Error('sem envio')
    expect((await nuvem.enviarGrupo(documentoEstoque(nova), [], null)).ok).toBe(true)
    const movimento = nova.movimentos[0]; if (!movimento) throw new Error('sem movimento')
    ok(await a.operacoes.corrigirRegistroMovimento(movimento, { tipo: 'compra', produtoId: produto.id, data: DIA, quantidade: 3 }))
    expect((await a.ciclo()).comProblema).toBe(1)
    const recusada = (await a.banco.versoesEstoque.toArray()).find((v) => v.operacaoId === nova.operacao.id && v.problema)
    if (!recusada) throw new Error('recusa sem evidência')
    const confirmacao = { data: DIA, confirmado: true, intencaoPendente: false } as const
    const encerrada = ok(await a.estoque.encerrar(recusada.id, confirmacao))
    expect(ok(await a.estoque.encerrar(recusada.id, confirmacao))).toEqual(encerrada)
    await a.estoque.responderEnvio(envioAntigo)
    expect(await fisico(a, produto.id)).toBe(12)
    const motor = iniciarSincronizacao({ banco: a.banco, nuvem: { ...nuvem, enviarEncerramento: async (doc) => {
      const r = await nuvem.enviarEncerramento(doc)
      return r.ok ? { ok: false, falha: { tipo: 'rede', mensagem: 'resposta perdida' } } : r
    } }, agendar: () => () => undefined })
    await motor.sincronizar(); expect(motor.estado().ultimaFalha).toBe('rede'); motor.parar()
    perderEncerramento = false
    await a.ciclo(); expect(await a.banco.fila.count()).toBe(0)
    const b = aparelho(); await b.ciclo()
    expect(await b.banco.encerramentos.get(encerrada.id)).toEqual(encerrada)
    expect(await fisico(b, produto.id)).toBe(12)
    expect((await b.banco.versoesEstoque.toArray()).some((v) => conteudoDoEfeito(v.grupo) === conteudoDoEfeito(recusada.grupo))).toBe(true)
    expect((await b.banco.operacoes.get(compra.operacao.id))?.id).toBe(compra.operacao.id)
    expect(await b.banco.fila.count()).toBe(0)
  }, 120_000)

  test('Q47 F1 recusado → atualização → alvo já corrigido → conferência humana sem segundo cancelamento', async () => {
    const a = aparelho(), b = aparelho()
    const { cliente, produto } = await preparar(a)
    const v = ok(await a.operacoes.lancarVenda(venda(cliente.id, produto.id)))
    const l = v.lancamentos[0]; if (!l || l.tipo !== 'venda') throw new Error('sem venda')
    await a.ciclo(); await b.ciclo()
    // Dados fictícios no formato que o app F1 gravava, antes da guarda local de E-19.
    const legado = { id: uuidv7(), clienteId: cliente.id, data: DIA, tipo: 'estorno', estornaId: l.id } as const
    await b.banco.transaction('rw', b.banco.lancamentos, b.banco.fila, async () => {
      await b.banco.lancamentos.put(legado)
      await b.banco.fila.add({ tabela: 'lancamentos', registroId: legado.id, criadoEm: new Date().toISOString() })
    })
    expect((await b.ciclo()).comProblema).toBe(1)
    expect(saldo(await b.repo.lerFicha(cliente.id))).toBe(0n)
    const corrigida = ok(await a.operacoes.corrigirVenda(l.id, { ...venda(cliente.id, produto.id),
      itens: l.itens.map((i) => ({ id: i.id, descricao: i.descricao, produtoId: i.produtoId, quantidade: i.quantidade ?? 1, precoUnitario: 6000n, entregue: 0 })),
      parcelas: [{ vencimento: DIA, valor: 18000n }] }, { data: DIA, natureza: 'financeira' }))
    await a.ciclo(); await b.ciclo()
    const recusada = ok(await b.estoque.registrarRecusaLegada(legado.id))
    const encerrada = ok(await b.estoque.encerrar(recusada.id, { data: DIA, confirmado: true, intencaoPendente: false }))
    expect(saldo(await b.repo.lerFicha(cliente.id))).toBe(18000n)
    expect(await fisico(b, produto.id)).toBe(9)
    await b.ciclo(); await a.ciclo()
    const c = aparelho(); await c.ciclo()
    expect(saldo(await c.repo.lerFicha(cliente.id))).toBe(18000n)
    expect(await fisico(c, produto.id)).toBe(9)
    expect(await c.banco.lancamentos.get(legado.id)).toBeUndefined()
    expect(await c.banco.encerramentos.get(encerrada.id)).toEqual(encerrada)
    expect((await c.estoque.lerEstado()).grupos.some((g) => g.operacao.id === corrigida.operacao.id)).toBe(true)
  }, 120_000)

  test('Q47 nova intenção ligada ao encerramento continua sujeita à recusa e não ressuscita após segunda resolução', async () => {
    const a = aparelho(), b = aparelho()
    const { cliente, produto } = await preparar(a)
    const v = ok(await a.operacoes.lancarVenda(venda(cliente.id, produto.id)))
    const l = v.lancamentos[0]; if (!l || l.tipo !== 'venda') throw new Error('sem venda')
    const itens = l.itens.map((i) => {
      if (!i.id || i.quantidade === undefined || i.precoUnitario === undefined) throw new Error('item sem F2')
      return { ...i, id: i.id, quantidade: i.quantidade, precoUnitario: i.precoUnitario }
    })
    const alvo: VendaEstoque = { ...l, itens }
    await a.ciclo(); await b.ciclo()
    const legado = { id: uuidv7(), clienteId: cliente.id, data: DIA, tipo: 'estorno', estornaId: l.id } as const
    await b.banco.lancamentos.put(legado)
    await b.banco.fila.add({ tabela: 'lancamentos', registroId: legado.id, criadoEm: new Date().toISOString() })
    await b.ciclo()
    const recusada = ok(await b.estoque.registrarRecusaLegada(legado.id))
    const encerrada = ok(await b.estoque.encerrar(recusada.id, { data: DIA, confirmado: true, intencaoPendente: true,
      prepararNova: (estado) => prepararCancelamento(estado.lancamentos, estado.movimentos, alvo,
        { operacao: { id: uuidv7(), revisao: 1, dependencias: [{ id: alvo.id, revisao: 1 }] }, data: DIA,
          estornoId: uuidv7(), revisaoVenda: 1, retornos: itens.map((i) => ({ itemId: i.id, quantidade: 0, movimentoId: uuidv7() })) }) }))
    expect(encerrada.novaOperacao).toBeDefined()
    // O outro aparelho cancela entre a conferência humana e o envio da nova intenção.
    ok(await a.operacoes.cancelarVenda(l.id, DIA, itens.map((i) => ({ itemId: i.id, quantidade: 0 })))); await a.ciclo()
    await b.ciclo(); expect((await b.ciclo()).comProblema).toBe(1)
    const novaRecusada = (await b.banco.versoesEstoque.toArray()).find((v) => v.operacaoId === encerrada.novaOperacao?.operacao.id && v.problema)
    if (!novaRecusada) throw new Error('nova recusa sem evidência')
    const final = ok(await b.estoque.encerrar(novaRecusada.id, { data: DIA, confirmado: true, intencaoPendente: false }))
    await b.ciclo(); await a.ciclo()
    const c = aparelho(); await c.ciclo(); await c.ciclo()
    expect(await c.banco.fila.count()).toBe(0)
    expect(saldo(await c.repo.lerFicha(cliente.id))).toBe(0n)
    expect(await fisico(c, produto.id)).toBe(9)
    expect(await c.banco.encerramentos.get(final.id)).toEqual(final)
    expect(await c.banco.operacoes.get(novaRecusada.operacaoId)).toBeUndefined()
  }, 120_000)
})
