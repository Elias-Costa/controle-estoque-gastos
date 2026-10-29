import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { ESQUEMA_V7, ESQUEMA_V8 } from '../../src/dados/banco.ts'
import { abrirApp, recarregar } from './apoio.ts'

for (const versao of [7, 8] as const) test(`E-28D IndexedDB real v${versao} → v9 conserva anotações/foto/fila e reabre offline`, async ({ page, context }, info) => {
  const esquema = versao === 7 ? ESQUEMA_V7 : ESQUEMA_V8
  // Mesma origem sem executar o app: a base antiga nasce antes da primeira abertura da v9.
  await page.goto('/licencas/zip-js.txt')
  const bytes = [...await readFile('testes/arquivos/foto-teste.jpeg')]
  const anterior = await page.evaluate(async ({ esquema, versao, bytes }) => {
    const id = () => crypto.randomUUID(), clienteId = id(), produtoId = id(), categoriaId = id(), fotoId = id()
    const T = '2026-10-29T12:00:00.000Z'
    const produto = { id: produtoId, nome: 'Produto anterior à união', categoriaId, fotoId, atualizadoEm: T, custoManual: 9007199254740993n,
      ...(versao === 8 ? { classificacao: 'unissex', classificacaoConhecida: true } : {}) }
    const venda = { id: id(), clienteId, tipo: 'venda', pagamento: 'fiado', data: '2026-10-29', itens: [{ descricao: 'Item anterior à união', preco: 9007199254740993n }],
      desconto: 0n, parcelas: [{ id: id(), vencimento: '2026-11-29', valor: 9007199254740993n }] }
    const identidade = { chave: 'loja', id: id(), atualizadoEm: T, identidade: { nome: 'Loja anterior à união', descricao: 'Preservar' } }
    const linhas: Record<string, unknown[]> = { clientes: [{ id: clienteId, nome: `Ficha da base v${versao}`, atualizadoEm: T }],
      categorias: [{ id: categoriaId, nome: 'Categoria anterior à união' }], produtos: [produto], lancamentos: [venda],
      fila: [{ ordem: 1, tabela: 'lancamentos', registroId: venda.id, criadoEm: T, versao: 3,
        problema: { codigo: '23514', mensagem: 'Recusa preservada', em: T } }],
      sincronizacao: [{ chave: 'estoque', valor: '123' }],
      fotos: [{ id: fotoId, copiaId: id(), produtoId, cadastroEm: T, geracaoEnvio: id(), sha256: '0'.repeat(64),
        bytes: bytes.length, largura: 256, altura: 256, situacao: 'pendente', binario: new Uint8Array(bytes) }],
      enviosProdutoFoto: [{ id: id(), produtoId, cadastro: produto }],
      ...(versao === 8 ? { identidadesLoja: [identidade] } : {
        fatosCaixa: [{ id: id(), revisao: 1, tipo: 'despesa', data: '2026-10-29', valor: 9007199254740993n, categoria: 'Anterior', classificacao: 'pessoal', mercadoria: false }],
        lotesCopia: [{ id: 'estagio/clientes/000000000', operacaoId: 'estagio', tabela: 'clientes', linhas: [{ id: clienteId, nome: 'Retrato preservado' }] }],
      }) }
    const banco = await new Promise<IDBDatabase>((resolve, reject) => {
      // Dexie 4.4.5 usa versão nativa ×10; conferido no código instalado e medido nesta prova.
      const abertura = indexedDB.open('controle-fiado', versao * 10)
      abertura.onerror = () => reject(abertura.error)
      abertura.onupgradeneeded = () => {
        for (const [nome, spec] of Object.entries(esquema)) {
          const [primaria, ...indices] = spec.split(', '); if (!primaria) throw new Error('sem chave')
          const caminho = (s: string) => s.startsWith('[') ? s.slice(1, -1).split('+') : s
          const tabela = abertura.result.createObjectStore(nome, { keyPath: caminho(primaria.replace('++', '')), autoIncrement: primaria.startsWith('++') })
          for (const indice of indices) tabela.createIndex(indice, caminho(indice))
        }
      }
      abertura.onsuccess = () => resolve(abertura.result)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = banco.transaction(Object.keys(esquema), 'readwrite')
        for (const [tabela, registros] of Object.entries(linhas)) for (const registro of registros) tx.objectStore(tabela).add(registro)
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
      })
    } finally { banco.close() }
    return { linhas: JSON.stringify(linhas, (_k, v: unknown) => typeof v === 'bigint' ? String(v) : v), clienteId, produtoId }
  }, { esquema, versao, bytes })
  await abrirApp(page); await context.setOffline(true)
  async function conferir() {
    return page.evaluate(async ({ linhas, clienteId, produtoId }) => {
      const l = window.laboratorio; if (!l) throw new Error('sem laboratório')
      const esperadas: Record<string, unknown[]> = JSON.parse(linhas)
      const atuais = Object.fromEntries(await Promise.all(Object.keys(esperadas).map(async (t) => [t, await l.banco.table(t).toArray()])))
      return { linhas: JSON.stringify(atuais, (_k, v: unknown) => typeof v === 'bigint' ? String(v) : v), versao: l.banco.verno,
        saldo: String(l.saldo(await l.repositorio.lerFicha(clienteId))), foto: !!(await l.banco.fotos.toArray())[0]?.binario,
        produto: (await l.banco.produtos.get(produtoId))?.nome, tabelas: l.banco.tables.map((t) => t.name) }
    }, anterior)
  }
  for (const reabrir of [false, true]) {
    if (reabrir) await recarregar(page)
    const atual = await conferir()
    expect(JSON.parse(atual.linhas)).toEqual(JSON.parse(anterior.linhas))
    expect(atual.versao).toBe(9); expect(atual.saldo).toBe('9007199254740993'); expect(atual.foto).toBe(true)
    expect(atual.produto).toBe('Produto anterior à união')
    for (const tabela of ['fatosCaixa', 'modelos', 'controleCopia', 'identidadesLoja']) expect(atual.tabelas).toContain(tabela)
  }
  await page.screenshot({ path: info.outputPath(`upgrade-v${versao}-v9-offline.png`), fullPage: true })
})
