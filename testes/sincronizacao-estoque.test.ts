import { describe, expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { criarOperacoesEstoque } from '../src/dados/operacoes-estoque.ts'
import type { GrupoEstoque } from '../src/dominio/vendas-estoque.ts'
import { prepararMovimentosEstoque } from '../src/dominio/vendas-estoque.ts'
import { novaContagem, projetarEstoque, type MovimentoEstoque } from '../src/dominio/estoque.ts'
import { identidadeDaTentativa } from '../src/dominio/recuperacao-estoque.ts'
import { conteudoDoEfeito } from '../src/dominio/regras-estoque.ts'
import { lancamentoDaNuvem, lancamentoParaNuvem } from '../src/sincronizacao/borda.ts'
import { COLUNAS_PRODUTO, documentoEstoque, encerramentoDaNuvem, grupoDaNuvem, movimentoDaNuvem, produtoDaNuvem, produtoParaLinha, recepcaoDaNuvem } from '../src/sincronizacao/borda-estoque.ts'
import { aplicarRecepcaoEstoque } from '../src/sincronizacao/recepcao-estoque.ts'
import { iniciarSincronizacao } from '../src/sincronizacao/sincronizacao.ts'
import type { Nuvem, Resposta } from '../src/sincronizacao/nuvem.ts'
import { ok } from './apoio-estoque.ts'

const AGORA = '2026-10-18T12:00:00.000Z', DIA = '2026-10-18', GRANDE = 9007199254740993n
function grupo(id = 'op', produtoId = 'produto'): GrupoEstoque {
  return { operacao: { id, formato: 1, revisao: 1, tipo: 'movimento', dependencias: [], lancamentos: [], movimentos: [{ id: `${id}-compra`, revisao: 1 }] },
    lancamentos: [], movimentos: [{ id: `${id}-compra`, revisao: 1, operacaoId: id, produtoId, data: DIA, conhecidos: [],
      tipo: 'compra', quantidade: 10, custoUnitario: GRANDE, ordemCadastro: GRANDE }] }
}
function banco() { return new BancoLocal('estoque', { indexedDB: new IDBFactory(), IDBKeyRange }) }
function nuvem(mudancas: Partial<Nuvem> = {}): Nuvem {
  const enviado = async (): Promise<Resposta<void>> => ({ ok: true, valor: undefined })
  const vazio = async (): Promise<Resposta<readonly Record<string, unknown>[]>> => ({ ok: true, valor: [] })
  return { temSessao: async () => true, aoMudarSessao: () => () => undefined, enviarCliente: enviado, enviarLancamento: enviado,
    enviarCategoria: enviado, enviarProduto: enviado, enviarGrupo: enviado, enviarEncerramento: async () => ({ ok: true, valor: 'fechada' }),
    buscarClientes: vazio, buscarLancamentos: vazio, buscarCategorias: vazio, buscarProdutos: vazio, buscarEstoque: vazio, ...mudancas }
}
function motor(b: BancoLocal, n: Nuvem) { return iniciarSincronizacao({ banco: b, nuvem: n, agendar: () => () => undefined, janela: null, documento: null }) }
async function produtoLocal(b: BancoLocal) {
  await b.categorias.put({ id: 'categoria', nome: 'Perfumes' })
  await b.produtos.put({ id: 'produto', nome: 'Perfume', categoriaId: 'categoria', atualizadoEm: AGORA })
}

describe('borda F2: campos completos e inteiros exatos', () => {
  test('produto completo/ausente/zero e lista de colunas; grupo e encerramento voltam campo a campo', () => {
    const produto = { id: 'p', nome: 'Perfume', categoriaId: 'c', marca: '', codigoCatalogo: 'A', fotoId: 'foto',
      custoManual: GRANDE, precoVenda: 0n, estoqueMinimo: 0, atualizadoEm: AGORA }
    const linha = { ...produtoParaLinha(produto), atualizado_em: AGORA }
    expect(produtoDaNuvem(linha)).toEqual(produto)
    for (const chave of Object.keys(linha)) expect(COLUNAS_PRODUTO.replaceAll('::text', '').split(', ').includes(chave)).toBe(true)
    expect(produtoDaNuvem({ id: 'p', nome: 'P', categoria_id: 'c', atualizado_em: AGORA })).toEqual({ id: 'p', nome: 'P', categoriaId: 'c', atualizadoEm: AGORA })
    const g = grupo()
    expect(grupoDaNuvem(documentoEstoque(g))).toEqual(g)
    const encerramento = { id: 'fechada', data: DIA, tentativa: identidadeDaTentativa(g),
      evidencia: { grupo: g, desfecho: 'recusada', diagnostico: '23514' }, aceitosConhecidos: [], novaOperacao: grupo('nova') } as const
    expect(encerramentoDaNuvem(documentoEstoque(encerramento))).toEqual(encerramento)
  })
  test('itens F1 continuam avulsos; F2 conserva quantidade, preço agregado, unitário e identidade', () => {
    const venda = { id: 'v', clienteId: 'c', data: DIA, tipo: 'venda', pagamento: 'avista', forma: 'pix', desconto: 0n,
      itens: [{ id: 'i', produtoId: 'p', quantidade: 3, precoUnitario: GRANDE, preco: GRANDE * 3n, descricao: 'P' }] } as const
    expect(lancamentoDaNuvem(lancamentoParaNuvem(venda))).toEqual(venda)
    const f1 = { ...venda, itens: [{ descricao: 'avulso', preco: GRANDE }] }
    expect(lancamentoDaNuvem(lancamentoParaNuvem(f1))).toEqual(f1)
  })
  test('recusa dinheiro numérico/fracionário, quantidade inválida, manifesto incompleto e recepção malformada', () => {
    const g = documentoEstoque(grupo()), m = documentoEstoque(grupo().movimentos[0]!)
    for (const custoUnitario of [0, 3990, '1.5', '-1']) expect(() => grupoDaNuvem({ ...g, movimentos: [{ ...m, custoUnitario }] })).toThrow()
    expect(() => grupoDaNuvem({ ...g, movimentos: [] })).toThrow(/incompleto/)
    expect(() => grupoDaNuvem({ ...g, movimentos: [{ ...m, quantidade: 1.5 }] })).toThrow()
    expect(() => recepcaoDaNuvem({ tipo: 'operacao', recepcao: 1, grupo: g, evidencias: [] })).toThrow()
  })
  test('todos os tipos de movimento conservam causalidade, base, resolução, vínculos e custo ausente/zero', () => {
    const compra = grupo().movimentos[0]!
    const base = { id: 'm', revisao: 1, operacaoId: 'o', produtoId: 'produto', data: DIA, conhecidos: [{ id: compra.id, revisao: 1 }] }
    const movimentos: MovimentoEstoque[] = [compra,
      { ...base, tipo: 'entrega', quantidade: 2, itemId: 'item', custoUnitario: 0n },
      { ...base, tipo: 'entrega', quantidade: 2, itemId: 'item' },
      { ...base, tipo: 'retorno', quantidade: 1, itemId: 'item' },
      { ...base, tipo: 'saida', quantidade: 1, motivo: 'uso-pessoal' },
      { ...base, tipo: 'anulacao', alvo: { id: compra.id, revisao: 1 } },
      { ...compra, tipo: 'compra', quantidade: 3, ordemCadastro: GRANDE, compraOriginalId: 'original', custoUnitario: 0n },
      ok(novaContagem([compra], { id: 'contagem', operacaoId: 'contar', revisao: 1, produtoId: 'produto',
        data: DIA, totalContado: 7, motivo: 'conferencia' }))]
    for (const m of movimentos) expect(movimentoDaNuvem(documentoEstoque(m))).toEqual(m)
  })
})

describe('recepção e envio F2: falha não confirma metade', () => {
  test('grupo sem produto/dependência não avança cursor; retoma completo e reaplica sem fila ou efeito duplicado', async () => {
    const b = banco(), g = grupo()
    const r = { tipo: 'operacao', recepcao: '1', grupo: g, evidencias: [] } as const
    await expect(aplicarRecepcaoEstoque(b, r)).rejects.toThrow(/dependência/)
    expect(await b.sincronizacao.get('estoque')).toBeUndefined()
    expect(await b.operacoes.count()).toBe(0)
    await produtoLocal(b)
    const faltante = { ...g, operacao: { ...g.operacao, dependencias: [{ id: 'ausente', revisao: 1 }] } }
    await expect(aplicarRecepcaoEstoque(b, { ...r, grupo: faltante })).rejects.toThrow()
    await aplicarRecepcaoEstoque(b, r); await aplicarRecepcaoEstoque(b, r)
    expect(await b.movimentos.count()).toBe(1)
    expect(await b.fila.count()).toBe(0)
    expect((await b.sincronizacao.get('estoque'))?.valor).toBe('1')
    expect((await b.relogioEstoque.get('cadastro'))?.ultimo).toBe(GRANDE)
    b.close()
  })
  test('falha na gravação do cursor desfaz grupo, movimentos, aceite e máximo lógico', async () => {
    const b = banco(); await produtoLocal(b)
    const falhar = () => { throw new Error('falha no cursor') }
    b.sincronizacao.hook('creating', falhar)
    await expect(aplicarRecepcaoEstoque(b, { tipo: 'operacao', recepcao: '1', grupo: grupo(), evidencias: [] })).rejects.toThrow()
    b.sincronizacao.hook('creating').unsubscribe(falhar)
    expect(await b.movimentos.count()).toBe(0)
    expect(await b.operacoes.count()).toBe(0)
    expect(await b.versoesEstoque.count()).toBe(0)
    expect(await b.relogioEstoque.count()).toBe(0)
    b.close()
  })
  test('paginação por recepção retoma após interrupção, sem cursor ultrapassar a posição inválida', async () => {
    const b = banco(); await produtoLocal(b)
    let pagina = 0, interromper = true
    const n = nuvem({ buscarEstoque: async (apos, limite) => {
      pagina++
      if (apos === '0') return { ok: true, valor: Array.from({ length: limite }, (_, i) =>
        ({ tipo: 'operacao', recepcao: String(i + 1), grupo: documentoEstoque(grupo(`op${i}`)), evidencias: [] })) }
      expect(apos).toBe('500')
      return interromper ? { ok: false, falha: { tipo: 'rede', mensagem: 'interrompida' } }
        : { ok: true, valor: [{ tipo: 'operacao', recepcao: '501', grupo: documentoEstoque(grupo('ultima')), evidencias: [] }] }
    } })
    const sinc = motor(b, n); await sinc.sincronizar()
    expect(sinc.estado().ultimaFalha).toBe('rede')
    expect((await b.sincronizacao.get('estoque'))?.valor).toBe('500')
    interromper = false; await sinc.sincronizar()
    expect((await b.sincronizacao.get('estoque'))?.valor).toBe('501')
    expect(await b.movimentos.count()).toBe(501)
    expect(pagina).toBe(3)
    sinc.parar(); b.close()
  }, 30_000)
  test('sucesso ou recusa antiga não conclui/marca revisão editada durante o envio', async () => {
    for (const recusar of [false, true]) {
      const b = banco(); await produtoLocal(b)
      const repo = criarRepositorioEstoque(b), op = criarOperacoesEstoque(repo)
      const original = ok(await op.registrarMovimento({ tipo: 'compra', produtoId: 'produto', data: DIA, quantidade: 10 }))
      const sinc = motor(b, nuvem({ enviarGrupo: async () => {
        ok(await op.corrigirRegistroMovimento(original.movimentos[0]!, { tipo: 'compra', produtoId: 'produto', data: DIA, quantidade: 8 }))
        return recusar ? { ok: false, falha: { tipo: 'recusa', codigo: '23514', mensagem: 'antiga recusada' } } : { ok: true, valor: undefined }
      } }))
      await sinc.sincronizar()
      const fila = (await b.fila.toArray())[0]
      expect(fila?.versao).toBe(2); expect(fila?.problema).toBeUndefined()
      expect((await repo.lerEstado()).grupos[0]?.operacao.revisao).toBe(2)
      sinc.parar(); b.close()
    }
  })
  test('download financeiro F2 isolado fica fora da projeção até o grupo chegar', async () => {
    const b = banco()
    const sinc = motor(b, nuvem({ buscarLancamentos: async () => ({ ok: true, valor: [{ operacao_estoque_id: 'op', criado_em: AGORA }] }) }))
    await sinc.sincronizar()
    expect(await b.lancamentos.count()).toBe(0)
    expect((await b.sincronizacao.get('lancamentos'))?.valor).toBe(AGORA)
    expect(await b.sincronizacao.get('estoque')).toBeUndefined()
    sinc.parar(); b.close()
  })
  test('download aceito sob mesmo id/revisão guarda evidência sem sobrescrever tentativa divergente', async () => {
    const b = banco(); await produtoLocal(b)
    const repo = criarRepositorioEstoque(b), op = criarOperacoesEstoque(repo)
    const local = ok(await op.registrarMovimento({ tipo: 'compra', produtoId: 'produto', data: DIA, quantidade: 10 }))
    const remoto = { ...local, movimentos: local.movimentos.map((m) => ({ ...m, quantidade: 8 })) }
    await aplicarRecepcaoEstoque(b, { tipo: 'operacao', recepcao: '1', grupo: remoto, evidencias: [] })
    expect(conteudoDoEfeito((await repo.lerEstado()).grupos[0])).toBe(conteudoDoEfeito(local))
    expect((await b.versoesEstoque.toArray()).some((v) => v.aceita && conteudoDoEfeito(v.grupo) === conteudoDoEfeito(remoto))).toBe(true)
    const envio = await repo.capturarEnvio(local.operacao.id); if (!envio) throw new Error('sem envio')
    await repo.responderEnvio(envio, { codigo: '23514', mensagem: 'divergente', em: AGORA })
    ok(await repo.encerrar(envio.versao.id, { data: DIA, confirmado: true, intencaoPendente: false }))
    expect(conteudoDoEfeito((await repo.lerEstado()).grupos[0])).toBe(conteudoDoEfeito(remoto))
    b.close()
  })
  test('RPC devolve outro id de resolução: só conclui a fila depois de baixar a confirmação já aceita', async () => {
    const b = banco(); await produtoLocal(b)
    const repo = criarRepositorioEstoque(b), op = criarOperacoesEstoque(repo)
    const g = ok(await op.registrarMovimento({ tipo: 'compra', produtoId: 'produto', data: DIA, quantidade: 1 }))
    const envio = await repo.capturarEnvio(g.operacao.id); if (!envio) throw new Error('sem envio')
    await repo.responderEnvio(envio, { codigo: '23514', mensagem: 'recusada', em: AGORA })
    const local = ok(await repo.encerrar(envio.versao.id, { data: DIA, confirmado: true, intencaoPendente: false }))
    const remoto = { ...local, id: 'resolucao-anterior' }
    let entregar = false
    const sinc = motor(b, nuvem({ enviarEncerramento: async () => ({ ok: true, valor: remoto.id }),
      buscarEstoque: async () => ({ ok: true, valor: entregar ? [{ tipo: 'encerramento', recepcao: '1', encerramento: documentoEstoque(remoto) }] : [] }) }))
    await sinc.sincronizar()
    expect(await b.fila.count()).toBe(1)
    expect((await b.encerramentos.get(local.id))?.remotoId).toBe(remoto.id)
    entregar = true; await sinc.sincronizar()
    expect(await b.fila.count()).toBe(0)
    expect(await b.encerramentos.get(remoto.id)).toEqual(remoto)
    expect(await b.movimentos.count()).toBe(0)
    sinc.parar(); b.close()
  })
  test('encerrar outra tentativa conserva a revisão histórica recebida sem seu antigo manifesto (Q39/47)', async () => {
    const b = banco(); await produtoLocal(b)
    const antigo = grupo(), m = antigo.movimentos[0]!
    const contagem = ok(novaContagem([m], { id: 'contagem', operacaoId: 'contar', revisao: 1, produtoId: 'produto',
      data: DIA, totalContado: 7, motivo: 'conferencia' }))
    const contado = ok(prepararMovimentosEstoque([m], { id: 'contar', revisao: 1, dependencias: [{ id: m.id, revisao: 1 }] }, [contagem]))
    const atual = { ...antigo, operacao: { ...antigo.operacao, revisao: 2, movimentos: [{ id: m.id, revisao: 2 }] },
      movimentos: [{ ...m, revisao: 2, quantidade: 8 }] }
    await aplicarRecepcaoEstoque(b, { tipo: 'operacao', recepcao: '1', grupo: atual, evidencias: [m] })
    await aplicarRecepcaoEstoque(b, { tipo: 'operacao', recepcao: '2', grupo: contado, evidencias: [] })
    const repo = criarRepositorioEstoque(b), op = criarOperacoesEstoque(repo)
    const pendente = ok(await op.registrarMovimento({ tipo: 'compra', produtoId: 'produto', data: DIA, quantidade: 1 }))
    const envio = await repo.capturarEnvio(pendente.operacao.id); if (!envio) throw new Error('sem envio')
    await repo.responderEnvio(envio, { codigo: '23514', mensagem: 'recusada', em: AGORA })
    ok(await repo.encerrar(envio.versao.id, { data: DIA, confirmado: true, intencaoPendente: false }))
    expect(await b.movimentos.get([m.id, 1])).toEqual(m)
    const projecao = ok(projetarEstoque(await b.movimentos.toArray(), 'produto'))
    expect(projecao.fisico).toBe(8)
    expect(projecao.contagensAfetadas).toEqual([{ id: 'contagem', revisao: 1 }])
    b.close()
  })
  test('restauração não ressuscita a primeira revisão da nova intenção quando r2 foi aceita ou encerrada', async () => {
    for (const aceita of [true, false]) {
      const b = banco(); await produtoLocal(b)
      const recusada = grupo('recusada'), nova = grupo('nova')
      const encerramento = { id: 'encerrar', data: DIA, tentativa: identidadeDaTentativa(recusada),
        evidencia: { grupo: recusada, desfecho: 'recusada', diagnostico: '23514' }, aceitosConhecidos: [], novaOperacao: nova } as const
      await aplicarRecepcaoEstoque(b, { tipo: 'encerramento', recepcao: '1', encerramento })
      expect(await b.fila.count()).toBe(1)
      const r2 = { ...nova, operacao: { ...nova.operacao, revisao: 2, movimentos: [{ id: 'nova-compra', revisao: 2 }] },
        movimentos: nova.movimentos.map((m) => ({ ...m, revisao: 2, quantidade: 8 })) }
      if (aceita) await aplicarRecepcaoEstoque(b, { tipo: 'operacao', recepcao: '2', grupo: r2, evidencias: nova.movimentos })
      else await aplicarRecepcaoEstoque(b, { tipo: 'encerramento', recepcao: '2', encerramento: {
        id: 'encerrar-nova', data: DIA, tentativa: identidadeDaTentativa(r2),
        evidencia: { grupo: r2, desfecho: 'recusada', diagnostico: '23514' }, aceitosConhecidos: [] } })
      expect(await b.fila.count()).toBe(0)
      expect((await b.operacoes.get('nova'))?.revisao).toBe(aceita ? 2 : undefined)
      expect(ok(projetarEstoque(await b.movimentos.toArray(), 'produto')).fisico).toBe(aceita ? 8 : 0)
      b.close()
    }
  })
})
