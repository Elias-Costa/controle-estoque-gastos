import { afterEach, describe, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '@zip.js/zip.js/lib/zip-core.js'
import { BancoLocal, ESQUEMA_V7, ESQUEMA_V8 } from '../src/dados/banco.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { criarRepositorioLocal } from '../src/dados/repositorio.ts'
import { cadastrarCliente, lancarVendaFiado } from '../src/dados/operacoes.ts'
import { criarOperacoesEstoque } from '../src/dados/operacoes-estoque.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { criarRepositorioFotos } from '../src/dados/fotos.ts'
import { criarRepositorioIdentidadeLoja } from '../src/dados/repositorio-identidade-loja.ts'
import { MODELOS_ORIGINAIS } from '../src/dados/modelos-whatsapp.ts'
import { criarRepositorioModelos } from '../src/dados/repositorio-modelos.ts'
import { criarOperacoesCaixa } from '../src/dados/operacoes-caixa.ts'
import { criarRepositorioCaixa } from '../src/dados/repositorio-caixa.ts'
import { criarRepositorioCopia, vincularContaCopia } from '../src/dados/repositorio-copia.ts'
import { dadosDaCopia, exigirCopia, objetoCopia } from '../src/dados/formato-copia.ts'
import { TABELAS_COPIA } from '../src/dados/tipos-copia.ts'
import { criarServicoCopia } from '../src/sincronizacao/copia.ts'
import { aplicarIdentidadeLoja } from '../src/sincronizacao/identidade-loja.ts'
import { documentoProduto } from '../src/sincronizacao/borda-estoque.ts'
import { lerArquivoCopia } from '../src/plataforma/arquivo-copia.ts'
import { hashDaFoto } from '../src/plataforma/fotos.ts'
import { saldo } from '../src/dominio/ficha.ts'

const T = '2026-10-29T12:00:00.000Z', GRANDE = 9007199254740993n
const VINCULO = { contaId: uuidv7(), destino: 'http://127.0.0.1:54321' }
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII='
const bancos: Dexie[] = []
function ok<T>(r: { ok: true; valor: T } | { ok: false; motivo: string }): T { if (!r.ok) throw new Error(r.motivo); return r.valor }
function abrir(fabrica = new IDBFactory(), nome = uuidv7()) {
  const b = new BancoLocal(nome, { indexedDB: fabrica, IDBKeyRange }); bancos.push(b); return b
}
afterEach(() => { for (const b of bancos.splice(0)) b.close() })

async function preparar(comMelhoria = true) {
  const b = abrir(); await vincularContaCopia(b, VINCULO)
  const repo = criarRepositorioLocal(b), estoque = criarOperacoesEstoque(criarRepositorioEstoque(b, () => T))
  const cliente = ok(await cadastrarCliente(repo, { nome: 'Ficha preservada E-28D' }))
  const venda = ok(await lancarVendaFiado(repo, { clienteId: cliente.id, data: '2026-10-29',
    itens: [{ descricao: 'Item legado', preco: GRANDE }], parcelas: [{ vencimento: '2026-11-29', valor: GRANDE }] }))
  const categoria = ok(await estoque.cadastrarCategoria('Categoria da união'))
  const binario = new Uint8Array(await Bun.file('testes/arquivos/foto-teste.jpeg').arrayBuffer())
  const miniatura = new Uint8Array(await Bun.file('testes/arquivos/foto-teste-miniatura.jpeg').arrayBuffer())
  const cadastrado = ok(await estoque.cadastrarProduto({ nome: 'Produto preservado', categoriaId: categoria.id, custoManual: GRANDE },
    { binario, miniatura, sha256: await hashDaFoto(binario), largura: 256, altura: 256 }))
  const p = await b.produtos.get(cadastrado.id); exigirCopia(p)
  // Retrato legado sem conhecimento do campo: não transformar em uma remoção explícita.
  const { classificacaoConhecida: _conhecida, ...legado } = p
  await b.produtos.put(legado)
  await criarRepositorioFotos(b).capturarProduto(legado)
  ok(await criarOperacoesCaixa(criarRepositorioCaixa(b)).registrar({ tipo: 'despesa', data: '2026-10-29',
    valor: GRANDE, categoria: 'Preservar caixa', classificacao: 'negocio', mercadoria: false }))
  if (comMelhoria) {
    ok(await estoque.alterarProduto({ ...p, classificacao: 'unissex' }))
    const atual = await b.produtos.get(p.id); exigirCopia(atual)
    await criarRepositorioFotos(b).capturarProduto(atual)
    const removido = ok(await estoque.cadastrarProduto({ nome: 'Sem classificação por escolha', categoriaId: categoria.id }))
    const cadastroRemovido = await b.produtos.get(removido.id); exigirCopia(cadastroRemovido)
    await criarRepositorioFotos(b).capturarProduto(cadastroRemovido)
    await criarRepositorioModelos(b, () => T).salvar({ ...MODELOS_ORIGINAIS, 'recibo-quitado': 'Recebi {valor}, {nome}.' }, undefined)
    await criarRepositorioIdentidadeLoja(b, () => T).salvar({ nome: 'Loja fictícia E-28D', descricao: 'Catálogo', logo: LOGO }, undefined)
  }
  return { b, cliente, venda, produtoId: p.id }
}

async function reempacotar(arquivo: Blob, mudar: (partes: Map<string, Blob>, manifesto: Record<string, unknown>) => void | Promise<void>) {
  const leitor = new ZipReader(new BlobReader(arquivo), { useWebWorkers: false }), partes = new Map<string, Blob>()
  try {
    for (const e of await leitor.getEntries()) { exigirCopia(!e.directory); partes.set(e.filename, await e.getData(new BlobWriter())) }
  } finally { await leitor.close() }
  const m = partes.get('manifesto.json'); exigirCopia(m)
  const manifesto: unknown = JSON.parse(await m.text()); exigirCopia(objetoCopia(manifesto))
  await mudar(partes, manifesto)
  manifesto['arquivos'] = await Promise.all([...partes].filter(([nome]) => nome !== 'manifesto.json').map(async ([nome, blob]) =>
    ({ nome, bytes: blob.size, sha256: await hashDaFoto(new Uint8Array(await blob.arrayBuffer())) })))
  partes.set('manifesto.json', new Blob([JSON.stringify(manifesto)]))
  const escritor = new ZipWriter(new BlobWriter(), { level: 0, useWebWorkers: false })
  for (const [nome, blob] of partes) await escritor.add(nome, new BlobReader(blob))
  return escritor.close()
}
async function pacoteAntigo(arquivo: Blob, formato: 1 | 2) {
  return reempacotar(arquivo, (partes, m) => {
    exigirCopia(objetoCopia(m['quantidades']))
    for (const tabela of ['identidadesLoja', ...(formato === 1 ? ['modelos'] : [])]) {
      for (const nome of partes.keys()) if (nome.startsWith(`dados/${tabela}/`)) partes.delete(nome)
      delete m['quantidades'][tabela]
    }
    m['formato'] = formato; m['esquema'] = formato === 1 ? 6 : 7
  })
}

describe('E-28D: união e cópia fechada, IndexedDB simulado; sem prova de aparelho', () => {
  for (const versao of [7, 8] as const) test(`upgrade v${versao} → v9 conserva todas as tabelas preenchidas e permite F3 e identidade`, async () => {
    const { b: origem } = await preparar(), fabrica = new IDBFactory(), nome = uuidv7()
    const antigo = new Dexie(nome, { indexedDB: fabrica, IDBKeyRange }); bancos.push(antigo)
    antigo.version(versao).stores(versao === 7 ? ESQUEMA_V7 : ESQUEMA_V8)
    await antigo.open()
    const antes = new Map<string, unknown[]>()
    for (const tabela of antigo.tables) {
      let linhas: unknown[] = await origem.table(tabela.name).toArray()
      if (tabela.name === 'fila') linhas = (await origem.fila.toArray()).filter((f) => versao === 7 ? f.tabela !== 'identidadeLoja' : f.tabela !== 'modelos' && f.tabela !== 'operacoesCaixa')
      if (linhas.length) await tabela.bulkAdd(linhas)
      antes.set(tabela.name, await tabela.toArray())
    }
    antigo.close(); const atual = abrir(fabrica, nome); await atual.open()
    expect(atual.verno).toBe(9)
    for (const [tabela, linhas] of antes) expect(await atual.table(tabela).toArray()).toEqual(linhas)
    expect(await atual.identidadesLoja.count()).toBe(versao === 8 ? 1 : 0)
    expect(await atual.modelos.count()).toBe(versao === 7 ? 1 : 0)
    ok(await criarOperacoesCaixa(criarRepositorioCaixa(atual)).registrar({ tipo: 'receita-avulsa', valor: 1n,
      data: '2026-10-29', categoria: 'Depois da união', classificacao: 'pessoal' }))
    expect((await criarRepositorioIdentidadeLoja(atual).salvar({ nome: 'União', descricao: '' }, await atual.identidadesLoja.get('loja'))).ok).toBe(true)
  })

  test('arquivo 3/9 e importação vazia conservam classificação, remoção, captura antiga, logo, modelos, histórico e recusas', async () => {
    const { b: a, venda } = await preparar()
    const fila = await a.fila.where('registroId').equals(venda.id).first(); exigirCopia(fila)
    await a.fila.put({ ...fila, problema: { codigo: '23514', constraint: 'lancamentos_sem_itens', mensagem: 'Recusa preservada', em: T } })
    if (venda.tipo !== 'venda') throw new Error('sem venda')
    await a.lancamentos.put({ ...venda, itens: venda.itens.map((i) => ({ ...i, descricao: '' })) })
    const copia = await criarServicoCopia(a, null).exportar(), lida = await lerArquivoCopia(copia.arquivo, VINCULO)
    expect(saldo(lida.dados.lancamentos)).toBe(GRANDE)
    expect(lida.dados.identidadesLoja[0]?.identidade.logo).toBe(LOGO)
    const docs = lida.dados.enviosProdutoFoto.map((e) => documentoProduto(e.cadastro))
    expect(docs.some((d) => !Object.hasOwn(d, 'classificacao'))).toBe(true)
    expect(docs.some((d) => d['classificacao'] === null)).toBe(true)
    expect(docs.some((d) => d['classificacao'] === 'unissex')).toBe(true)
    const b = abrir(); await vincularContaCopia(b, VINCULO)
    const servico = criarServicoCopia(b, null); await servico.importar(copia.arquivo, await servico.reservarImportacao())
    b.close(); await b.open()
    for (const tabela of ['produtos', 'enviosProdutoFoto', 'identidadesLoja', 'modelos', 'fila', 'lancamentos', 'fatosCaixa'] as const) {
      expect(await b[tabela].toArray()).toEqual(await a[tabela].toArray())
    }
    expect((await criarRepositorioCopia(b).restauracao())?.fase).toBe('reconciliar')
  })

  for (const formato of [1, 2] as const) test(`leitor ${formato}/${formato === 1 ? 6 : 7} conserva omissão e não fabrica marca/edição`, async () => {
    const { b } = await preparar(false)
    if (formato === 2) await criarRepositorioModelos(b, () => T).salvar(MODELOS_ORIGINAIS, undefined)
    const novo = await criarServicoCopia(b, null).exportar(), antigo = await pacoteAntigo(novo.arquivo, formato)
    const { dados } = await lerArquivoCopia(antigo, VINCULO)
    expect(dados.identidadesLoja).toEqual([])
    expect(dados.modelos.length).toBe(formato === 1 ? 0 : 1)
    expect(saldo(dados.lancamentos)).toBe(GRANDE)
    expect(dados.produtos.every((p) => !Object.hasOwn(p, 'classificacaoConhecida'))).toBe(true)
    const captura = dados.enviosProdutoFoto[0]; exigirCopia(captura)
    expect(Object.hasOwn(documentoProduto(captura.cadastro), 'classificacao')).toBe(false)
    const destino = abrir(); await vincularContaCopia(destino, VINCULO)
    const servico = criarServicoCopia(destino, null); await servico.importar(antigo, await servico.reservarImportacao())
    expect(await destino.identidadesLoja.count()).toBe(0)
    expect((await destino.fila.toArray()).some((f) => f.tabela === 'identidadeLoja')).toBe(false)
    const adulterado = await reempacotar(antigo, async (partes) => {
      const nome = 'dados/produtos/000000.json', blob = partes.get(nome); exigirCopia(blob)
      const linhas: unknown = JSON.parse(await blob.text()); exigirCopia(Array.isArray(linhas) && objetoCopia(linhas[0]))
      linhas[0]['classificacaoConhecida'] = true
      partes.set(nome, new Blob([JSON.stringify(linhas)]))
    })
    await expect(lerArquivoCopia(adulterado, VINCULO)).rejects.toThrow()
  })

  test('formatos são fechados: versão combinada, tabela omitida, metadado inválido, PNG externo e fila órfã são recusados', async () => {
    const { b } = await preparar(), copia = await criarServicoCopia(b, null).exportar()
    const dados = await criarRepositorioCopia(b).conferirDados()
    expect(() => dadosDaCopia({ ...dados, produtos: dados.produtos.map((p) => ({ ...p, classificacaoConhecida: false })) })).toThrow()
    expect(() => dadosDaCopia({ ...dados, enviosProdutoFoto: dados.enviosProdutoFoto.map((e) => ({ ...e, cadastro: { ...e.cadastro, classificacao: 'outro' } })) })).toThrow()
    expect(() => dadosDaCopia({ ...dados, identidadesLoja: dados.identidadesLoja.map((p) => ({ ...p, identidade: { ...p.identidade, logo: 'https://externo/logo.png' } })) })).toThrow()
    expect(() => dadosDaCopia({ ...dados, identidadesLoja: [] })).toThrow()
    for (const mudar of [
      (_partes: Map<string, Blob>, m: Record<string, unknown>) => { m['esquema'] = 7 },
      (partes: Map<string, Blob>, m: Record<string, unknown>) => {
        partes.delete('dados/identidadesLoja/000000.json'); exigirCopia(objetoCopia(m['quantidades'])); delete m['quantidades']['identidadesLoja']
      },
    ]) await expect(lerArquivoCopia(await reempacotar(copia.arquivo, mudar), VINCULO)).rejects.toThrow()
  })

  test('falha na última tabela aborta a publicação toda; retomada preserva a fila e identidade', async () => {
    const { b: a } = await preparar(), arquivo = await criarServicoCopia(a, null).exportar(), b = abrir()
    await vincularContaCopia(b, VINCULO)
    const servico = criarServicoCopia(b, null), id = await servico.reservarImportacao()
    const falhar = () => { throw new Error('interrupção na identidade') }
    b.identidadesLoja.hook('creating', falhar)
    await expect(servico.importar(arquivo.arquivo, id)).rejects.toThrow('interrupção na identidade')
    for (const tabela of TABELAS_COPIA) expect(await b.table(tabela).count()).toBe(0)
    b.identidadesLoja.hook('creating').unsubscribe(falhar)
    await servico.retomarImportacao(id)
    expect(await b.identidadesLoja.toArray()).toEqual(await a.identidadesLoja.toArray())
    expect(await b.fila.toArray()).toEqual(await a.fila.toArray())
    await expect(servico.reservarImportacao()).rejects.toThrow()
  })

  test('reconciliação da identidade usa remoto empatado no retrato copiado e protege edição local posterior', async () => {
    const { b: a } = await preparar(), copia = await criarServicoCopia(a, null).exportar(), b = abrir()
    await vincularContaCopia(b, VINCULO)
    const servico = criarServicoCopia(b, null); await servico.importar(copia.arquivo, await servico.reservarImportacao())
    const original = await b.identidadesLoja.get('loja'); exigirCopia(original)
    const remota = { ...original, id: uuidv7(), identidade: { nome: 'Empate já aceito na conta', descricao: '' } }
    await aplicarIdentidadeLoja(b, remota)
    expect(await b.identidadesLoja.get('loja')).toEqual(remota)
    expect(await b.fila.where('registroId').equals(original.id).count()).toBe(0)
    const repo = criarRepositorioIdentidadeLoja(b, () => T)
    expect((await repo.salvar({ nome: 'Editado após importar', descricao: '', logo: LOGO }, remota)).ok).toBe(true)
    await aplicarIdentidadeLoja(b, { ...remota, identidade: { nome: 'Mesmo relógio remoto', descricao: '' } })
    expect((await repo.ler())?.identidade.nome).toBe('Editado após importar')
    expect(await b.fila.where('registroId').equals(remota.id).count()).toBe(1)
  })
})
