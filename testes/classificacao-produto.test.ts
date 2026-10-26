import { afterEach, describe, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { createClient } from '@supabase/supabase-js'
import { BancoLocal, ESQUEMA_V4, type ProdutoLocal } from '../src/dados/banco.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { criarRepositorioFotos } from '../src/dados/fotos.ts'
import { produtoRecebido } from '../src/dados/receber-produto.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { novoProduto, type ClassificacaoProduto } from '../src/dominio/produtos.ts'
import { documentoProduto, produtoDaNuvem, produtoParaLinha, COLUNAS_PRODUTO } from '../src/sincronizacao/borda-estoque.ts'
import { criarNuvemSupabase, type Nuvem } from '../src/sincronizacao/nuvem.ts'
import { criarSincronizacaoFotos } from '../src/sincronizacao/fotos.ts'
import { iniciarSincronizacao } from '../src/sincronizacao/sincronizacao.ts'
import { conferirProduto, rascunhoDoProduto } from '../src/interface/rascunho-do-produto.ts'
import { ok } from './apoio-estoque.ts'

const CARIMBO = '2026-10-25T12:00:00.000Z'
const categoria = { id: 'categoria', nome: 'Perfumes' }
const antigo: ProdutoLocal = { id: 'produto', nome: 'Perfume', categoriaId: categoria.id,
  marca: 'Marca', codigoCatalogo: '001', precoVenda: 9007199254740993n, custoManual: 1234n, atualizadoEm: CARIMBO }
const valores: readonly ClassificacaoProduto[] = ['feminino', 'masculino', 'unissex', 'nao-se-aplica']
const bancos: Dexie[] = []
afterEach(() => { for (const banco of bancos.splice(0)) banco.close() })
function abrir(indexedDB = new IDBFactory(), nome = uuidv7()) {
  const banco = new BancoLocal(nome, { indexedDB, IDBKeyRange }); bancos.push(banco); return banco
}

describe('E-28B — classificação opcional e compatibilidade D-074/075', () => {
  for (const classificacao of valores) test(`formulário e borda conservam ${classificacao} e centavos`, () => {
    const produto = { ...antigo, classificacao }
    expect(ok(novoProduto(produto, [categoria]))).toEqual(produto)
    expect(ok(conferirProduto(rascunhoDoProduto(produto), [categoria], produto))).toMatchObject({ classificacao, precoVenda: antigo.precoVenda })
    const linha = { ...produtoParaLinha(produto), atualizado_em: CARIMBO }
    expect(produtoDaNuvem(linha)).toEqual({ ...produto, classificacaoConhecida: true })
    expect(COLUNAS_PRODUTO.split(', ')).toContain('classificacao')
    expect(documentoProduto(produto)).toMatchObject({ classificacao, precoVenda: String(antigo.precoVenda) })
  })

  test('ausência, não se aplica e remoção explícita são distintas; metadado local nunca sobe', () => {
    expect(Object.hasOwn(documentoProduto(antigo), 'classificacao')).toBe(false)
    expect(documentoProduto({ ...antigo, classificacaoConhecida: true })['classificacao']).toBeNull()
    expect(documentoProduto({ ...antigo, classificacao: 'nao-se-aplica' })['classificacao']).toBe('nao-se-aplica')
    expect(Object.hasOwn(documentoProduto({ ...antigo, classificacaoConhecida: true }), 'classificacaoConhecida')).toBe(false)
    expect(rascunhoDoProduto(antigo).classificacao).toBe('')
    const removido = ok(conferirProduto({ ...rascunhoDoProduto(antigo), classificacao: '' }, [categoria], { ...antigo, classificacao: 'unissex' }))
    expect(removido.classificacao).toBeUndefined()
    expect(produtoDaNuvem({ ...produtoParaLinha(antigo), atualizado_em: CARIMBO }).classificacao).toBeUndefined()
  })

  test('valores desconhecidos não entram pelo domínio, formulário ou download', () => {
    for (const classificacao of ['', 'outro', 'Feminino', 1, false, {}, []]) {
      const invalido = { ...antigo }
      Reflect.set(invalido, 'classificacao', classificacao)
      expect(novoProduto(invalido, [categoria]).ok).toBe(false)
      expect(() => produtoDaNuvem({ ...produtoParaLinha(antigo), atualizado_em: CARIMBO, classificacao })).toThrow()
    }
    expect(conferirProduto({ ...rascunhoDoProduto(antigo), classificacao: 'outro' }, [categoria])).toEqual({ ok: false, motivo: 'classificacao-invalida' })
  })

  test('empate completa só o desconhecimento legado; LWW novo/antigo e demais campos permanecem', () => {
    const remoto = { ...antigo, nome: 'Outro nome', classificacao: 'unissex', classificacaoConhecida: true } as const
    expect(produtoRecebido(antigo, remoto)).toEqual({ ...antigo, classificacao: 'unissex', classificacaoConhecida: true })
    const novo = { ...antigo, classificacaoConhecida: true } as const
    expect(produtoRecebido(novo, remoto)).toBe(novo)
    expect(produtoRecebido(antigo, { ...remoto, atualizadoEm: '2026-10-24T12:00:00.000Z' })).toBe(antigo)
    expect(produtoRecebido(novo, { ...remoto, atualizadoEm: '2026-10-26T12:00:00.000Z' }).nome).toBe('Outro nome')
  })

  test('base F2 preenchida ganha upgrade aditivo sem mudar fila/recusas, fotos, captura antiga ou financeiro', async () => {
    const indexedDB = new IDBFactory(), nome = uuidv7()
    const legado = new Dexie(nome, { indexedDB, IDBKeyRange }); bancos.push(legado)
    legado.version(4).stores(ESQUEMA_V4)
    await legado.table('categorias').put(categoria)
    await legado.table('produtos').put(antigo)
    await legado.table('enviosProdutoFoto').put({ id: 'captura-antiga', produtoId: antigo.id, cadastro: antigo })
    await legado.table('fotos').put({ id: 'foto', produtoId: antigo.id, binario: new Uint8Array([1, 2]), miniatura: new Uint8Array([3]) })
    await legado.table('fila').add({ tabela: 'produtos', registroId: antigo.id, criadoEm: CARIMBO, versao: 4 })
    await legado.table('fila').add({ tabela: 'lancamentos', registroId: 'recusa', criadoEm: CARIMBO, problema: { codigo: '23514', mensagem: 'conservada', em: CARIMBO } })
    await legado.table('lancamentos').put({ id: 'recebimento', clienteId: 'cliente', tipo: 'recebimento', data: '2026-10-25', valor: 1234n, forma: 'pix' })
    const antes = await Promise.all(['fotos', 'lancamentos', 'enviosProdutoFoto'].map((tabela) => legado.table(tabela).toArray()))
    legado.close()
    const banco = abrir(indexedDB, nome)
    expect(await banco.produtos.get(antigo.id)).toEqual(antigo)
    const repo = criarRepositorioEstoque(banco, () => CARIMBO)
    ok(await repo.salvarProduto({ ...antigo, classificacao: 'masculino' }))
    banco.close()
    const reaberto = abrir(indexedDB, nome)
    expect(reaberto.verno).toBe(8)
    expect(await reaberto.produtos.get(antigo.id)).toEqual({ ...antigo, classificacao: 'masculino', classificacaoConhecida: true })
    expect(await Promise.all(['fotos', 'lancamentos', 'enviosProdutoFoto'].map((tabela) => reaberto.table(tabela).toArray()))).toEqual(antes)
    expect((await reaberto.fila.toArray())[0]?.versao).toBe(5)
    expect((await reaberto.fila.toArray())[1]?.problema?.mensagem).toBe('conservada')
    const captura = await reaberto.enviosProdutoFoto.get('captura-antiga')
    expect(captura && Object.hasOwn(documentoProduto(captura.cadastro), 'classificacao')).toBe(false)
    ok(await criarRepositorioEstoque(reaberto).salvarProduto(antigo))
    const removido = await reaberto.produtos.get(antigo.id)
    expect(removido && documentoProduto(removido)['classificacao']).toBeNull()
  })

  test('falha na fila desfaz classificação/cadastro juntos; captura nova conserva remoção após reabrir', async () => {
    const banco = abrir(), repo = criarRepositorioEstoque(banco, () => CARIMBO)
    await banco.categorias.put(categoria); await banco.produtos.put(antigo)
    const falhar = () => { throw new Error('interrupção deliberada') }
    banco.fila.hook('creating', falhar)
    try { await repo.salvarProduto({ ...antigo, classificacao: 'feminino' }); throw new Error('aceitou falha') }
    catch (erro) { expect(String(erro)).toContain('interrupção deliberada') }
    expect(await banco.produtos.get(antigo.id)).toEqual(antigo)
    expect(await banco.fila.count()).toBe(0)
    banco.fila.hook('creating').unsubscribe(falhar)
    ok(await repo.salvarProduto(antigo))
    const produto = await banco.produtos.get(antigo.id)
    if (!produto) throw new Error('sem produto')
    const captura = await criarRepositorioFotos(banco).capturarProduto(produto)
    expect(documentoProduto(captura.cadastro)['classificacao']).toBeNull()
  })

  test('portas F2.1 conservam linhas e versões v5–v7 quando acopladas ao esquema F3 existente', async () => {
    // Literais F3 de 3bececc: este teste não rebaixa uma base v7 para o app F2.1/v4.
    const v5 = { ...ESQUEMA_V4, fatosCaixa: 'id', operacoesCaixa: 'id', versoesCaixa: 'id, operacaoId' }
    const v6 = { ...v5, controleCopia: 'chave', estagiosCopia: 'id', lotesCopia: 'id, operacaoId', evidenciasCopia: 'id' }
    const v7 = { ...v6, modelos: 'chave' }
    const indexedDB = new IDBFactory(), nome = uuidv7()
    const legado = new Dexie(nome, { indexedDB, IDBKeyRange }); bancos.push(legado)
    legado.version(7).stores(v7)
    await legado.table('categorias').put(categoria); await legado.table('produtos').put(antigo)
    const tabelasF3 = ['fatosCaixa', 'operacoesCaixa', 'versoesCaixa', 'controleCopia', 'estagiosCopia', 'lotesCopia', 'evidenciasCopia', 'modelos']
    for (const tabela of tabelasF3) await legado.table(tabela).put({ id: tabela, chave: tabela, valor: 12345678901234567n })
    const antes = await Promise.all(tabelasF3.map((tabela) => legado.table(tabela).toArray()))
    legado.close()
    const banco = abrir(indexedDB, nome)
    banco.version(5).stores(v5); banco.version(6).stores(v6); banco.version(7).stores(v7)
    ok(await criarRepositorioEstoque(banco).salvarProduto({ ...antigo, classificacao: 'unissex' }))
    expect(banco.verno).toBe(8)
    expect(await Promise.all(tabelasF3.map((tabela) => banco.table(tabela).toArray()))).toEqual(antes)
    expect((await banco.produtos.get(antigo.id))?.classificacao).toBe('unissex')
  })

  test('motor de fotos retoma captura legada e envia remoção nova sem converter omissão em null', async () => {
    const banco = abrir(), repo = criarRepositorioFotos(banco)
    await repo.capturarProduto(antigo)
    const base = criarNuvemSupabase(createClient('http://127.0.0.1:9', 'ficticia', { auth: { persistSession: false, autoRefreshToken: false } }))
    if (!base.fotos) throw new Error('transporte de fotos ausente')
    const enviados: Record<string, unknown>[] = []
    const nuvem: Nuvem = { ...base, enviarProduto: async (documento) => { enviados.push(documento); return { ok: true, valor: undefined } } }
    const ciclo = criarSincronizacaoFotos(banco, nuvem, base.fotos)
    await ciclo.enviarProduto({ ...antigo, classificacaoConhecida: true, atualizadoEm: '2026-10-25T13:00:00.000Z' })
    expect(enviados).toHaveLength(2)
    expect(Object.hasOwn(enviados[0] ?? {}, 'classificacao')).toBe(false)
    expect(enviados[1]?.['classificacao']).toBeNull()
    expect(await banco.enviosProdutoFoto.count()).toBe(0)
  })

  test('download malformado não troca cadastro nem avança cursor e retoma após correção', async () => {
    const banco = abrir()
    await banco.categorias.put(categoria); await banco.produtos.put(antigo)
    await banco.sincronizacao.put({ chave: 'produtos', valor: CARIMBO })
    const base = criarNuvemSupabase(createClient('http://127.0.0.1:9', 'ficticia', { auth: { persistSession: false, autoRefreshToken: false } }))
    const { fotos: _fotos, identidadeLoja: _identidadeLoja, ...metadados } = base
    let classificacao = 'inválida'
    const nuvem: Nuvem = { ...metadados, temSessao: async () => true, aoMudarSessao: () => () => undefined,
      buscarClientes: async () => ({ ok: true, valor: [] }), buscarLancamentos: async () => ({ ok: true, valor: [] }),
      buscarCategorias: async () => ({ ok: true, valor: [categoria] }), buscarEstoque: async () => ({ ok: true, valor: [] }),
      buscarProdutos: async () => ({ ok: true, valor: [{ ...produtoParaLinha(antigo), classificacao,
        atualizado_em: '2026-10-25T13:00:00.000Z', recebido_em: '2026-10-25T13:00:00.000Z' }] }) }
    const motor = iniciarSincronizacao({ banco, nuvem, agendar: () => () => undefined, janela: null, documento: null })
    try {
      await motor.sincronizar()
      expect(motor.estado().ultimaFalha).toBe('rede')
      expect(await banco.produtos.get(antigo.id)).toEqual(antigo)
      expect((await banco.sincronizacao.get('produtos'))?.valor).toBe(CARIMBO)
      classificacao = 'unissex'; await motor.sincronizar()
      expect(motor.estado().ultimaFalha).toBeNull()
      expect((await banco.produtos.get(antigo.id))?.classificacao).toBe('unissex')
      expect((await banco.sincronizacao.get('produtos'))?.valor).toBe('2026-10-25T13:00:00.000Z')
    } finally { motor.parar() }
  })
})
