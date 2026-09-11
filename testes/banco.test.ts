import { describe, expect, test } from 'bun:test'
import Dexie, { type DexieOptions } from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal, ESQUEMA_V1, NOME_DO_BANCO } from '../src/dados/banco.ts'
import type { Cliente, VendaFiado } from '../src/dominio/ficha.ts'

/**
 * O esquema local e o protocolo de migração (E-05, D-020, D-040).
 *
 * O IndexedDB aqui é o de mentira (`fake-indexeddb`), injetado no construtor — uma fábrica
 * nova por teste, sem estado compartilhado. Ele prova a **lógica nossa** e nada sobre o
 * WebKit (D-033, emenda de E-05). Duas guardas deste arquivo existem porque o fake é
 * permissivo: ele aceita `bigint` como chave de índice, e o IndexedDB real recusa (E-00).
 * Por isso a guarda de D-022 é uma lista de permissão sobre o esquema declarado, não um
 * teste de comportamento.
 */

/**
 * Cópia literal de cada versão **publicada** do esquema. Se `banco.ts` divergir daqui, alguém
 * editou uma versão que já existe em aparelho — e o caminho certo é acrescentar a próxima.
 * Quando houver v2, ela entra aqui como `2: {...}` e a v1 fica como está.
 */
const ESQUEMAS_PUBLICADOS: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  1: { clientes: 'id', lancamentos: 'id, clienteId', fila: '++ordem, registroId' },
}

/**
 * Todo caminho de chave que pode virar índice. Dinheiro (`valor`, `preco`, `desconto`) nunca
 * entra aqui (D-022); um índice novo é acrescentado de propósito, com a versão nova.
 */
const INDICES_PERMITIDOS = new Set(['id', 'clienteId', 'ordem', 'registroId'])

/** Uma fábrica de IndexedDB de mentira por teste: nenhum estado atravessa de um para outro. */
function abrir(nome = 'teste', indexedDB: DexieOptions['indexedDB'] = new IDBFactory()): BancoLocal {
  return new BancoLocal(nome, { indexedDB, IDBKeyRange })
}

/** O `stores()` de uma tabela, reconstruído do que o Dexie registrou. */
function especificacao(banco: BancoLocal, tabela: string): string {
  const esquema = banco.table(tabela).schema
  return [esquema.primKey.src, ...esquema.indexes.map((indice) => indice.src)].join(', ')
}

describe('esquema local (D-020, D-040)', () => {
  test('o nome da base é o definitivo e não muda: mudar é perder o dado no aparelho dela', () => {
    expect(NOME_DO_BANCO).toBe('controle-fiado')
    expect(new BancoLocal(undefined, { indexedDB: new IDBFactory(), IDBKeyRange }).name).toBe('controle-fiado')
  })

  test('a versão declarada é a última publicada, e cada tabela bate com o literal publicado', async () => {
    const banco = abrir()
    await banco.open()
    const ultima = Math.max(...Object.keys(ESQUEMAS_PUBLICADOS).map((versao) => parseInt(versao, 10)))
    expect(banco.verno).toBe(ultima)
    const publicado = ESQUEMAS_PUBLICADOS[ultima]
    if (publicado === undefined) throw new Error('sem esquema publicado')
    expect(banco.tables.map((tabela) => tabela.name).sort()).toEqual(Object.keys(publicado).sort())
    for (const [tabela, spec] of Object.entries(publicado)) {
      expect(especificacao(banco, tabela)).toBe(spec)
    }
    banco.close()
  })

  test('o literal exportado por banco.ts é a v1 publicada, sem edição', () => {
    const v1 = ESQUEMAS_PUBLICADOS[1]
    if (v1 === undefined) throw new Error('sem v1')
    expect(v1).toEqual({ ...ESQUEMA_V1 })
  })

  test('todo índice está na lista de permissão — nenhum campo de dinheiro é chave (D-022)', async () => {
    const banco = abrir()
    await banco.open()
    for (const tabela of banco.tables) {
      for (const indice of [tabela.schema.primKey, ...tabela.schema.indexes]) {
        const caminhos = Array.isArray(indice.keyPath) ? indice.keyPath : [indice.keyPath]
        for (const caminho of caminhos) {
          expect(INDICES_PERMITIDOS.has(String(caminho))).toBe(true)
        }
      }
    }
    banco.close()
  })

  test('uma base gravada pela v1 publicada abre na versão atual com as linhas intactas', async () => {
    const indexedDB = new IDBFactory()
    const nome = 'migracao'

    // A base "antiga": Dexie cru, só com o literal publicado — não com o código atual.
    const antiga = new Dexie(nome, { indexedDB, IDBKeyRange })
    const v1 = ESQUEMAS_PUBLICADOS[1]
    if (v1 === undefined) throw new Error('sem v1')
    antiga.version(1).stores({ ...v1 })
    const vera: Cliente = { id: 'c1', nome: 'Vera' }
    const venda: VendaFiado = {
      tipo: 'venda',
      pagamento: 'fiado',
      id: 'v1',
      clienteId: 'c1',
      data: '2026-09-01',
      itens: [{ descricao: 'perfume', preco: 9007199254740993n }],
      desconto: 0n,
      parcelas: [{ id: 'p1', vencimento: '2026-10-01', valor: 9007199254740993n }],
    }
    await antiga.table('clientes').put(vera)
    await antiga.table('lancamentos').put(venda)
    await antiga.table('fila').add({ tabela: 'lancamentos', registroId: 'v1', criadoEm: '2026-09-01T10:00:00.000Z' })
    antiga.close()

    // A base atual, aberta sobre a mesma fábrica: é o que acontece no aparelho dela após atualizar.
    const atual = abrir(nome, indexedDB)
    await atual.open()
    expect(await atual.clientes.get('c1')).toEqual(vera)
    const lida = await atual.lancamentos.get('v1')
    expect(lida).toEqual(venda)
    if (lida?.tipo !== 'venda' || lida.pagamento !== 'fiado') throw new Error('tipo trocado na migração')
    expect(typeof lida.parcelas[0]?.valor).toBe('bigint')
    expect(await atual.fila.toArray()).toEqual([{ ordem: 1, tabela: 'lancamentos', registroId: 'v1', criadoEm: '2026-09-01T10:00:00.000Z' }])
    atual.close()
  })
})
