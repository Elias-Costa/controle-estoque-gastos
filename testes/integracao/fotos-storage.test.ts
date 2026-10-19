import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { criarContaFicticia } from '../../ferramentas/conta-ficticia.ts'
import { BancoLocal } from '../../src/dados/banco.ts'
import { criarRepositorioFotos } from '../../src/dados/fotos.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { criarRepositorioEstoque } from '../../src/dados/repositorio-estoque.ts'
import { hashDaFoto } from '../../src/plataforma/fotos.ts'
import { criarSincronizacaoFotos } from '../../src/sincronizacao/fotos.ts'
import { criarNuvemSupabase, type Nuvem, type Resposta } from '../../src/sincronizacao/nuvem.ts'
import { documentoEstoque } from '../../src/sincronizacao/borda-estoque.ts'
import { documentoDaFoto, protecaoDaNuvem, type NuvemFotos } from '../../src/sincronizacao/nuvem-fotos.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
const bytes = new Uint8Array(readFileSync(new URL('../arquivos/foto-teste.jpeg', import.meta.url)))
const miniatura = new Uint8Array(readFileSync(new URL('../arquivos/foto-teste-miniatura.jpeg', import.meta.url)))
const bancos: BancoLocal[] = []
let cliente: SupabaseClient, outraConta: SupabaseClient, nuvem: Nuvem, remoto: NuvemFotos
function valor<T>(r: Resposta<T>): T { if (!r.ok) throw new Error(JSON.stringify(r.falha)); return r.valor }
beforeAll(async () => {
  if (!LIGADA) return
  async function contaFicticia(): Promise<SupabaseClient> {
    const email = await criarContaFicticia()
    const c = createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.VITE_SUPABASE_ANON_KEY ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } })
    const { error } = await c.auth.signInWithPassword({ email, password: process.env.SUPABASE_TESTE_SENHA ?? '' })
    if (error) throw error
    return c
  }
  cliente = await contaFicticia()
  outraConta = await contaFicticia()
  nuvem = criarNuvemSupabase(cliente)
  if (!nuvem.fotos) throw new Error('Sem transporte real de fotos')
  remoto = nuvem.fotos
})
afterAll(async () => {
  for (const b of bancos) b.close()
  if (LIGADA) { await cliente?.auth.signOut(); await outraConta?.auth.signOut() }
})
function aparelho() {
  const banco = new BancoLocal(uuidv7(), { indexedDB: new IDBFactory(), IDBKeyRange })
  bancos.push(banco)
  return { banco, repo: criarRepositorioFotos(banco), estoque: criarRepositorioEstoque(banco) }
}
async function exemplo() {
  const a = aparelho()
  const categoria = await a.estoque.cadastrarCategoria(`Fotos ${uuidv7()}`)
  if (!categoria.ok) throw new Error(categoria.motivo)
  valor(await nuvem.enviarCategoria(documentoEstoque(categoria.valor)))
  const r = await a.estoque.salvarProduto({ id: uuidv7(), categoriaId: categoria.valor.id, nome: 'Teste real de arquivo' },
    { binario: bytes, miniatura, sha256: await hashDaFoto(bytes), largura: 768, altura: 1024 })
  if (!r.ok || !r.valor.fotoId) throw new Error('Sem foto fictícia')
  const foto = await a.banco.fotos.get(r.valor.fotoId)
  if (!foto) throw new Error('Sem binário local')
  return { ...a, produto: { ...r.valor, atualizadoEm: (await a.banco.produtos.get(r.valor.id))!.atualizadoEm }, foto, categoria: categoria.valor }
}
// Bun não decodifica imagens. Só esta dependência usa a miniatura previamente medida;
// Canvas/EXIF, restauração e visibilidade offline são provados no Chromium com o código real.
const miniaturizar = async () => miniatura

describe.skipIf(!LIGADA)('E-22 com arquivo real — Auth/PostgREST/Storage privados', () => {
  test('resposta perdida na publicação/reinício, proteção offline e limpeza após resposta perdida', async () => {
    const a = await exemplo()
    let perderPublicacao = true
    const transporte: NuvemFotos = { ...remoto, rpc: async (nome, args) => {
      const r = await remoto.rpc(nome, args)
      if (r.ok && nome === 'confirmar_arquivo_foto' && perderPublicacao) {
        perderPublicacao = false
        return { ok: false, falha: { tipo: 'rede', mensagem: 'resposta perdida após publicação real' } }
      }
      return r
    } }
    let motor = criarSincronizacaoFotos(a.banco, nuvem, transporte, miniaturizar)
    valor(await motor.enviarProduto(a.produto))
    expect((await motor.ciclo()).ok).toBe(false)
    expect((await a.banco.fotos.get(a.foto.id))?.binario).toEqual(bytes)
    motor = criarSincronizacaoFotos(a.banco, nuvem, remoto, miniaturizar)
    valor(await motor.ciclo())
    expect((await a.banco.fotos.get(a.foto.id))?.binario).toBeUndefined()
    const caminho = (await a.banco.fotos.get(a.foto.id))?.caminho
    if (!caminho) throw new Error('Sem caminho publicado')
    expect(await hashDaFoto(valor(await remoto.baixar(caminho)))).toBe(a.foto.sha256)
    const anonimo = createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.VITE_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false } })
    expect((await anonimo.storage.from('fotos-produtos').download(caminho)).error).not.toBeNull()
    expect((await outraConta.storage.from('fotos-produtos').download(caminho)).error).not.toBeNull()
    expect((await outraConta.storage.from('fotos-produtos').upload(caminho, bytes, { contentType: 'image/jpeg' })).error).not.toBeNull()
    expect((await cliente.storage.from('fotos-produtos').remove([caminho])).data).toEqual([])
    expect((await remoto.baixar(caminho)).ok).toBe(true)
    // Outro aparelho recebe proteção antes da referência e conserva-a sem prazo.
    const b = aparelho(), leitura = criarSincronizacaoFotos(b.banco, nuvem, remoto, miniaturizar)
    await b.banco.categorias.put(a.categoria)
    const linhas = valor(await leitura.buscarProdutos(null))
    const linha = linhas.find((p) => p['id'] === a.produto.id)
    if (!linha) throw new Error('Sem referência remota')
    await leitura.receberProduto(linha)
    for (let i = 0; i < 3; i++) {
      const repetida = valor(await leitura.buscarProdutos(null)).find((p) => p['id'] === a.produto.id)
      expect(protecaoDaNuvem(repetida?.['foto_referencia']).geracao).toBe(protecaoDaNuvem(linha['foto_referencia']).geracao)
    }
    const protecoes = valor(await remoto.rpc('listar_protecoes_fotos', { aparelho_id: await b.repo.aparelhoId() }))
    expect(Array.isArray(protecoes) ? protecoes.length : -1).toBe(1)
    valor(await leitura.ciclo())
    expect(await b.repo.lerMiniatura(a.foto.id)).toEqual(miniatura)
    // A substituição inteira pelo primeiro aparelho não libera a referência do segundo.
    const { fotoId: _fotoId, ...semFoto } = a.produto
    const nova = await a.estoque.salvarProduto({ ...semFoto, nome: 'Substituído sem foto' })
    if (!nova.ok) throw new Error(nova.motivo)
    valor(await motor.enviarProduto((await a.banco.produtos.get(a.produto.id))!))
    valor(await motor.ciclo())
    expect((await remoto.baixar(caminho)).ok).toBe(true)
    const atual = valor(await leitura.buscarProdutos(null)).find((p) => p['id'] === a.produto.id)
    if (!atual) throw new Error('Sem vencedor remoto')
    await leitura.receberProduto(atual)
    let perderExclusao = true
    const limpeza = criarSincronizacaoFotos(b.banco, nuvem, { ...remoto, apagar: async (alvo) => {
      const r = await remoto.apagar(alvo)
      if (r.ok && alvo === caminho && perderExclusao) {
        perderExclusao = false
        return { ok: false, falha: { tipo: 'rede', mensagem: 'resposta perdida após apagar bytes reais' } }
      }
      return r
    } }, miniaturizar)
    expect((await limpeza.ciclo()).ok).toBe(false)
    expect(perderExclusao).toBe(false)
    // Em hospedagem o CDN pode ainda devolver bytes antigos após a exclusão. Esta prova
    // consulta a origem com nonce novo; publicação/limpeza usam também o registro no Postgres.
    expect((await cliente.storage.from('fotos-produtos').download(caminho, { cacheNonce: uuidv7() }, { cache: 'no-store' })).error).not.toBeNull()
    valor(await criarSincronizacaoFotos(b.banco, nuvem, remoto, miniaturizar).ciclo())
    const tarefas = valor(await remoto.rpc('autorizar_coleta_fotos', {}))
    expect(tarefas).not.toContainEqual({ copiaId: a.foto.copiaId, caminho })
    expect((await remoto.enviar(caminho, bytes)).ok).toBe(false)
    expect((await remoto.rpc('registrar_foto_fila', { documento: documentoDaFoto(a.foto), aparelho_id: await a.repo.aparelhoId(), geracao: uuidv7() })).ok).toBe(false)
  })

  test('arquivo existente do mesmo tamanho com bytes divergentes não confirma nem libera original', async () => {
    const a = await exemplo()
    const r = valor(await remoto.rpc('registrar_foto_fila', { documento: documentoDaFoto(a.foto),
      aparelho_id: await a.repo.aparelhoId(), geracao: a.foto.geracaoEnvio }))
    const ref = protecaoDaNuvem(r)
    await a.repo.registrarEnvio(a.foto.id, ref)
    const divergente = bytes.slice(); divergente[100] = (divergente[100] ?? 0) ^ 1
    valor(await remoto.enviar(ref.caminho, divergente))
    const motor = criarSincronizacaoFotos(a.banco, nuvem, remoto, miniaturizar)
    valor(await motor.enviarProduto(a.produto))
    await expect(motor.ciclo()).rejects.toThrow('não corresponde')
    expect((await a.banco.fotos.get(a.foto.id))?.binario).toEqual(bytes)
    expect((await a.banco.fila.toArray()).some((i) => i.registroId === a.foto.id)).toBe(true)
    const leitura = valor(await motor.buscarProdutos(null)).find((p) => p['id'] === a.produto.id)
    expect(protecaoDaNuvem(leitura?.['foto_referencia']).disponivel).toBe(false)
  })
})
