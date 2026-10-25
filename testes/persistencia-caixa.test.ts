import { afterEach, describe, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal, ESQUEMA_V4, type Problema } from '../src/dados/banco.ts'
import { FORMATO_UUIDV7, uuidv7 } from '../src/dados/identidade.ts'
import { criarOperacoesCaixa, type EntradaCaixaLocal } from '../src/dados/operacoes-caixa.ts'
import { criarRepositorioCaixa } from '../src/dados/repositorio-caixa.ts'
import type { GrupoCaixa } from '../src/dados/tipos-caixa.ts'
import type { FatoCaixa, ResultadoCaixa } from '../src/dominio/gastos.ts'
import { projetarCaixa } from '../src/dominio/caixa.ts'
import { saldo } from '../src/dominio/ficha.ts'
import { projetarEstoque } from '../src/dominio/estoque.ts'

const AGORA = '2026-10-24T12:00:00.000Z'
const PROBLEMA: Problema = { codigo: '23505', constraint: 'caixa_um_estorno', mensagem: 'alvo já estornado', em: AGORA }
const GRANDE = 9007199254740993n
const bancos: BancoLocal[] = []
afterEach(() => { for (const banco of bancos.splice(0)) banco.close() })

function ok<T>(resultado: ResultadoCaixa<T>): T {
  if (!resultado.ok) throw new Error(resultado.motivo)
  return resultado.valor
}
function abrir(indexedDB = new IDBFactory(), nome = uuidv7()) {
  const banco = new BancoLocal(nome, { indexedDB, IDBKeyRange })
  bancos.push(banco)
  return banco
}
function preparar() {
  const indexedDB = new IDBFactory(), banco = abrir(indexedDB)
  let avisos = 0
  const repo = criarRepositorioCaixa(banco, () => AGORA, () => { avisos++ })
  return { indexedDB, banco, repo, operacoes: criarOperacoesCaixa(repo), avisos: () => avisos }
}
type Ambiente = ReturnType<typeof preparar>
function despesa(valor = GRANDE): EntradaCaixaLocal {
  return { tipo: 'despesa', data: '2026-09-30', valor, categoria: '  Mercadoria  ', classificacao: 'negocio', mercadoria: true }
}
function receita(valor = 1000n): EntradaCaixaLocal {
  return { tipo: 'receita-avulsa', data: '2026-10-01', valor, categoria: 'Presente', classificacao: 'pessoal' }
}
function fato(grupo: GrupoCaixa): FatoCaixa {
  const primeiro = grupo.fatos[0]
  if (!primeiro) throw new Error('grupo sem fato')
  return primeiro
}
function movimento(grupo: GrupoCaixa, indice = 0) {
  const item = grupo.fatos[indice]
  if (!item || item.tipo === 'estorno') throw new Error('sem movimento')
  return item
}
async function envio(a: Ambiente, grupo: GrupoCaixa) {
  const capturado = await a.repo.capturarEnvio(grupo.operacao.id)
  if (!capturado) throw new Error('sem captura')
  return capturado
}
async function aceitar(a: Ambiente, grupo: GrupoCaixa) { await a.repo.responderEnvio(await envio(a, grupo)) }
async function retrato(banco: BancoLocal) {
  return { fatos: await banco.fatosCaixa.toArray(), operacoes: await banco.operacoesCaixa.toArray(),
    versoes: await banco.versoesCaixa.toArray(), fila: await banco.fila.toArray() }
}

describe('E-31: persistência do caixa sob IndexedDB simulado, sem prova de aparelho', () => {
  test('despesa/receita, evidências e fila sobrevivem à reabertura com centavos e identidades locais', async () => {
    const a = preparar()
    const d = ok(await a.operacoes.registrar(despesa())), r = ok(await a.operacoes.registrar(receita()))
    expect(fato(d)).toEqual({ ...despesa(), categoria: 'Mercadoria', id: fato(d).id, revisao: 1 })
    expect(a.avisos()).toBe(2)
    for (const grupo of [d, r]) {
      const captura = await envio(a, grupo)
      for (const id of [grupo.operacao.id, fato(grupo).id, captura.versao.id]) expect(id).toMatch(FORMATO_UUIDV7)
      expect(captura.versao.grupo).toEqual(grupo)
      expect(await a.repo.sincronizado(fato(grupo).id)).toBe(false)
    }
    const antes = await retrato(a.banco)
    a.banco.close()
    const reaberto = abrir(a.indexedDB, a.banco.name), repo = criarRepositorioCaixa(reaberto)
    expect(await retrato(reaberto)).toEqual(antes)
    expect((await repo.capturarEnvio(d.operacao.id))?.versao.grupo).toEqual(d)
    expect(ok(projetarCaixa(await repo.listarFatos(), [], '2026-09')).tudo.saiu).toBe(GRANDE)
    expect(await reaberto.clientes.count()).toBe(0)
    expect(await reaberto.lancamentos.count()).toBe(0)
  })

  test('validação não deixa fila, fato ou evidência órfãos', async () => {
    const a = preparar()
    const invalido = [despesa(0n), { ...despesa(), categoria: ' ' }, { ...despesa(), data: 'ontem' },
      { ...despesa(), classificacao: 'pessoal' } satisfies EntradaCaixaLocal]
    for (const entrada of invalido) expect((await a.operacoes.registrar(entrada)).ok).toBe(false)
    expect(await retrato(a.banco)).toEqual({ fatos: [], operacoes: [], versoes: [], fila: [] })
    expect(a.avisos()).toBe(0)
    ok(await a.repo.registrar({ ...despesa(), id: 'mesmo-id' }))
    const antes = await retrato(a.banco)
    expect(await a.repo.registrar({ ...receita(), id: 'mesmo-id' })).toEqual({ ok: false, motivo: 'id-repetido' })
    expect(await retrato(a.banco)).toEqual(antes)
  })

  test('erro na fila depois dos fatos aborta tudo, inclusive substituição composta; não avisa', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    await aceitar(a, d)
    // A chave 1 é ocupada de propósito; o hook só provoca colisão na última escrita.
    const ocupado = { ordem: 1, tabela: 'clientes', registroId: 'outro', criadoEm: AGORA } as const
    await a.banco.fila.put(ocupado)
    const antes = await retrato(a.banco), avisos = a.avisos()
    const falhar = () => 1
    a.banco.fila.hook('creating', falhar)
    try {
      await expect(a.operacoes.corrigir(fato(d), despesa(8000n), '2026-10-24')).rejects.toThrow()
    } finally { a.banco.fila.hook('creating').unsubscribe(falhar) }
    expect(await retrato(a.banco)).toEqual(antes)
    expect(a.avisos()).toBe(avisos)
    a.banco.close()
    expect(await retrato(abrir(a.indexedDB, a.banco.name))).toEqual(antes)
  })

  test('edição pendente conserva ordem e evidência anterior, incrementa revisão sem segunda fila', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    const original = await envio(a, d)
    const corrigido = ok(await a.operacoes.corrigir(fato(d), despesa(8000n), '2026-10-24'))
    expect(corrigido.operacao.id).toBe(d.operacao.id)
    expect(fato(corrigido)).toEqual({ ...movimento(d), revisao: 2, valor: 8000n })
    expect(await a.banco.fila.count()).toBe(1)
    expect((await a.banco.fila.toArray())[0]).toEqual({ ...original.item, versao: 2 })
    expect((await a.repo.lerHistorico(fato(d).id)).map((v) => v.grupo.operacao.revisao).sort()).toEqual([1, 2])
    expect((await a.banco.versoesCaixa.get(original.versao.id))?.grupo).toEqual(d)
  })

  test('falha ao guardar revisão local desfaz fato/manifesto novos e conserva a fila anterior', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    const antes = await retrato(a.banco), avisos = a.avisos()
    const colidir = () => { throw new Error('falha deliberada na evidência') }
    a.banco.versoesCaixa.hook('creating', colidir)
    try {
      await expect(a.operacoes.corrigir(fato(d), despesa(8000n), '2026-10-24')).rejects.toThrow()
    } finally { a.banco.versoesCaixa.hook('creating').unsubscribe(colidir) }
    expect(await retrato(a.banco)).toEqual(antes)
    expect(a.avisos()).toBe(avisos)
  })

  test('substituto inválido não grava estorno parcial nem altera o alvo aceito', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    await aceitar(a, d)
    const antes = await retrato(a.banco)
    expect(await a.operacoes.corrigir(fato(d), despesa(0n), '2026-10-24')).toEqual({ ok: false, motivo: 'valor-invalido' })
    expect(await retrato(a.banco)).toEqual(antes)
  })

  test('janela é relida na gravação: aceite entre a leitura e correção exige grupo composto', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa(10000n)))
    expect(await a.repo.sincronizado(fato(d).id)).toBe(false)
    await aceitar(a, d)
    const corrigido = ok(await a.operacoes.corrigir(fato(d), despesa(8000n), '2026-10-24'))
    expect(corrigido.operacao.tipo).toBe('correcao')
    expect(corrigido.operacao.alvo).toEqual({ id: fato(d).id, revisao: 1 })
    expect(corrigido.fatos).toHaveLength(2)
    expect(corrigido.fatos[0]).toEqual({ tipo: 'estorno', id: fato(corrigido).id, revisao: 1,
      data: '2026-10-24', alvo: { id: fato(d).id, revisao: 1 } })
    expect(corrigido.fatos[1]).toEqual({ ...movimento(d), id: movimento(corrigido, 1).id, valor: 8000n })
    expect(await a.banco.fatosCaixa.get(fato(d).id)).toEqual(fato(d))
    expect(await a.banco.fila.count()).toBe(1)
    expect((await envio(a, corrigido)).versao.grupo).toEqual(corrigido)
    const fatos = await a.repo.listarFatos()
    expect(ok(projetarCaixa(fatos, [], '2026-09')).tudo.saiu).toBe(8000n)
    expect(ok(projetarCaixa(fatos, [], '2026-10')).tudo.saiu).toBe(0n)
    expect((await a.repo.lerHistorico(fato(d).id))).toHaveLength(2)
  })

  test('substituto ainda pendente revisa o grupo inteiro sem separar seu estorno', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    await aceitar(a, d)
    const correcao = ok(await a.operacoes.corrigir(fato(d), despesa(8000n), '2026-10-24'))
    const substituto = movimento(correcao, 1)
    const original = await envio(a, correcao)
    const revisada = ok(await a.operacoes.corrigir(substituto, despesa(7000n), '2026-10-24'))
    expect(revisada.operacao.id).toBe(correcao.operacao.id)
    expect(revisada.operacao.revisao).toBe(2)
    expect(revisada.operacao.alvo).toEqual(correcao.operacao.alvo)
    expect(revisada.fatos[0]).toEqual(correcao.fatos[0])
    expect(revisada.fatos[1]).toEqual({ ...substituto, revisao: 2, valor: 7000n })
    await a.repo.responderEnvio(original)
    expect((await envio(a, revisada)).versao.grupo).toEqual(revisada)
    expect(await a.repo.sincronizado(substituto.id)).toBe(false)
    expect(await a.repo.sincronizado(fato(revisada).id)).toBe(false)
  })

  test.each(['aceite', 'recusa'])('resposta antiga (%s) não conclui nem marca a edição nova, inclusive após reabrir', async (resultado) => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    const antiga = await envio(a, d)
    const revisada = ok(await a.operacoes.corrigir(fato(d), despesa(8000n), '2026-10-24'))
    a.banco.close()
    const banco = abrir(a.indexedDB, a.banco.name), repo = criarRepositorioCaixa(banco)
    await repo.responderEnvio(antiga, resultado === 'recusa' ? PROBLEMA : undefined)
    expect(await banco.fila.toArray()).toEqual([{ ...antiga.item, versao: 2 }])
    expect((await repo.capturarEnvio(revisada.operacao.id))?.versao.grupo).toEqual(revisada)
    const evidencia = await banco.versoesCaixa.get(antiga.versao.id)
    if (resultado === 'aceite') expect(evidencia?.aceita).toBe(true)
    else expect(evidencia?.problema).toEqual(PROBLEMA)
  })

  test('recusa da versão atual preserva conteúdo/evidência, bloqueia edição e mantém outros fatos', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    const captura = await envio(a, d)
    await a.repo.responderEnvio(captura, PROBLEMA)
    expect(await a.repo.comProblema(fato(d).id)).toBe(true)
    expect(await a.repo.sincronizado(fato(d).id)).toBe(false)
    expect(await a.repo.capturarEnvio(d.operacao.id)).toBeUndefined()
    const antes = await retrato(a.banco)
    expect(await a.operacoes.corrigir(fato(d), despesa(1n), '2026-10-24')).toEqual({ ok: false, motivo: 'envio-com-problema' })
    expect(await retrato(a.banco)).toEqual(antes)
    const r = ok(await a.operacoes.registrar(receita()))
    expect((await envio(a, r)).versao.grupo).toEqual(r)
    a.banco.close()
    const repo = criarRepositorioCaixa(abrir(a.indexedDB, a.banco.name))
    expect(await repo.comProblema(fato(d).id)).toBe(true)
    expect((await repo.lerHistorico(fato(d).id))[0]?.problema).toEqual(PROBLEMA)
  })

  test('resposta repetida é idempotente e falha atrasada não desfaz aceite', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    const captura = await envio(a, d)
    await a.repo.responderEnvio(captura)
    await a.repo.responderEnvio(captura)
    await a.repo.responderEnvio(captura, PROBLEMA)
    expect(await a.banco.fatosCaixa.count()).toBe(1)
    expect(await a.banco.versoesCaixa.count()).toBe(1)
    expect(await a.banco.fila.count()).toBe(0)
    expect((await a.repo.lerHistorico(fato(d).id))[0]).toEqual({ ...captura.versao, aceita: true, problema: undefined })
  })

  test('resposta adulterada não atribui aceite nem limpa a fila', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    const captura = await envio(a, d), antes = await retrato(a.banco)
    await expect(a.repo.responderEnvio({ ...captura, item: { ...captura.item, versao: 99 } })).rejects.toThrow('Resposta sem versão')
    await expect(a.repo.responderEnvio({ ...captura, versao: { ...captura.versao,
      grupo: { ...d, fatos: [] } } })).rejects.toThrow('Resposta sem versão')
    expect(await retrato(a.banco)).toEqual(antes)
  })

  test.each(['fato-ausente', 'conteudo-divergente', 'evidencia-ausente', 'fila-divergente'])('captura recusa %s sem confirmar metade', async (falha) => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    const captura = await envio(a, d)
    if (falha === 'fato-ausente') await a.banco.fatosCaixa.delete(fato(d).id)
    if (falha === 'conteudo-divergente') await a.banco.fatosCaixa.put({ ...fato(d), data: '2026-10-01' })
    if (falha === 'evidencia-ausente') await a.banco.versoesCaixa.delete(captura.versao.id)
    if (falha === 'fila-divergente') await a.banco.fila.update(captura.item.ordem, { versao: 99 })
    await expect(a.repo.capturarEnvio(d.operacao.id)).rejects.toThrow()
    expect(await a.banco.fila.count()).toBe(1)
  })

  test('duas conexões corrigindo a mesma revisão local não perdem uma atualização silenciosamente', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    const outra = abrir(a.indexedDB, a.banco.name), op = criarOperacoesCaixa(criarRepositorioCaixa(outra))
    const resultados = await Promise.all([
      a.operacoes.corrigir(fato(d), despesa(100n), '2026-10-24'), op.corrigir(fato(d), despesa(200n), '2026-10-24'),
    ])
    expect(resultados.filter((r) => r.ok)).toHaveLength(1)
    expect(resultados.filter((r) => !r.ok)).toEqual([{ ok: false, motivo: 'alvo-invalido' }])
    expect(await a.banco.fatosCaixa.count()).toBe(1)
    expect(await a.banco.versoesCaixa.count()).toBe(2)
    expect((await a.banco.fila.toArray())[0]?.versao).toBe(2)
  })

  test('duas conexões substituindo alvo enviado confirmam um único estorno/substituto', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    await aceitar(a, d)
    const outra = abrir(a.indexedDB, a.banco.name), op = criarOperacoesCaixa(criarRepositorioCaixa(outra))
    const resultados = await Promise.all([
      a.operacoes.corrigir(fato(d), despesa(100n), '2026-10-24'), op.corrigir(fato(d), despesa(200n), '2026-10-24'),
    ])
    expect(resultados.filter((r) => r.ok)).toHaveLength(1)
    expect(resultados.filter((r) => !r.ok)).toEqual([{ ok: false, motivo: 'ja-estornado' }])
    expect(await a.banco.fatosCaixa.count()).toBe(3)
    expect(await a.banco.operacoesCaixa.count()).toBe(2)
    expect(await a.banco.fila.count()).toBe(1)
  })

  test('estorno preserva o alvo, impede repetição, revisão antiga e estorno de estorno', async () => {
    const a = preparar(), d = ok(await a.operacoes.registrar(despesa()))
    const revisada = ok(await a.operacoes.corrigir(fato(d), despesa(8000n), '2026-10-24'))
    expect(await a.operacoes.estornar(fato(d), '2026-10-24')).toEqual({ ok: false, motivo: 'alvo-invalido' })
    const estorno = ok(await a.operacoes.estornar(fato(revisada), '2026-10-24'))
    expect(await a.banco.fatosCaixa.get(fato(d).id)).toEqual(fato(revisada))
    expect(await a.operacoes.estornar(fato(revisada), '2026-10-24')).toEqual({ ok: false, motivo: 'ja-estornado' })
    expect(await a.operacoes.estornar(fato(estorno), '2026-10-24')).toEqual({ ok: false, motivo: 'alvo-invalido' })
    expect(ok(projetarCaixa(await a.repo.listarFatos(), [], '2026-09')).tudo.saiu).toBe(0n)
  })

  test('upgrade da v4 publicada preserva F1/F2, recusas, evidências, fotos e cursores sem fabricar pagamentos', async () => {
    const indexedDB = new IDBFactory(), nome = uuidv7()
    const antiga = new Dexie(nome, { indexedDB, IDBKeyRange })
    antiga.version(4).stores(ESQUEMA_V4)
    const cliente = { id: 'c', nome: 'Vera', atualizadoEm: AGORA }
    const financeiro = { id: 'v', clienteId: 'c', data: '2026-09-30', tipo: 'venda', pagamento: 'fiado',
      desconto: 0n, itens: [{ descricao: 'Perfume', preco: GRANDE }], parcelas: [{ id: 'p', valor: GRANDE, vencimento: '2026-10-30' }] } as const
    const produto = { id: 'produto', nome: 'Perfume', categoriaId: 'cat', fotoId: 'foto', atualizadoEm: AGORA }
    const movimento = { id: 'compra', revisao: 1, operacaoId: 'op', produtoId: 'produto', data: '2026-10-01',
      tipo: 'compra', quantidade: 10, custoUnitario: GRANDE, ordemCadastro: 100n, conhecidos: [] } as const
    const manifesto = { id: 'op', formato: 1, revisao: 1, tipo: 'movimento', lancamentos: [],
      movimentos: [{ id: 'compra', revisao: 1 }], dependencias: [] } as const
    const grupo = { operacao: manifesto, lancamentos: [], movimentos: [movimento] }
    const copia = { fotoId: 'foto', copiaId: 'copia', sha256: 'a'.repeat(64), bytes: 3, largura: 1, altura: 1,
      caminho: 'conta/foto/copia.jpeg', disponivel: true, aparelhoId: 'aparelho', geracao: 'geracao' }
    const dados: Readonly<Record<string, readonly unknown[]>> = {
      clientes: [cliente], lancamentos: [financeiro], categorias: [{ id: 'cat', nome: 'Perfumes' }], produtos: [produto],
      operacoes: [{ ...manifesto, versaoId: 'versao' }], movimentos: [movimento],
      versoesEstoque: [{ id: 'versao', operacaoId: 'op', grupo, aceita: true },
        { id: 'recusada', operacaoId: 'op', grupo, problema: PROBLEMA }],
      encerramentos: [{ id: 'encerrada', data: '2026-10-24', tentativa: 'tentativa',
        evidencia: { grupo, desfecho: 'recusada', diagnostico: '23505' }, aceitosConhecidos: [] }],
      relogioEstoque: [{ chave: 'cadastro', ultimo: 100n }],
      fotos: [{ id: 'foto', copiaId: 'copia', produtoId: 'produto', cadastroEm: AGORA, geracaoEnvio: 'envio',
        sha256: copia.sha256, bytes: 3, largura: 1, altura: 1, binario: new Uint8Array([1, 2, 3]),
        miniatura: new Uint8Array([4, 5]), situacao: 'pendente' }],
      protecoesFotos: [{ ...copia, id: 'protecao' }], enviosProdutoFoto: [{ id: 'captura', produtoId: 'produto', cadastro: produto }],
      usosFotos: [{ id: 'uso', fotoId: 'foto' }], estadoFotos: [{ chave: 'aparelho', valor: 'aparelho' }, { chave: 'leitura', valor: 'geracao' }],
      fila: [{ ordem: 7, tabela: 'lancamentos', registroId: 'v', criadoEm: AGORA, versao: 2, problema: PROBLEMA },
        { ordem: 8, tabela: 'produtos', registroId: 'produto', criadoEm: AGORA },
        { ordem: 9, tabela: 'fotos', registroId: 'foto', criadoEm: AGORA }],
      sincronizacao: [{ chave: 'lancamentos', valor: AGORA }, { chave: 'estoque', valor: '123' }],
    }
    const anteriores = new Map<string, unknown[]>()
    try {
      for (const [tabela, linhas] of Object.entries(dados)) {
        await antiga.table(tabela).bulkAdd([...linhas])
        anteriores.set(tabela, await antiga.table(tabela).toArray())
      }
    } finally { antiga.close() }
    const atual = abrir(indexedDB, nome), repo = criarRepositorioCaixa(atual)
    await atual.open()
    expect(atual.verno).toBe(7)
    // Também depois de gravar caixa: nenhuma escrita F3 toca cadastros/ficha/estoque/fotos.
    for (const [tabela, linhas] of anteriores) expect(await atual.table(tabela).toArray()).toEqual(linhas)
    expect(await repo.listarFatos()).toEqual([])
    expect(await atual.operacoesCaixa.count()).toBe(0)
    expect(await atual.versoesCaixa.count()).toBe(0)
    ok(await criarOperacoesCaixa(repo).registrar(despesa(8000n)))
    for (const [tabela, linhas] of anteriores) {
      if (tabela !== 'fila') expect(await atual.table(tabela).toArray()).toEqual(linhas)
    }
    expect(dados.fila).toEqual((await atual.fila.toArray()).slice(0, 3))
    expect((await atual.fila.toArray())[3]?.ordem).toBe(10)
    expect(saldo(await atual.lancamentos.toArray())).toBe(GRANDE)
    const estoque = projetarEstoque(await atual.movimentos.toArray(), 'produto')
    if (!estoque.ok) throw new Error(estoque.motivo)
    expect(estoque.valor.fisico).toBe(10)
    expect(estoque.valor.comprasVigentes[0]?.custoUnitario).toBe(GRANDE)
  })
})
