import { describe, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '@zip.js/zip.js/lib/zip-core.js'
import { BancoLocal, ESQUEMA_V5 } from '../src/dados/banco.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { cadastrarCliente, lancarVendaFiado, receber } from '../src/dados/operacoes.ts'
import { criarRepositorioLocal } from '../src/dados/repositorio.ts'
import { criarOperacoesEstoque } from '../src/dados/operacoes-estoque.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { criarOperacoesCaixa } from '../src/dados/operacoes-caixa.ts'
import { criarRepositorioCaixa } from '../src/dados/repositorio-caixa.ts'
import { criarRepositorioCopia, vincularContaCopia } from '../src/dados/repositorio-copia.ts'
import { dadosDaCopia, exigirCopia, jsonDaCopia, objetoCopia } from '../src/dados/formato-copia.ts'
import { LIMITES_COPIA, TABELAS_COPIA, type VinculoConta } from '../src/dados/tipos-copia.ts'
import { lerArquivoCopia } from '../src/plataforma/arquivo-copia.ts'
import { criarServicoCopia } from '../src/sincronizacao/copia.ts'
import { hashDaFoto } from '../src/plataforma/fotos.ts'
import { saldo } from '../src/dominio/ficha.ts'
import { projetarEstoque } from '../src/dominio/estoque.ts'
import { projetarCaixa } from '../src/dominio/caixa.ts'
import { conteudoDoEfeito } from '../src/dominio/regras-estoque.ts'
import { consultasDaCopia } from '../src/dados/consultas-copia.ts'

const CONTA: VinculoConta = { contaId: uuidv7(), destino: 'http://127.0.0.1:54321' }
const GRANDE = 9007199254740993n, DIA = '2026-10-24'
function aparelho(fabrica = new IDBFactory(), nome = uuidv7()) { return new BancoLocal(nome, { indexedDB: fabrica, IDBKeyRange }) }
function ok<T>(r: { ok: true; valor: T } | { ok: false; motivo: string }): T { if (!r.ok) throw new Error(r.motivo); return r.valor }
async function recusa(p: PromiseLike<unknown>, motivo?: string) {
  let erro: unknown
  try { await p } catch (e) { erro = e }
  expect(erro).toBeDefined()
  if (motivo) expect(erro).toHaveProperty('motivo', motivo)
}
async function povoar(b: BancoLocal) {
  await vincularContaCopia(b, CONTA)
  const repo = criarRepositorioLocal(b), estoque = criarOperacoesEstoque(criarRepositorioEstoque(b))
  const cliente = ok(await cadastrarCliente(repo, { nome: '=Cliente fictícia', telefone: '85999990000' }))
  const venda = ok(await lancarVendaFiado(repo, { clienteId: cliente.id, data: DIA, itens: [{ descricao: 'Livre', preco: GRANDE }], parcelas: [{ vencimento: DIA, valor: GRANDE }] }))
  ok(await receber(repo, { clienteId: cliente.id, data: DIA, valor: 10n, forma: 'pix' }))
  const categoria = ok(await estoque.cadastrarCategoria('Livre'))
  const binario = new Uint8Array(await Bun.file('testes/arquivos/foto-teste.jpeg').arrayBuffer())
  const miniatura = new Uint8Array(await Bun.file('testes/arquivos/foto-teste-miniatura.jpeg').arrayBuffer())
  const produto = ok(await estoque.cadastrarProduto({ nome: 'Produto', categoriaId: categoria.id, custoManual: GRANDE },
    { binario, miniatura, sha256: await hashDaFoto(binario), largura: 256, altura: 256 }))
  ok(await estoque.registrarMovimento({ tipo: 'compra', produtoId: produto.id, data: DIA, quantidade: 7, custoUnitario: GRANDE }))
  const repoCaixa = criarRepositorioCaixa(b), caixa = criarOperacoesCaixa(repoCaixa)
  const gasto = ok(await caixa.registrar({ tipo: 'despesa', data: DIA, valor: GRANDE, categoria: 'Compra', classificacao: 'negocio', mercadoria: true }))
  const envio = await repoCaixa.capturarEnvio(gasto.operacao.id); exigirCopia(envio)
  await repoCaixa.responderEnvio(envio)
  const alvo = gasto.fatos[0]; exigirCopia(alvo)
  ok(await caixa.corrigir(alvo, { tipo: 'despesa', data: DIA, valor: GRANDE - 1n, categoria: 'Compra corrigida', classificacao: 'negocio', mercadoria: true }, DIA))
  await b.sincronizacao.put({ chave: 'caixa', valor: '50' })
  return { cliente, venda, produto }
}
async function pacote(b: BancoLocal) {
  const servico = criarServicoCopia(b, null)
  const resultado = await servico.exportar()
  return { ...resultado, dados: (await criarRepositorioCopia(b).lerEstagio(resultado.id)).dados }
}
async function alterar(arquivo: Blob, mudar: (nome: string, blob: Blob) => Promise<Blob>, atualizarHashes = false) {
  const leitor = new ZipReader(new BlobReader(arquivo), { useWebWorkers: false })
  const writer = new ZipWriter(new BlobWriter(), { level: 0, useWebWorkers: false, extendedTimestamp: false })
  const partes = new Map<string, Blob>()
  for (const e of await leitor.getEntries()) { exigirCopia(!e.directory); partes.set(e.filename, await mudar(e.filename, await e.getData(new BlobWriter()))) }
  if (atualizarHashes) {
    const m = partes.get('manifesto.json'); exigirCopia(m)
    const manifesto: unknown = JSON.parse(await m.text()); exigirCopia(objetoCopia(manifesto) && Array.isArray(manifesto['arquivos']))
    for (const a of manifesto['arquivos']) {
      exigirCopia(objetoCopia(a) && typeof a['nome'] === 'string')
      const b = partes.get(a['nome']); exigirCopia(b)
      a['bytes'] = b.size; a['sha256'] = await hashDaFoto(new Uint8Array(await b.arrayBuffer()))
    }
    partes.set('manifesto.json', new Blob([JSON.stringify(manifesto)]))
  }
  for (const [nome, blob] of partes) await writer.add(nome, new BlobReader(blob))
  await leitor.close(); return writer.close()
}

describe('E-35: arquivo e estágio, IndexedDB simulado; não prova aparelho', () => {
  test('ZIP completo abre consultas, conserva cada campo, centavos, foto e histórico', async () => {
    const b = aparelho(), ids = await povoar(b), p = await pacote(b)
    const lida = await lerArquivoCopia(p.arquivo, CONTA)
    expect(conteudoDoEfeito(lida.dados)).toBe(conteudoDoEfeito(p.dados))
    expect(saldo(lida.dados.lancamentos)).toBe(GRANDE - 10n)
    expect(projetarEstoque(lida.dados.movimentos, ids.produto.id)).toMatchObject({ ok: true, valor: { fisico: 7 } })
    expect(projetarCaixa(lida.dados.fatosCaixa, lida.dados.lancamentos, '2026-10')).toMatchObject({ ok: true, valor: { tudo: { entrou: 10n, saiu: GRANDE - 1n } } })
    expect(lida.dados.versoesCaixa.length).toBe(2)
    const reader = new ZipReader(new BlobReader(p.arquivo), { useWebWorkers: false })
    const entradas = await reader.getEntries()
    for (const nome of ['fichas', 'estoque', 'caixa']) {
      const e = entradas.find((e) => e.filename === `consultas/${nome}.csv`); exigirCopia(e && !e.directory)
      const texto = await (await e.getData(new BlobWriter())).text()
      expect(texto.length).toBeGreaterThan(30)
      if (nome === 'fichas') { expect(texto).toContain("'=Cliente fictícia"); expect(texto).toContain('90.071.992.547.409,93') }
    }
    await reader.close(); b.close()
  })
  test('consulta legível mantém promessa e cancelamento ao recortar vendas por produto', async () => {
    const b = aparelho(), ids = await povoar(b), repo = criarRepositorioEstoque(b), estoque = criarOperacoesEstoque(repo)
    const entrada = { clienteId: ids.cliente.id, data: DIA, desconto: 0n, pagamento: 'fiado',
      itens: [{ produtoId: ids.produto.id, descricao: 'Produto', quantidade: 3, entregue: 1, precoUnitario: 1000n }],
      parcelas: [{ vencimento: DIA, valor: 3000n }] } as const
    ok(await estoque.lancarVenda(entrada))
    const cancelada = ok(await estoque.lancarVenda(entrada)), envio = await repo.capturarEnvio(cancelada.operacao.id)
    exigirCopia(envio); await repo.responderEnvio(envio)
    const venda = cancelada.lancamentos[0]; exigirCopia(venda && venda.tipo === 'venda' && venda.itens[0]?.id)
    ok(await estoque.cancelarVenda(venda.id, DIA, [{ itemId: venda.itens[0].id, quantidade: 0 }]))
    const consultas = consultasDaCopia(await criarRepositorioCopia(b).conferirDados())
    expect(consultas['consultas/estoque.csv']).toContain('"5";"2"')
    b.close()
  })
  test('publicar em outra base preserva fila e identidades; novo aparelho, cursores recomeçam', async () => {
    const a = aparelho(), ids = await povoar(a), p = await pacote(a), b = aparelho()
    await vincularContaCopia(b, CONTA)
    const repo = criarRepositorioCopia(b), id = await repo.reservarImportacao()
    await repo.prepararImportacao(id, CONTA, new Date().toISOString(), p.dados)
    b.close(); await b.open(); await repo.publicar(id, CONTA)
    expect(await b.fila.toArray()).toEqual(p.dados.fila)
    expect(await b.clientes.get(ids.cliente.id)).toEqual(await a.clientes.get(ids.cliente.id))
    expect(await b.lancamentos.toArray()).toEqual(p.dados.lancamentos)
    expect(await b.movimentos.toArray()).toEqual(p.dados.movimentos)
    expect(await b.sincronizacao.count()).toBe(0)
    expect((await repo.restauracao())?.fase).toBe('reconciliar')
    expect((await b.estadoFotos.get('aparelho'))?.valor).not.toBe(p.dados.estadoFotos.find((e) => e.chave === 'aparelho')?.valor)
    expect((await b.fotos.toArray())[0]?.binario).toEqual(p.dados.fotos[0]?.binario)
    await recusa(repo.publicar(id, CONTA), 'vazia')
    a.close(); b.close()
  })
  test('conta/destino divergentes e base preenchida nunca são substituídos', async () => {
    const a = aparelho(); await povoar(a); const p = await pacote(a)
    await recusa(lerArquivoCopia(p.arquivo, { ...CONTA, contaId: uuidv7() }), 'conta')
    await recusa(lerArquivoCopia(p.arquivo, { ...CONTA, destino: 'https://outro.supabase.co' }), 'conta')
    const antes = await a.lancamentos.toArray()
    await recusa(criarRepositorioCopia(a).reservarImportacao(), 'vazia')
    await recusa(vincularContaCopia(a, { ...CONTA, contaId: uuidv7() }), 'conta')
    expect(await a.lancamentos.toArray()).toEqual(antes); a.close()
  })
  test('escrita concorrente entre preparar/publicar é preservada e recusa publicação', async () => {
    const a = aparelho(); await povoar(a); const p = await pacote(a), fabrica = new IDBFactory(), nome = uuidv7()
    const b = aparelho(fabrica, nome), outra = aparelho(fabrica, nome)
    await vincularContaCopia(b, CONTA)
    const repo = criarRepositorioCopia(b), id = await repo.reservarImportacao()
    await repo.prepararImportacao(id, CONTA, new Date().toISOString(), p.dados)
    const c = ok(await cadastrarCliente(criarRepositorioLocal(outra), { nome: 'Concorrente' }))
    await recusa(repo.publicar(id, CONTA), 'vazia')
    expect(await b.clientes.toArray()).toHaveLength(1); expect(await b.clientes.get(c.id)).toBeDefined()
    expect(await b.lancamentos.count()).toBe(0); expect(await b.fotos.count()).toBe(0)
    await repo.descartar(id)
    expect(await b.clientes.get(c.id)).toBeDefined(); expect(await b.fila.count()).toBe(1)
    a.close(); b.close(); outra.close()
  })
  test('falha na última tabela aborta publicação inteira; reabertura permite retomar', async () => {
    const a = aparelho(); await povoar(a); const p = await pacote(a), b = aparelho()
    await vincularContaCopia(b, CONTA)
    const repo = criarRepositorioCopia(b), id = await repo.reservarImportacao()
    await repo.prepararImportacao(id, CONTA, new Date().toISOString(), p.dados)
    const falhar = () => { throw new Error('interrupção deliberada') }
    b.estadoFotos.hook('creating', falhar)
    await recusa(repo.publicar(id, CONTA))
    b.estadoFotos.hook('creating').unsubscribe(falhar)
    for (const t of TABELAS_COPIA) expect(await b.table(t).count()).toBe(0)
    expect((await repo.restauracao())?.fase).toBe('escolher')
    b.close(); await b.open(); await repo.publicar(id, CONTA)
    expect(await b.lancamentos.count()).toBe(p.dados.lancamentos.length)
    a.close(); b.close()
  })
  test('foto remota ausente impede cópia completa; captura não muda quando o app continua gravando', async () => {
    const b = aparelho(); await povoar(b)
    const f = (await b.fotos.toArray())[0]; exigirCopia(f)
    await b.fotos.put({ ...f, binario: undefined, situacao: 'disponivel', caminho: `${CONTA.contaId}/${f.id}/${f.copiaId}.jpeg` })
    const servico = criarServicoCopia(b, null)
    await recusa(servico.exportar(), 'foto')
    const estagio = (await servico.listar())[0]; exigirCopia(estagio)
    expect(estagio.pronto).toBe(false)
    expect(await b.usosFotos.count()).toBeGreaterThan(0)
    await cadastrarCliente(criarRepositorioLocal(b), { nome: 'Depois do retrato' })
    expect((await criarRepositorioCopia(b).lerEstagio(estagio.id)).dados.clientes).toHaveLength(1)
    await servico.descartar(estagio.id)
    expect(await b.usosFotos.count()).toBe(0); expect(await b.clientes.count()).toBe(2)
    b.close()
  })
  test('upgrade v5 conserva dados e fila, só acrescenta controles vazios', async () => {
    const fabrica = new IDBFactory(), nome = uuidv7(), antiga = new Dexie(nome, { indexedDB: fabrica, IDBKeyRange })
    antiga.version(5).stores(ESQUEMA_V5)
    const c = { id: uuidv7(), nome: 'Existente', atualizadoEm: new Date().toISOString() }
    await antiga.table('clientes').add(c); await antiga.table('fila').add({ tabela: 'clientes', registroId: c.id, criadoEm: c.atualizadoEm })
    antiga.close()
    const b = aparelho(fabrica, nome); await b.open()
    expect(await b.clientes.get(c.id)).toEqual(c); expect(await b.fila.count()).toBe(1)
    expect(await b.controleCopia.count()).toBe(0); expect(b.verno).toBe(9); b.close()
  })
  test('Q47A encerrada e recusa de caixa conservam evidência e fila sem reabrir efeitos provisórios', async () => {
    const a = aparelho(), ids = await povoar(a), repo = criarRepositorioEstoque(a), estoque = criarOperacoesEstoque(repo)
    const grupo = ok(await estoque.lancarVenda({ clienteId: ids.cliente.id, data: DIA, desconto: 0n, pagamento: 'fiado',
      itens: [{ produtoId: ids.produto.id, descricao: 'Produto', quantidade: 1, entregue: 1, precoUnitario: 1000n }],
      parcelas: [{ vencimento: DIA, valor: 1000n }] }))
    const envio = await repo.capturarEnvio(grupo.operacao.id); exigirCopia(envio)
    await repo.responderEnvio(envio)
    const venda = grupo.lancamentos[0]; exigirCopia(venda)
    const legadoId = uuidv7(), problema = { codigo: '23514', mensagem: 'recusa fictícia', em: new Date().toISOString() }
    await a.lancamentos.add({ tipo: 'estorno', id: legadoId, clienteId: ids.cliente.id, data: DIA, estornaId: venda.id })
    await a.fila.add({ tabela: 'lancamentos', registroId: legadoId, criadoEm: problema.em, problema })
    const tentativa = ok(await repo.registrarRecusaLegada(legadoId))
    const encerramento = ok(await repo.encerrar(tentativa.id, { data: DIA, confirmado: true, intencaoPendente: false }))
    const caixa = criarRepositorioCaixa(a), pendente = (await a.operacoesCaixa.toArray()).find((op) => op.tipo === 'correcao')
    exigirCopia(pendente)
    const captura = await caixa.capturarEnvio(pendente.id); exigirCopia(captura)
    await caixa.responderEnvio(captura, problema)
    const p = await pacote(a), lida = await lerArquivoCopia(p.arquivo, CONTA), b = aparelho()
    await vincularContaCopia(b, CONTA)
    const destino = criarRepositorioCopia(b), id = await destino.reservarImportacao()
    await destino.prepararImportacao(id, CONTA, new Date().toISOString(), lida.dados); await destino.publicar(id, CONTA)
    expect(await b.encerramentos.get(encerramento.id)).toEqual(encerramento)
    expect(await b.lancamentos.get(legadoId)).toBeUndefined()
    expect(saldo(await b.lancamentos.toArray())).toBe(saldo(await a.lancamentos.toArray()))
    expect(await b.fila.toArray()).toEqual(await a.fila.toArray())
    expect((await b.versoesCaixa.get(captura.versao.id))?.problema).toEqual(problema)
    expect((await b.versoesEstoque.get(tentativa.id))?.grupo).toEqual(tentativa.grupo)
    expect(await criarRepositorioEstoque(b).encerrar(tentativa.id, { data: DIA, confirmado: true, intencaoPendente: false }))
      .toEqual({ ok: true, valor: encerramento })
    a.close(); b.close()
  })
  for (const caso of ['hash', 'numero', 'vinculo', 'foto', 'faltante', 'segredo', 'futuro'] as const) test(`pacote inválido ${caso} não chega à publicação, inclusive com hashes refeitos`, async () => {
    const b = aparelho(); await povoar(b); const p = await pacote(b)
    const adulterado = await alterar(p.arquivo, async (nome, blob) => {
      if (caso === 'hash' && nome.startsWith('consultas/')) {
        const bytes = new Uint8Array(await blob.arrayBuffer()); bytes[0] = (bytes[0] ?? 0) ^ 1
        return new Blob([bytes])
      }
      if (caso === 'foto' && nome.startsWith('fotos/')) return new Blob([new Uint8Array(blob.size)])
      if ((caso === 'numero' || caso === 'vinculo' || caso === 'segredo') && nome === 'dados/lancamentos/000000.json') {
        const v: unknown = JSON.parse(await blob.text()); exigirCopia(Array.isArray(v) && objetoCopia(v[0]))
        if (caso === 'numero') {
          const venda: unknown = v.find((linha: unknown) => objetoCopia(linha) && linha['tipo'] === 'venda')
          exigirCopia(objetoCopia(venda) && Array.isArray(venda['itens']) && objetoCopia(venda['itens'][0])); venda['itens'][0]['preco'] = 1.25
        }
        if (caso === 'vinculo') v[0]['clienteId'] = uuidv7()
        if (caso === 'segredo') v[0]['token'] = 'não pode passar'
        return new Blob([JSON.stringify(v)])
      }
      if ((caso === 'faltante' || caso === 'futuro') && nome === 'manifesto.json') {
        const v: unknown = JSON.parse(await blob.text()); exigirCopia(objetoCopia(v) && Array.isArray(v['arquivos']))
        if (caso === 'faltante') v['arquivos'].pop(); else v['formato'] = 9999
        return new Blob([JSON.stringify(v)])
      }
      return blob
    }, caso !== 'hash')
    await recusa(lerArquivoCopia(adulterado, CONTA)); b.close()
  })
  test('guarda limite antes de ler e validação não aceita dinheiro numérico nem campos extras', async () => {
    const falso = new Blob([new Uint8Array(LIMITES_COPIA.arquivo + 1)])
    await recusa(lerArquivoCopia(falso, CONTA), 'limite')
    const b = aparelho(); await povoar(b)
    const dados = await criarRepositorioCopia(b).conferirDados()
    const serializado = jsonDaCopia(dados)
    expect(serializado).toContain('"9007199254740993"')
    expect(() => dadosDaCopia({ ...dados, tokens: ['proibido'] })).toThrow()
    b.close()
  })
})
