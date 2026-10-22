import { expect, test } from 'bun:test'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { criarOperacoesEstoque } from '../src/dados/operacoes-estoque.ts'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { ok } from './apoio-estoque.ts'

test('consulta local entrega miniatura sem original; operação de cadastro passa a foto ao mesmo rw', async () => {
  // Dublê da lógica da porta de dados. Persistência/encoder são provas separadas no Chromium.
  const banco = new BancoLocal('catalogo-e23', { indexedDB: new IDBFactory(), IDBKeyRange })
  try {
    const repo = criarRepositorioEstoque(banco), operacoes = criarOperacoesEstoque(repo)
    const categoria = ok(await operacoes.cadastrarCategoria('Perfumes'))
    const produto = ok(await operacoes.cadastrarProduto({ nome: 'Perfume', categoriaId: categoria.id }, {
      binario: new Uint8Array([1, 2, 3]), miniatura: new Uint8Array([4, 5]), sha256: 'a'.repeat(64), largura: 1, altura: 1,
    }))
    if (!produto.fotoId) throw new Error('cadastro não associou a foto')
    const catalogo = await repo.lerCatalogo()
    expect(catalogo.produtos).toHaveLength(1)
    expect(catalogo.produtos[0]).toMatchObject(produto)
    expect(catalogo.categorias).toEqual([categoria])
    expect(catalogo.miniaturas).toEqual([{ fotoId: produto.fotoId, binario: new Uint8Array([4, 5]) }])
    expect(await banco.fotos.count()).toBe(1)
    expect((await banco.fila.toArray()).map((item) => item.tabela)).toEqual(['categorias', 'fotos', 'produtos'])
  } finally { banco.close() }
})
