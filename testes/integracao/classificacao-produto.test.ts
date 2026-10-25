import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar, lerMigracoes } from '../../nuvem/migrar.ts'
import { BancoLocal } from '../../src/dados/banco.ts'
import { criarRepositorioEstoque } from '../../src/dados/repositorio-estoque.ts'
import { criarRepositorioFotos } from '../../src/dados/fotos.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { documentoProduto } from '../../src/sincronizacao/borda-estoque.ts'
import { criarNuvemSupabase, type Nuvem } from '../../src/sincronizacao/nuvem.ts'
import { iniciarSincronizacao } from '../../src/sincronizacao/sincronizacao.ts'
import { ok } from '../apoio-estoque.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
const A = '00000000-0000-4000-8000-00000000280a', B = '00000000-0000-4000-8000-00000000280b'
const T = '2026-10-25T12:00:00.000Z', DEPOIS = '2026-10-25T12:01:00.000Z'
let sql: SQL
let cliente: SupabaseClient
let nuvem: Nuvem
const bancos: BancoLocal[] = []
class Revertida extends Error {}
beforeAll(async () => {
  if (!LIGADA) return
  sql = conectar()
  cliente = createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.VITE_SUPABASE_ANON_KEY ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await cliente.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '', password: process.env.SUPABASE_TESTE_SENHA ?? '' })
  if (error) throw new Error(error.message)
  // Metadados reais; as fotos/Canvas/Storage são exercitados no build Chromium.
  const { fotos: _fotos, ...metadados } = criarNuvemSupabase(cliente)
  nuvem = metadados
})
afterAll(async () => {
  for (const banco of bancos) banco.close()
  if (LIGADA) { await cliente.auth.signOut(); await sql.close() }
})
async function assumir(tx: SQL, conta = A) {
  await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: conta, role: 'authenticated' })},true)`
}
async function transacao(fn: (tx: TransactionSQL) => Promise<void>) {
  try { await sql.begin(async (tx) => {
    await assumir(tx)
    if (process.env.MUTACAO_CLASSIFICACAO) await tx.unsafe(process.env.MUTACAO_CLASSIFICACAO)
    await fn(tx); throw new Revertida()
  }) } catch (erro) { if (!(erro instanceof Revertida)) throw erro }
}
async function recusar(tx: TransactionSQL, fn: (sp: SQL) => Promise<unknown>) {
  try { await tx.savepoint(fn) } catch (erro) {
    if (!(erro instanceof SQL.PostgresError)) throw erro
    expect(erro.errno ?? erro.code).toMatch(/^(22|23|42)/); return
  }
  throw new Error('classificação inválida foi aceita')
}
async function preparar(tx: SQL) {
  const categoriaId = uuidv7(), id = uuidv7()
  await tx`select public.gravar_categoria_estoque(${ { id: categoriaId, nome: 'Perfumes fictícios E-28B' } }::jsonb)`
  const cadastro = { id, categoriaId, nome: 'Perfume E-28B', atualizadoEm: T, custoManual: '9007199254740993', precoVenda: '0' }
  await tx`select public.gravar_produto_estoque(${cadastro}::jsonb)`
  return cadastro
}
async function ler(tx: SQL, id: string) {
  const [linha] = await tx<{ classificacao: string | null; nome: string; custo: string }[]>`
    select classificacao,nome,custo_manual::text custo from public.produtos where id=${id}::uuid`
  if (!linha) throw new Error('produto ausente')
  return linha
}
function aparelho(transporte: () => Nuvem = () => nuvem) {
  const banco = new BancoLocal(uuidv7(), { indexedDB: new IDBFactory(), IDBKeyRange }); bancos.push(banco)
  let carimbo = T
  const repo = criarRepositorioEstoque(banco, () => carimbo)
  async function ciclo(falha: 'rede' | null = null) {
    const motor = iniciarSincronizacao({ banco, nuvem: { ...transporte(), aoMudarSessao: () => () => undefined }, agendar: () => () => undefined, janela: null, documento: null })
    try { await motor.sincronizar(); expect(motor.estado().ultimaFalha).toBe(falha); return motor.estado() }
    finally { motor.parar() }
  }
  return { banco, repo, ciclo, relogio: (valor: string) => { carimbo = valor } }
}

describe.skipIf(!LIGADA)('E-28B classificação no Postgres e transporte real', () => {
  test('valores fechados, null/legado, LWW nas duas ordens e empate sem alterar dinheiro', async () => {
    await transacao(async (tx) => {
      const cadastro = await preparar(tx)
      for (const classificacao of ['feminino', 'masculino', 'unissex', 'nao-se-aplica', null]) {
        await tx`select public.gravar_produto_estoque(${ { ...cadastro, classificacao } }::jsonb)`
        expect(await ler(tx, cadastro.id)).toEqual({ classificacao, nome: cadastro.nome, custo: cadastro.custoManual })
      }
      await tx`select public.gravar_produto_estoque(${ { ...cadastro, classificacao: 'unissex' } }::jsonb)`
      await tx`select public.gravar_produto_estoque(${ { ...cadastro, nome: 'Legado empatado' } }::jsonb)`
      expect((await ler(tx, cadastro.id)).classificacao).toBe('unissex')
      await tx`select public.gravar_produto_estoque(${ { ...cadastro, nome: 'Legado mais novo', atualizadoEm: DEPOIS } }::jsonb)`
      await tx`select public.gravar_produto_estoque(${ { ...cadastro, classificacao: null } }::jsonb)`
      expect(await ler(tx, cadastro.id)).toEqual({ classificacao: 'unissex', nome: 'Legado mais novo', custo: cadastro.custoManual })
      await tx`select public.gravar_produto_estoque(${ { ...cadastro, classificacao: 'feminino', atualizadoEm: DEPOIS } }::jsonb)`
      await tx`select public.gravar_produto_estoque(${cadastro}::jsonb)`
      expect((await ler(tx, cadastro.id)).classificacao).toBe('feminino')
      for (const classificacao of ['', 'outro', 'Feminino', 0, false, {}, []]) {
        await recusar(tx, (sp) => sp`select public.gravar_produto_estoque(${ { ...cadastro, classificacao } }::jsonb)`)
      }
      await recusar(tx, (sp) => sp`update public.produtos set classificacao='inventada' where id=${cadastro.id}::uuid`)
    })
  })

  test('RLS/ACL e leitura protegida incluem classificação sem expor outra conta', async () => {
    await transacao(async (tx) => {
      const cadastro = await preparar(tx)
      await tx`select public.gravar_produto_estoque(${ { ...cadastro, classificacao: 'masculino' } }::jsonb)`
      await tx.unsafe('set local role authenticated')
      const aparelho = uuidv7(), geracao = uuidv7()
      const r = await tx<{ dados: Record<string, unknown> }[]>`select public.buscar_produtos_fotos(${aparelho}::uuid,${geracao}::uuid) dados`
      expect(r.find((p) => p.dados['id'] === cadastro.id)?.dados['classificacao']).toBe('masculino')
      await assumir(tx, B)
      expect(await tx`select classificacao from public.produtos where id=${cadastro.id}::uuid`).toHaveLength(0)
      await recusar(tx, (sp) => sp`select public.gravar_produto_estoque(${ { ...cadastro, classificacao: null } }::jsonb)`)
      await tx.unsafe('set local role anon')
      await recusar(tx, (sp) => sp`select public.gravar_produto_estoque(${cadastro}::jsonb)`)
    })
  })

  test('migration isolada em F2 preenchida aplica/reverte vazia e recusa perda; nenhuma dependência F3', async () => {
    await transacao(async (tx) => {
      const prefixo = `e28b_${uuidv7().replaceAll('-', '')}`
      const migracoes = await lerMigracoes(), melhoria = migracoes.find((m) => m.nome.startsWith('0010_'))
      if (!melhoria) throw new Error('0010 ausente')
      const realocar = (texto: string) => texto.replaceAll('public.', `${prefixo}.`)
        .replaceAll('estoque_interno', `${prefixo}_estoque`).replaceAll('fotos_interno', `${prefixo}_fotos`)
        .replaceAll('fotos_objetos_', `${prefixo}_objetos_`)
      await tx.unsafe(`create schema ${prefixo}; grant usage on schema ${prefixo} to authenticated`)
      for (const m of migracoes.filter((m) => m.nome < '0008')) await tx.unsafe(realocar(m.aplicar))
      const id = uuidv7(), categoriaId = uuidv7(), clienteId = uuidv7()
      await tx.unsafe(`select ${prefixo}.gravar_categoria_estoque($1::jsonb)`, [{ id: categoriaId, nome: 'Categoria anterior' }])
      const cadastro = { id, categoriaId, nome: 'Anterior', atualizadoEm: T, custoManual: '9007199254740993' }
      await tx.unsafe(`select ${prefixo}.gravar_produto_estoque($1::jsonb)`, [cadastro])
      await tx.unsafe(`insert into ${prefixo}.clientes(id,nome) values($1,'Ficha anterior')`, [clienteId])
      await tx.unsafe(`insert into ${prefixo}.lancamentos(id,cliente_id,data,tipo,pagamento,itens,desconto,parcelas)
        values($1,$2,'2026-10-25','venda','fiado',$3::jsonb,0,$4::jsonb)`,
      [uuidv7(), clienteId, [{ descricao: 'Venda anterior', preco: '5000' }], [{ id: uuidv7(), vencimento: '2026-11-25', valor: '5000' }]])
      const operacaoId = uuidv7(), movimentoId = uuidv7()
      await tx.unsafe(`select ${prefixo}.aceitar_grupo_estoque($1::jsonb)`, [{
        operacao: { id: operacaoId, revisao: 1, formato: 1, tipo: 'movimento', lancamentos: [], movimentos: [{ id: movimentoId, revisao: 1 }], dependencias: [] },
        lancamentos: [], movimentos: [{ id: movimentoId, revisao: 1, operacaoId, produtoId: id, data: '2026-10-25', tipo: 'compra',
          quantidade: 3, custoUnitario: '9007199254740993', ordemCadastro: '123', conhecidos: [] }],
      }])
      const tabelas = ['clientes', 'lancamentos', 'categorias', 'movimentos_estoque', 'operacoes_estoque', 'encerramentos_estoque']
      const historico = []
      for (const tabela of tabelas) historico.push(await tx.unsafe(`select to_jsonb(t) linha from ${prefixo}.${tabela} t order by id`))
      const antes = await tx.unsafe(`select to_jsonb(p) linha from ${prefixo}.produtos p`)
      await tx.unsafe(realocar(melhoria.aplicar))
      const depois = await tx.unsafe(`select to_jsonb(p)-'classificacao' linha from ${prefixo}.produtos p`)
      expect(depois).toEqual(antes)
      for (const [indice, tabela] of tabelas.entries()) expect(await tx.unsafe(`select to_jsonb(t) linha from ${prefixo}.${tabela} t order by id`)).toEqual(historico[indice])
      await tx.unsafe(realocar(melhoria.reverter))
      await tx.unsafe(realocar(melhoria.aplicar))
      await tx.unsafe(`select ${prefixo}.gravar_produto_estoque($1::jsonb)`, [{ ...cadastro, classificacao: 'unissex' }])
      await recusar(tx, (sp) => sp.unsafe(realocar(melhoria.reverter)))
      expect((await tx.unsafe(`select classificacao from ${prefixo}.produtos where id=$1`, [id]))[0]?.classificacao).toBe('unissex')
      expect((await tx.unsafe(`select nome from ${prefixo}.clientes where id=$1`, [clienteId]))[0]?.nome).toBe('Ficha anterior')
    })
  })

  test('duas conexões disputam cadastro: omissão legada conserva a classificação sob trava nas duas ordens', async () => {
    const segunda = conectar(), monitor = conectar()
    try {
      for (const novoPrimeiro of [true, false]) {
        const conta = uuidv7()
        const cadastro = await sql.begin(async (tx) => { await assumir(tx, conta); return preparar(tx) })
        const [sessao] = await segunda<{ pid: number }[]>`select pg_backend_pid() pid`
        if (!sessao) throw new Error('sem conexão concorrente')
        let avisar = () => {}, soltar = () => {}
        const pronta = new Promise<void>((resolve) => { avisar = resolve })
        const trava = new Promise<void>((resolve) => { soltar = resolve })
        const primeira = sql.begin(async (tx) => {
          await assumir(tx, conta)
          await tx`select public.gravar_produto_estoque(${ { ...cadastro, nome: 'Primeira', atualizadoEm: DEPOIS,
            ...(novoPrimeiro && { classificacao: 'feminino' }) } }::jsonb)`
          avisar(); await trava
        })
        await Promise.race([pronta, primeira])
        const concorrente = segunda.begin(async (tx) => {
          await assumir(tx, conta)
          await tx`select public.gravar_produto_estoque(${ { ...cadastro, nome: 'Segunda', atualizadoEm: '2026-10-25T12:02:00.000Z',
            ...(!novoPrimeiro && { classificacao: 'unissex' }) } }::jsonb)`
        })
        try {
          let bloqueada = false
          for (let tentativa = 0; tentativa < 100; tentativa++) {
            const [estado] = await monitor<{ espera: string | null }[]>`select wait_event_type espera from pg_stat_activity where pid=${sessao.pid}`
            if (estado?.espera === 'Lock') { bloqueada = true; break }
            await Bun.sleep(10)
          }
          expect(bloqueada).toBe(true)
        } finally { soltar(); await Promise.all([primeira, concorrente]) }
        expect(await ler(sql, cadastro.id)).toEqual({ nome: 'Segunda', classificacao: novoPrimeiro ? 'feminino' : 'unissex', custo: cadastro.custoManual })
      }
    } finally { await segunda.close(); await monitor.close() }
  })

  test('reenvio com resposta perdida, remoção editada em trânsito, dois aparelhos e restauração integral', async () => {
    let perder = true, editar = false
    const a = aparelho(() => ({ ...nuvem, enviarProduto: async (cadastro) => {
      const resposta = await nuvem.enviarProduto(cadastro)
      if (editar) {
        editar = false; a.relogio('2026-10-25T12:02:00.000Z')
        const p = await a.banco.produtos.get(String(cadastro['id']))
        if (!p) throw new Error('produto ausente')
        const { classificacao: _classificacao, ...sem } = p
        ok(await a.repo.salvarProduto(sem))
      }
      if (resposta.ok && perder) { perder = false; return { ok: false, falha: { tipo: 'rede', mensagem: 'resposta perdida após commit' } } }
      return resposta
    } }))
    const categoria = ok(await a.repo.cadastrarCategoria(`Categoria E-28B ${uuidv7()}`))
    const p = { id: uuidv7(), categoriaId: categoria.id, nome: 'Perfume de teste', classificacao: 'unissex', precoVenda: 9007199254740993n } as const
    ok(await a.repo.salvarProduto(p))
    await a.ciclo('rede'); expect(await a.banco.fila.count()).toBe(1)
    editar = true
    await a.ciclo()
    expect(await a.banco.fila.count()).toBe(1)
    await a.ciclo(); expect(await a.banco.fila.count()).toBe(0)
    const b = aparelho(); await b.ciclo()
    expect(await b.banco.produtos.get(p.id)).toEqual(await a.banco.produtos.get(p.id))
    expect((await b.banco.produtos.get(p.id))?.classificacao).toBeUndefined()
    b.relogio('2026-10-25T12:03:00.000Z'); ok(await b.repo.salvarProduto({ ...p, classificacao: 'feminino' })); await b.ciclo()
    await a.ciclo(); expect((await a.banco.produtos.get(p.id))?.classificacao).toBe('feminino')
    const restaurado = aparelho(); await restaurado.ciclo()
    expect(await restaurado.banco.produtos.get(p.id)).toEqual(await a.banco.produtos.get(p.id))
    const { data, error } = await cliente.from('produtos').select('id').eq('id', p.id)
    expect(error).toBeNull(); expect(data).toHaveLength(1)
  })

  test('captura durável anterior à atualização não remove classificação remota ao retomar', async () => {
    const a = aparelho()
    const categoria = ok(await a.repo.cadastrarCategoria(`Legado E-28B ${uuidv7()}`))
    await a.ciclo()
    const legado = { id: uuidv7(), categoriaId: categoria.id, nome: 'Edição antiga mais nova', atualizadoEm: DEPOIS }
    await a.banco.produtos.put(legado)
    await a.banco.fila.add({ tabela: 'produtos', registroId: legado.id, criadoEm: DEPOIS })
    const captura = await criarRepositorioFotos(a.banco).capturarProduto(legado)
    expect((await nuvem.enviarProduto({ ...legado, nome: 'Classificado antes', atualizadoEm: T, classificacao: 'unissex' })).ok).toBe(true)
    // O envio usa a mesma borda das capturas de fotos e conserva a omissão antiga.
    expect((await nuvem.enviarProduto(documentoProduto(captura.cadastro))).ok).toBe(true)
    await a.ciclo()
    expect(await a.banco.produtos.get(legado.id)).toMatchObject({ nome: legado.nome, classificacao: 'unissex', classificacaoConhecida: true })
  })
})
