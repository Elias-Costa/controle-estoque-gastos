import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { BancoLocal } from '../../src/dados/banco.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { criarOperacoesCaixa } from '../../src/dados/operacoes-caixa.ts'
import { criarRepositorioCaixa } from '../../src/dados/repositorio-caixa.ts'
import { criarOperacoesEstoque } from '../../src/dados/operacoes-estoque.ts'
import { criarRepositorioEstoque } from '../../src/dados/repositorio-estoque.ts'
import { criarRepositorioLocal } from '../../src/dados/repositorio.ts'
import { cadastrarCliente, lancarVendaFiado } from '../../src/dados/operacoes.ts'
import type { GrupoCaixa } from '../../src/dados/tipos-caixa.ts'
import type { ResultadoCaixa } from '../../src/dominio/gastos.ts'
import { projetarCaixa } from '../../src/dominio/caixa.ts'
import { conteudoDoEfeito } from '../../src/dominio/regras-estoque.ts'
import { saldo } from '../../src/dominio/ficha.ts'
import { projetarEstoque } from '../../src/dominio/estoque.ts'
import { grupoCaixaDaNuvem } from '../../src/sincronizacao/borda-caixa.ts'
import { criarNuvemSupabase, type Nuvem } from '../../src/sincronizacao/nuvem.ts'
import { iniciarSincronizacao } from '../../src/sincronizacao/sincronizacao.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
const DIA = '2026-10-24', GRANDE = 9007199254740993n
let clienteRemoto: SupabaseClient, nuvem: Nuvem
const bancos: BancoLocal[] = []
beforeAll(async () => {
  if (!LIGADA) return
  clienteRemoto = createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.VITE_SUPABASE_ANON_KEY ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await clienteRemoto.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '', password: process.env.SUPABASE_TESTE_SENHA ?? '' })
  if (error) throw new Error(`Login fictício E-33: ${error.message}`)
  // Metadados reais. Bytes/Canvas continuam na suíte específica de fotos, sem dublê aqui.
  const { fotos: _fotos, ...metadados } = criarNuvemSupabase(clienteRemoto)
  nuvem = metadados
})
afterAll(async () => { for (const b of bancos) b.close(); if (LIGADA) await clienteRemoto.auth.signOut() })
function ok<T>(r: ResultadoCaixa<T>): T { if (!r.ok) throw new Error(r.motivo); return r.valor }
function entrada(valor = GRANDE) {
  return { tipo: 'despesa', valor, data: '2026-09-30', categoria: 'Mercadoria livre', classificacao: 'negocio', mercadoria: true } as const
}
function aparelho(transporte: () => Nuvem = () => nuvem) {
  const banco = new BancoLocal(uuidv7(), { indexedDB: new IDBFactory(), IDBKeyRange }); bancos.push(banco)
  const repo = criarRepositorioCaixa(banco), op = criarOperacoesCaixa(repo)
  async function ciclo() {
    const motor = iniciarSincronizacao({ banco, nuvem: transporte(), agendar: () => () => undefined, janela: null, documento: null })
    await motor.sincronizar(); const estado = motor.estado(); motor.parar(); return estado
  }
  return { banco, repo, op, ciclo }
}
async function conferir(a: ReturnType<typeof aparelho>, grupos: readonly GrupoCaixa[]) {
  for (const g of grupos) {
    const v = (await a.banco.versoesCaixa.toArray()).find((v) => v.aceita && v.operacaoId === g.operacao.id)
    expect(v?.grupo).toEqual(g)
    for (const f of g.fatos) expect(await a.banco.fatosCaixa.get(f.id)).toEqual(f)
  }
}

describe.skipIf(!LIGADA)('E-33 motor real → PostgREST → IndexedDB simulado', () => {
  test('resposta perdida depois do commit, reenvio e restauração integral de caixa preservam F1/F2', async () => {
    let perder = true, chamadas = 0, alvo = ''
    const a = aparelho(() => ({ ...nuvem, enviarCaixa: async (g) => {
      const r = await nuvem.enviarCaixa(g)
      if (grupoCaixaDaNuvem(g).operacao.id === alvo) {
        chamadas++
        if (r.ok && perder) return { ok: false, falha: { tipo: 'rede', mensagem: 'resposta descartada após commit real' } }
      }
      return r
    } }))
    const f1 = criarRepositorioLocal(a.banco), estoque = criarOperacoesEstoque(criarRepositorioEstoque(a.banco))
    const c = await cadastrarCliente(f1, { nome: `Fictícia E-33 ${uuidv7()}` }); if (!c.ok) throw new Error(c.motivo)
    const v = await lancarVendaFiado(f1, { clienteId: c.valor.id, data: DIA, itens: [{ descricao: 'Avulso', preco: 1000n }],
      parcelas: [{ vencimento: DIA, valor: 1000n }] }); if (!v.ok) throw new Error(v.motivo)
    const categoria = await estoque.cadastrarCategoria(`E-33 ${uuidv7()}`); if (!categoria.ok) throw new Error(categoria.motivo)
    const produto = await estoque.cadastrarProduto({ nome: 'Fictício', categoriaId: categoria.valor.id, custoManual: GRANDE }); if (!produto.ok) throw new Error(produto.motivo)
    const compra = await estoque.registrarMovimento({ tipo: 'compra', produtoId: produto.valor.id, data: DIA, quantidade: 5, custoUnitario: GRANDE })
    if (!compra.ok) throw new Error(compra.motivo)
    const g1 = ok(await a.op.registrar(entrada())), g = ok(await a.op.corrigir(g1.operacao.fatos[0]!, entrada(GRANDE + 10n), DIA))
    alvo = g.operacao.id
    const receita = ok(await a.op.registrar({ tipo: 'receita-avulsa', valor: 31n, data: '2026-10-01', categoria: 'Presente livre', classificacao: 'pessoal' }))
    expect((await a.ciclo()).ultimaFalha).toBe('rede')
    expect(await a.repo.sincronizado(g.fatos[0]!.id)).toBe(false)
    // O servidor já confirmou: não é falha simulada antes de gravar.
    const remoto = await nuvem.buscarCaixa('0', 500); if (!remoto.ok) throw new Error(remoto.falha.mensagem)
    expect(remoto.valor.some((r) => grupoCaixaDaNuvem(r['grupo']).operacao.id === alvo)).toBe(true)
    perder = false; expect((await a.ciclo()).ultimaFalha).toBeNull(); expect(chamadas).toBeGreaterThanOrEqual(2)
    const correcao = ok(await a.op.corrigir(g.operacao.fatos[0]!, { ...entrada(8000n), data: '2026-09-29', categoria: 'Outra categoria' }, DIA))
    expect((await a.ciclo()).ultimaFalha).toBeNull()
    const estorno = ok(await a.op.estornar(receita.operacao.fatos[0]!, DIA)); expect((await a.ciclo()).ultimaFalha).toBeNull()
    const b = aparelho(); expect((await b.ciclo()).ultimaFalha).toBeNull()
    await conferir(b, [g, receita, correcao, estorno])
    expect(await a.banco.fila.count()).toBe(0); expect(await b.banco.fila.count()).toBe(0)
    expect(saldo(await criarRepositorioLocal(b.banco).lerFicha(c.valor.id))).toBe(1000n)
    const fisico = projetarEstoque(await b.banco.movimentos.toArray(), produto.valor.id)
    if (!fisico.ok) throw new Error(fisico.motivo)
    expect(fisico.valor.fisico).toBe(5)
    expect(await b.banco.produtos.get(produto.valor.id)).toEqual(await a.banco.produtos.get(produto.valor.id))
    expect(conteudoDoEfeito(ok(projetarCaixa(await b.repo.listarFatos(), await b.banco.lancamentos.toArray(), '2026-09'))))
      .toBe(conteudoDoEfeito(ok(projetarCaixa(await a.repo.listarFatos(), await a.banco.lancamentos.toArray(), '2026-09'))))
  }, 120_000)

  for (const inversa of [false, true]) test(`duas bases corrigem o mesmo alvo; ${inversa ? 'B' : 'A'} chega primeiro e D-070 converge com evidência`, async () => {
    const a = aparelho(), b = aparelho(), g = ok(await a.op.registrar(entrada(100n)))
    expect((await a.ciclo()).ultimaFalha).toBeNull(); expect((await b.ciclo()).ultimaFalha).toBeNull()
    const ca = ok(await a.op.corrigir(g.operacao.fatos[0]!, entrada(80n), DIA))
    const cb = ok(await b.op.corrigir(g.operacao.fatos[0]!, entrada(90n), DIA))
    const primeira = inversa ? b : a, segunda = inversa ? a : b, vencedora = inversa ? cb : ca, recusada = inversa ? ca : cb
    const dependenteAlvo = recusada.fatos.find((f) => f.tipo !== 'estorno'); if (!dependenteAlvo) throw new Error('sem substituto')
    const dependente = ok(await segunda.op.estornar(dependenteAlvo, DIA))
    expect((await primeira.ciclo()).ultimaFalha).toBeNull(); expect((await segunda.ciclo()).ultimaFalha).toBeNull()
    expect((await segunda.banco.fila.toArray()).find((f) => f.registroId === recusada.operacao.id)?.problema).toBeDefined()
    expect(await segunda.banco.fatosCaixa.get(dependenteAlvo.id)).toBeUndefined()
    expect((await segunda.banco.versoesCaixa.toArray()).find((v) => v.operacaoId === dependente.operacao.id)?.foraDaProjecao).toBeDefined()
    await conferir(segunda, [g, vencedora])
    const evidencia = (await segunda.banco.versoesCaixa.toArray()).find((v) => v.operacaoId === recusada.operacao.id)
    expect(evidencia?.grupo).toEqual(recusada); expect(evidencia?.problema).toBeDefined()
    const independente = ok(await segunda.op.registrar({ tipo: 'receita-avulsa', data: DIA, valor: 7n, categoria: 'Livre', classificacao: 'pessoal' }))
    expect((await segunda.ciclo()).ultimaFalha).toBeNull()
    expect(await segunda.repo.sincronizado(independente.fatos[0]!.id)).toBe(true)
    const restaurada = aparelho(); expect((await restaurada.ciclo()).ultimaFalha).toBeNull()
    await conferir(restaurada, [g, vencedora, independente])
  }, 120_000)

  test('edição durante envio conserva r2; recusa real posterior usa r1 aceita e não prende outros fatos', async () => {
    let editar = true, original: GrupoCaixa | undefined
    const a = aparelho(() => ({ ...nuvem, enviarCaixa: async (doc) => {
      const r = await nuvem.enviarCaixa(doc)
      if (r.ok && editar && original?.operacao.id === grupoCaixaDaNuvem(doc).operacao.id) {
        editar = false; ok(await a.op.corrigir(original.operacao.fatos[0]!, entrada(80n), DIA))
      }
      return r
    } }))
    original = ok(await a.op.registrar(entrada(100n)))
    expect((await a.ciclo()).ultimaFalha).toBeNull()
    expect((await a.banco.fila.toArray()).find((f) => f.registroId === original?.operacao.id)?.versao).toBe(2)
    const atual = await a.banco.fatosCaixa.get(original.fatos[0]!.id)
    // INITIAL_SESSION pode pedir outro ciclo antes de sincronizar() devolver. A nova
    // edição só cede ao aceite se esse ciclo já recebeu a recusa definitiva de r2.
    const filaAtual = (await a.banco.fila.toArray()).find((f) => f.registroId === original?.operacao.id)
    expect(atual && atual.tipo !== 'estorno' ? atual.valor : undefined).toBe(filaAtual?.problema ? 100n : 80n)
    const independente = ok(await a.op.registrar(entrada(1n)))
    expect((await a.ciclo()).ultimaFalha).toBeNull()
    expect((await a.banco.fila.toArray()).find((f) => f.registroId === original?.operacao.id)?.problema?.codigo).toBe('23514')
    expect(await a.banco.fatosCaixa.get(original.fatos[0]!.id)).toEqual(original.fatos[0])
    expect(await a.repo.sincronizado(independente.fatos[0]!.id)).toBe(true)
    expect((await a.banco.versoesCaixa.toArray()).filter((v) => v.operacaoId === original?.operacao.id)).toHaveLength(2)
  }, 120_000)

  test('download real truncado é recusado sem publicar metade; repetição íntegra restaura o grupo', async () => {
    const a = aparelho(), g = ok(await a.op.registrar(entrada(100n)))
    expect((await a.ciclo()).ultimaFalha).toBeNull()
    const c = ok(await a.op.corrigir(g.operacao.fatos[0]!, entrada(80n), DIA)); expect((await a.ciclo()).ultimaFalha).toBeNull()
    let truncar = true
    const b = aparelho(() => ({ ...nuvem, buscarCaixa: async (...args) => {
      const r = await nuvem.buscarCaixa(...args)
      return r.ok ? { ok: true, valor: r.valor.map((linha) => {
        const grupo = grupoCaixaDaNuvem(linha['grupo'])
        return truncar && grupo.operacao.id === c.operacao.id ? { ...linha, grupo: { operacao: grupo.operacao, fatos: [] } } : linha
      }) } : r
    } }))
    expect((await b.ciclo()).ultimaFalha).toBe('rede')
    const cursor = (await b.banco.sincronizacao.get('caixa'))?.valor
    expect(cursor).toBeDefined(); expect(await b.banco.fatosCaixa.get(c.fatos[1]!.id)).toBeUndefined()
    expect((await b.banco.versoesCaixa.toArray()).some((v) => v.operacaoId === c.operacao.id)).toBe(false)
    truncar = false; expect((await b.ciclo()).ultimaFalha).toBeNull()
    await conferir(b, [g, c]); expect(BigInt((await b.banco.sincronizacao.get('caixa'))?.valor ?? '0')).toBeGreaterThan(BigInt(cursor ?? '0'))
  }, 120_000)
})
