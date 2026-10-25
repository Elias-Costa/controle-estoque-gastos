import { afterEach, describe, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { readFileSync } from 'node:fs'
import { BancoLocal, ESQUEMA_V3 } from '../src/dados/banco.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { chaveDaProtecao, criarRepositorioFotos } from '../src/dados/fotos.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import type { FotoPreparada, ProtecaoFoto } from '../src/dados/tipos-fotos.ts'
import { createClient } from '@supabase/supabase-js'
import { criarNuvemSupabase } from '../src/sincronizacao/nuvem.ts'
import { iniciarSincronizacao } from '../src/sincronizacao/sincronizacao.ts'

// Arquivos JPEG reais gerados por Canvas no ensaio: desenho sintético transparente sobre branco.
// Esta suíte prova transação/reabertura e proteção, não o encoder nem o iPhone.
const binario = new Uint8Array(readFileSync(new URL('./arquivos/foto-teste.jpeg', import.meta.url)))
const miniatura = new Uint8Array(readFileSync(new URL('./arquivos/foto-teste-miniatura.jpeg', import.meta.url)))
const preparada: FotoPreparada = { binario, miniatura, largura: 768, altura: 1024,
  sha256: 'c8875385985d8d03099b3eb0d1e9628092d74be12ee474ee41a5881567adadde' }
const CARIMBO = '2026-10-18T22:00:00.000Z'
const bancos: BancoLocal[] = []
afterEach(() => { for (const b of bancos.splice(0)) b.close() })
function abrir(indexedDB = new IDBFactory(), nome = uuidv7()) {
  const banco = new BancoLocal(nome, { indexedDB, IDBKeyRange })
  bancos.push(banco)
  return banco
}
async function exemplo(banco = abrir()) {
  const estoque = criarRepositorioEstoque(banco, () => CARIMBO)
  const repo = criarRepositorioFotos(banco)
  const categoria = await estoque.cadastrarCategoria('Perfumes')
  if (!categoria.ok) throw new Error(categoria.motivo)
  const resultado = await estoque.salvarProduto({ id: uuidv7(), nome: 'Perfume', categoriaId: categoria.valor.id }, preparada)
  if (!resultado.ok || !resultado.valor.fotoId) throw new Error('Produto de teste sem foto')
  const foto = await banco.fotos.get(resultado.valor.fotoId)
  if (!foto) throw new Error('Foto não gravada')
  return { banco, estoque, repo, produto: resultado.valor, foto }
}
function protecao(foto: Awaited<ReturnType<typeof exemplo>>['foto'], aparelhoId: string, geracao = foto.geracaoEnvio): ProtecaoFoto {
  return { fotoId: foto.id, copiaId: foto.copiaId, sha256: foto.sha256, bytes: foto.bytes,
    largura: foto.largura, altura: foto.altura, caminho: `conta/${foto.id}/${foto.copiaId}.jpeg`, disponivel: true, aparelhoId, geracao }
}

describe('fotos locais — D-025/Q34/41, E-22', () => {
  test('sessão ausente conserva original, miniatura e fila sem sequer tentar a rede', async () => {
    const a = await exemplo()
    let chamadas = 0
    const cliente = createClient('http://127.0.0.1:9', 'chave-publica-ficticia', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: Object.assign(async () => { chamadas++; throw new Error('não deveria chamar rede sem sessão') },
        { preconnect: () => undefined }) },
    })
    const motor = iniciarSincronizacao({ banco: a.banco, nuvem: criarNuvemSupabase(cliente),
      agendar: () => () => undefined, janela: null, documento: null })
    await motor.sincronizar(); motor.parar()
    expect(motor.estado().ultimaFalha).toBe('sessao')
    expect(chamadas).toBe(0)
    expect((await a.banco.fotos.get(a.foto.id))?.binario).toEqual(binario)
    expect((await a.banco.fotos.get(a.foto.id))?.miniatura).toEqual(miniatura)
    expect(await a.banco.fila.count()).toBe(3)
  })
  test('produto, original pendente, miniatura e fila sobrevivem à reabertura sem rede', async () => {
    const indexedDB = new IDBFactory(), nome = uuidv7()
    const a = await exemplo(abrir(indexedDB, nome))
    const aparelhoId = await a.repo.aparelhoId()
    const geracao = await a.repo.geracaoLeitura()
    await a.banco.sincronizacao.put({ chave: 'estoque', valor: '123' })
    a.banco.close()
    const reaberto = abrir(indexedDB, nome), repo = criarRepositorioFotos(reaberto)
    const foto = await reaberto.fotos.get(a.foto.id)
    expect(foto?.binario).toEqual(binario)
    expect(foto?.miniatura).toEqual(miniatura)
    expect((await reaberto.produtos.get(a.produto.id))?.fotoId).toBe(a.foto.id)
    expect((await reaberto.fila.toArray()).map((item) => item.tabela).sort()).toEqual(['categorias', 'fotos', 'produtos'])
    expect(await repo.aparelhoId()).toBe(aparelhoId)
    expect(await repo.geracaoLeitura()).toBe(geracao)
    expect((await reaberto.sincronizacao.get('estoque'))?.valor).toBe('123')
  })

  test('falha depois de gravar foto, miniatura, produto e fila desfaz todo o grupo', async () => {
    const banco = abrir(), estoque = criarRepositorioEstoque(banco)
    const categoria = await estoque.cadastrarCategoria('Perfumes')
    if (!categoria.ok) throw new Error(categoria.motivo)
    banco.fila.hook('creating', (_chave, item) => { if (item.tabela === 'produtos') throw new Error('falha deliberada depois da foto') })
    await expect(estoque.salvarProduto({ id: uuidv7(), nome: 'Perfume', categoriaId: categoria.valor.id }, preparada)).rejects.toThrow('falha deliberada')
    expect(await banco.fotos.count()).toBe(0)
    expect(await banco.produtos.count()).toBe(0)
    expect((await banco.fila.toArray()).map((item) => item.tabela)).toEqual(['categorias'])
  })

  test('binário acima do teto não deixa cadastro ou fila parcial', async () => {
    const banco = abrir(), estoque = criarRepositorioEstoque(banco)
    const categoria = await estoque.cadastrarCategoria('Perfumes')
    if (!categoria.ok) throw new Error(categoria.motivo)
    await expect(estoque.salvarProduto({ id: uuidv7(), nome: 'Perfume', categoriaId: categoria.valor.id },
      { ...preparada, binario: new Uint8Array(204_801) })).rejects.toThrow('limites aprovados')
    expect(await banco.fotos.count()).toBe(0)
    expect(await banco.produtos.count()).toBe(0)
  })

  test('envio de produto com resposta perdida e leitura de edição retêm o original superado', async () => {
    const a = await exemplo()
    const cadastro = await a.banco.produtos.get(a.produto.id)
    if (!cadastro) throw new Error('sem cadastro')
    const envio = await a.repo.capturarProduto(cadastro)
    expect((await a.repo.capturarProduto(cadastro)).id).toBe(envio.id)
    const uso = await a.repo.reterReferencia(a.foto.id)
    const { fotoId: _foto, ...semFoto } = a.produto
    await a.estoque.salvarProduto(semFoto)
    expect(await a.repo.concluirFoto(a.foto.id, 'superada')).toBe(false)
    await a.repo.concluirProduto(envio.id)
    expect(await a.repo.concluirFoto(a.foto.id, 'superada')).toBe(false)
    await a.repo.liberarUso(uso)
    expect(await a.repo.concluirFoto(a.foto.id, 'superada')).toBe(true)
    expect((await a.banco.fotos.get(a.foto.id))?.binario).toBeUndefined()
    expect((await a.banco.fotos.get(a.foto.id))?.situacao).toBe('superada')
  })

  test('liberação antiga não atinge proteção nova; geração encerrada não é reutilizada', async () => {
    const a = await exemplo(), aparelho = await a.repo.aparelhoId()
    const antiga = protecao(a.foto, aparelho), nova = protecao(a.foto, aparelho, uuidv7())
    await a.repo.registrarEnvio(a.foto.id, antiga)
    await a.repo.receberProduto({ ...a.produto, atualizadoEm: CARIMBO }, nova)
    const liberar = await a.repo.planejarLiberacoes([antiga, nova])
    expect(liberar.map((item) => item.id)).toEqual([chaveDaProtecao(antiga)])
    await expect(a.repo.receberProduto({ ...a.produto, atualizadoEm: CARIMBO }, antiga)).rejects.toThrow('encerrada')
    await a.repo.concluirLiberacao(antiga)
    await a.repo.concluirLiberacao(antiga)
    expect(await a.banco.protecoesFotos.get(chaveDaProtecao(nova))).toBeDefined()
  })

  test('só a reconciliação durável sem uso marca dispensada; cadastro antigo não pode reapresentá-la', async () => {
    const a = await exemplo(), antiga = protecao(a.foto, await a.repo.aparelhoId())
    await a.repo.registrarEnvio(a.foto.id, antiga)
    expect(await a.repo.concluirFoto(a.foto.id, 'publicada')).toBe(true)
    const uso = await a.repo.reterReferencia(a.foto.id)
    const { fotoId: _foto, ...semFoto } = a.produto
    await a.estoque.salvarProduto(semFoto)
    expect(await a.repo.planejarLiberacoes([antiga])).toEqual([])
    await a.repo.liberarUso(uso)
    expect((await a.repo.planejarLiberacoes([antiga])).length).toBe(1)
    expect((await a.banco.fotos.get(a.foto.id))?.dispensada).toBe(true)
    await expect(a.estoque.salvarProduto(a.produto)).rejects.toThrow('releia')
  })

  test('v3 abre na versão atual sem reinterpretar financeiro, produto, fila ou cursor', async () => {
    const indexedDB = new IDBFactory(), nome = uuidv7()
    const anterior = new Dexie(nome, { indexedDB, IDBKeyRange })
    anterior.version(3).stores(ESQUEMA_V3)
    const produto = { id: uuidv7(), nome: 'Legado', categoriaId: uuidv7(), custoManual: 9007199254740993n, atualizadoEm: CARIMBO }
    await anterior.table('produtos').put(produto)
    await anterior.table('fila').add({ tabela: 'produtos', registroId: produto.id, criadoEm: CARIMBO })
    await anterior.table('sincronizacao').put({ chave: 'estoque', valor: '567' })
    anterior.close()
    const atual = abrir(indexedDB, nome)
    await atual.open()
    expect(atual.verno).toBe(6)
    expect(await atual.produtos.get(produto.id)).toEqual(produto)
    expect(await atual.fila.count()).toBe(1)
    expect((await atual.sincronizacao.get('estoque'))?.valor).toBe('567')
    expect(await atual.fotos.count()).toBe(0)
    expect(await atual.protecoesFotos.count()).toBe(0)
  })
})
