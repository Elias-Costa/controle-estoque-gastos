import { afterAll, describe, expect, test } from 'bun:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { criarContaFicticia } from '../../ferramentas/conta-ficticia.ts'
import { BancoLocal } from '../../src/dados/banco.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { cadastrarCliente, corrigirVenda, lancarVendaFiado } from '../../src/dados/operacoes.ts'
import { criarRepositorioLocal } from '../../src/dados/repositorio.ts'
import { criarOperacoesEstoque } from '../../src/dados/operacoes-estoque.ts'
import { criarRepositorioEstoque } from '../../src/dados/repositorio-estoque.ts'
import { criarOperacoesCaixa } from '../../src/dados/operacoes-caixa.ts'
import { criarRepositorioCaixa } from '../../src/dados/repositorio-caixa.ts'
import { criarRepositorioCopia } from '../../src/dados/repositorio-copia.ts'
import { criarServicoCopia } from '../../src/sincronizacao/copia.ts'
import { criarNuvemSupabase, type Nuvem } from '../../src/sincronizacao/nuvem.ts'
import { iniciarSincronizacao } from '../../src/sincronizacao/sincronizacao.ts'
import { hashDaFoto } from '../../src/plataforma/fotos.ts'
import { saldo } from '../../src/dominio/ficha.ts'
import { projetarEstoque } from '../../src/dominio/estoque.ts'
import { projetarCaixa } from '../../src/dominio/caixa.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
const bancos: BancoLocal[] = [], clientes: SupabaseClient[] = []
const DIA = '2026-10-24', GRANDE = 9007199254740993n
function ok<T>(r: { ok: true; valor: T } | { ok: false; motivo: string }): T { if (!r.ok) throw new Error(r.motivo); return r.valor }
function aparelho() { const b = new BancoLocal(uuidv7(), { indexedDB: new IDBFactory(), IDBKeyRange }); bancos.push(b); return b }
async function ambiente() {
  const email = await criarContaFicticia(), url = process.env.VITE_SUPABASE_URL ?? ''
  const cliente = createClient(url, process.env.VITE_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } }); clientes.push(cliente)
  const { error } = await cliente.auth.signInWithPassword({ email, password: process.env.SUPABASE_TESTE_SENHA ?? '' })
  if (error) throw error
  return { cliente, nuvem: criarNuvemSupabase(cliente, url) }
}
async function ciclo(banco: BancoLocal, nuvem: Nuvem) {
  const m = iniciarSincronizacao({ banco, nuvem, janela: null, documento: null, agendar: () => () => undefined })
  await m.sincronizar(); const e = m.estado(); m.parar(); return e
}
afterAll(async () => { for (const b of bancos) b.close(); for (const c of clientes) await c.auth.signOut() })

describe.skipIf(!LIGADA)('E-35 arquivo → base vazia → nuvem real da mesma conta', () => {
  test('arquivo antigo com resposta perdida reconcilia cadastro, estoque, caixa e foto antes de reenviar', async () => {
    const { cliente, nuvem } = await ambiente(), a = aparelho()
    const repo = criarRepositorioLocal(a), estoque = criarOperacoesEstoque(criarRepositorioEstoque(a))
    const c = ok(await cadastrarCliente(repo, { nome: 'Nome do arquivo' }))
    const venda = ok(await lancarVendaFiado(repo, { clienteId: c.id, data: DIA, itens: [{ descricao: 'Avulso', preco: GRANDE }], parcelas: [{ vencimento: DIA, valor: GRANDE }] }))
    const categoria = ok(await estoque.cadastrarCategoria('Categoria da cópia'))
    const binario = new Uint8Array(await Bun.file('testes/arquivos/foto-teste.jpeg').arrayBuffer())
    const miniatura = new Uint8Array(await Bun.file('testes/arquivos/foto-teste-miniatura.jpeg').arrayBuffer())
    const produto = ok(await estoque.cadastrarProduto({ nome: 'Produto da cópia', categoriaId: categoria.id },
      { binario, miniatura, sha256: await hashDaFoto(binario), largura: 768, altura: 1024 }))
    const compra = ok(await estoque.registrarMovimento({ tipo: 'compra', produtoId: produto.id, data: DIA, quantidade: 7, custoUnitario: GRANDE }))
    const caixa = criarOperacoesCaixa(criarRepositorioCaixa(a))
    const gasto = ok(await caixa.registrar({ tipo: 'despesa', data: DIA, valor: 10000n, categoria: 'Negócio', classificacao: 'negocio', mercadoria: false }))
    const primeira = await ciclo(a, { ...nuvem, enviarLancamento: async (l) => {
      const r = await nuvem.enviarLancamento(l)
      if (r.ok && l.id === venda.id) return { ok: false, falha: { tipo: 'rede', mensagem: 'resposta perdida após commit real' } }
      return r
    } })
    expect(primeira.ultimaFalha).toBe('rede')
    const copia = await criarServicoCopia(a, nuvem).exportar()
    expect((await ciclo(a, nuvem)).ultimaFalha).toBeNull()
    const cadastro = await a.clientes.get(c.id); if (!cadastro) throw new Error('Cadastro ausente')
    await repo.gravarCliente({ ...cadastro, nome: 'Nome mais novo na conta' })
    const movimento = compra.movimentos[0]; if (!movimento) throw new Error('Compra ausente')
    ok(await estoque.corrigirRegistroMovimento({ id: movimento.id, revisao: movimento.revisao }, { tipo: 'compra', produtoId: produto.id, data: DIA, quantidade: 9, custoUnitario: GRANDE }))
    const fato = gasto.fatos[0]; if (!fato) throw new Error('Gasto ausente')
    ok(await caixa.corrigir(fato, { tipo: 'despesa', data: DIA, valor: 8000n, categoria: 'Negócio', classificacao: 'negocio', mercadoria: false }, DIA))
    expect((await ciclo(a, nuvem)).ultimaFalha).toBeNull()
    expect(await a.fila.count()).toBe(0)
    const antes = await cliente.from('lancamentos').select('id')
    const b = aparelho(), servico = criarServicoCopia(b, nuvem), reserva = await servico.reservarImportacao()
    await servico.importar(copia.arquivo, reserva)
    let reenviosF1 = 0, reenviosGrupo = 0, reenviosCaixa = 0
    const observada: Nuvem = { ...nuvem,
      enviarLancamento: async (l) => { reenviosF1++; return nuvem.enviarLancamento(l) },
      enviarGrupo: async (...args) => { reenviosGrupo++; return nuvem.enviarGrupo(...args) },
      enviarCaixa: async (g) => { reenviosCaixa++; return nuvem.enviarCaixa(g) } }
    expect((await ciclo(b, observada)).ultimaFalha).toBeNull()
    expect(reenviosF1).toBe(0); expect(reenviosGrupo).toBe(0); expect(reenviosCaixa).toBe(0)
    expect((await b.clientes.get(c.id))?.nome).toBe('Nome mais novo na conta')
    expect(saldo(await criarRepositorioLocal(b).lerFicha(c.id))).toBe(GRANDE)
    expect(projetarEstoque(await b.movimentos.toArray(), produto.id)).toMatchObject({ ok: true, valor: { fisico: 9 } })
    expect(projetarCaixa(await b.fatosCaixa.toArray(), await b.lancamentos.toArray(), '2026-10')).toMatchObject({ ok: true, valor: { tudo: { saiu: 8000n } } })
    const restaurada = await b.fotos.get(produto.fotoId ?? '')
    expect(restaurada?.miniatura).toEqual(miniatura)
    const aparelhoId = (await b.estadoFotos.get('aparelho'))?.valor
    expect((await b.protecoesFotos.toArray()).some((p) => p.fotoId === produto.fotoId && p.aparelhoId === aparelhoId && !p.liberar)).toBe(true)
    expect((await b.estadoFotos.get('aparelho'))?.valor).not.toBe((await a.estadoFotos.get('aparelho'))?.valor)
    expect(await b.fila.count()).toBe(0); expect(await criarRepositorioCopia(b).restauracao()).toBeNull()
    expect((await cliente.from('lancamentos').select('id')).data).toEqual(antes.data)
  }, 120_000)

  test('pendência que só estava no arquivo sobe uma vez após falha na reconciliação e resposta perdida', async () => {
    const { nuvem } = await ambiente(), a = aparelho(), op = criarOperacoesCaixa(criarRepositorioCaixa(a))
    const gasto = ok(await op.registrar({ tipo: 'despesa', data: DIA, valor: GRANDE, categoria: 'Só no arquivo', classificacao: 'pessoal', mercadoria: false }))
    const arquivo = await criarServicoCopia(a, nuvem).exportar()
    const b = aparelho(), servico = criarServicoCopia(b, nuvem), id = await servico.reservarImportacao()
    await servico.importar(arquivo.arquivo, id)
    let envios = 0
    const bloqueada: Nuvem = { ...nuvem, buscarClientes: async () => ({ ok: false, falha: { tipo: 'rede', mensagem: 'interrompe antes do envio' } }),
      enviarCaixa: async (g) => { envios++; return nuvem.enviarCaixa(g) } }
    expect((await ciclo(b, bloqueada)).ultimaFalha).toBe('rede'); expect(envios).toBe(0)
    b.close(); await b.open()
    expect((await ciclo(b, { ...nuvem, enviarCaixa: async (g) => {
      envios++; const r = await nuvem.enviarCaixa(g)
      return r.ok ? { ok: false, falha: { tipo: 'rede', mensagem: 'perdida depois do commit' } } : r
    } })).ultimaFalha).toBe('rede')
    expect(await b.fila.count()).toBe(1)
    expect((await ciclo(b, nuvem)).ultimaFalha).toBeNull()
    const remoto = await nuvem.buscarCaixa('0', 500)
    expect(remoto.ok && remoto.valor.length).toBe(1)
    expect((await b.fatosCaixa.toArray())[0]?.id).toBe(gasto.fatos[0]?.id)
    expect(await b.fila.count()).toBe(0)
  }, 120_000)

  test('correção de caixa antiga conserva tentativa fora do total sem fabricar recusa nem reenviar', async () => {
    const { nuvem } = await ambiente(), a = aparelho(), antiga = aparelho()
    const caixa = criarOperacoesCaixa(criarRepositorioCaixa(a))
    const gasto = ok(await caixa.registrar({ tipo: 'despesa', data: DIA, valor: 10000n, categoria: 'Conferência do arquivo', classificacao: 'negocio', mercadoria: false }))
    expect((await ciclo(a, nuvem)).ultimaFalha).toBeNull()
    expect((await ciclo(antiga, nuvem)).ultimaFalha).toBeNull()
    const alvo = gasto.fatos[0]; if (!alvo) throw new Error('Sem gasto')
    const tentativa = ok(await criarOperacoesCaixa(criarRepositorioCaixa(antiga)).corrigir(alvo,
      { tipo: 'despesa', data: DIA, valor: 6000n, categoria: 'Tentativa no arquivo', classificacao: 'negocio', mercadoria: false }, DIA))
    const arquivo = await criarServicoCopia(antiga, nuvem).exportar()
    ok(await caixa.corrigir(alvo, { tipo: 'despesa', data: DIA, valor: 8000n, categoria: 'Aceito mais novo', classificacao: 'negocio', mercadoria: false }, DIA))
    expect((await ciclo(a, nuvem)).ultimaFalha).toBeNull()
    const b = aparelho(), servico = criarServicoCopia(b, nuvem)
    await servico.importar(arquivo.arquivo, await servico.reservarImportacao())
    let enviados = 0
    expect((await ciclo(b, { ...nuvem, enviarCaixa: async (g) => { enviados++; return nuvem.enviarCaixa(g) } })).ultimaFalha).toBeNull()
    expect(enviados).toBe(0)
    expect(projetarCaixa(await b.fatosCaixa.toArray(), [], '2026-10')).toMatchObject({ ok: true, valor: { tudo: { saiu: 8000n } } })
    const evidencia = (await b.versoesCaixa.toArray()).find((v) => v.operacaoId === tentativa.operacao.id)
    expect(evidencia?.restaurada).toBe(true); expect(evidencia?.foraDaProjecao).toBeDefined(); expect(evidencia?.problema).toBeUndefined()
    expect(evidencia?.grupo).toEqual(tentativa)
    expect(await b.fila.where('registroId').equals(tentativa.operacao.id).count()).toBe(1)
    const novaCopia = await criarServicoCopia(b, nuvem).exportar()
    expect(novaCopia.arquivo.size).toBeGreaterThan(0)
  }, 120_000)

  test('colisão F1 preserva tentativa do arquivo e usa aceite, sem sobrescrita remota', async () => {
    const { nuvem } = await ambiente(), a = aparelho(), repo = criarRepositorioLocal(a)
    const c = ok(await cadastrarCliente(repo, { nome: 'Colisão no arquivo' }))
    const v = ok(await lancarVendaFiado(repo, { clienteId: c.id, data: DIA, itens: [{ descricao: 'Avulso', preco: 10000n }], parcelas: [{ vencimento: DIA, valor: 10000n }] }))
    expect((await ciclo(a, { ...nuvem, enviarLancamento: async (l) => {
      const r = await nuvem.enviarLancamento(l)
      return r.ok ? { ok: false, falha: { tipo: 'rede', mensagem: 'resposta perdida' } } : r
    } })).ultimaFalha).toBe('rede')
    if (v.tipo !== 'venda' || v.pagamento !== 'fiado') throw new Error('Venda inesperada')
    ok(await corrigirVenda(repo, { ...v, itens: [{ descricao: 'Avulso corrigido', preco: 12000n }], parcelas: v.parcelas.map((p) => ({ ...p, valor: 12000n })) },
      { sincronizado: false }))
    const arquivo = await criarServicoCopia(a, nuvem).exportar(), b = aparelho(), servico = criarServicoCopia(b, nuvem)
    await servico.importar(arquivo.arquivo, await servico.reservarImportacao())
    let enviados = 0
    expect((await ciclo(b, { ...nuvem, enviarLancamento: async (l) => { enviados++; return nuvem.enviarLancamento(l) } })).ultimaFalha).toBeNull()
    expect(enviados).toBe(0)
    expect(saldo(await criarRepositorioLocal(b).lerFicha(c.id))).toBe(10000n)
    expect((await b.evidenciasCopia.get(v.id))?.tentativa).toMatchObject({ itens: [{ preco: 12000n }] })
    expect((await b.evidenciasCopia.get(v.id))?.aceita).toMatchObject({ itens: [{ preco: 10000n }] })
    expect(await b.fila.count()).toBe(0)
  }, 120_000)
})
