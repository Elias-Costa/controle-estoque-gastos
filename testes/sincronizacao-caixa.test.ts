import { afterEach, describe, expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal, type Problema } from '../src/dados/banco.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { criarOperacoesCaixa } from '../src/dados/operacoes-caixa.ts'
import { criarRepositorioCaixa } from '../src/dados/repositorio-caixa.ts'
import type { GrupoCaixa } from '../src/dados/tipos-caixa.ts'
import { projetarCaixa } from '../src/dominio/caixa.ts'
import type { ResultadoCaixa } from '../src/dominio/gastos.ts'
import { grupoCaixaDaNuvem, grupoCaixaParaNuvem, recepcaoCaixaDaNuvem } from '../src/sincronizacao/borda-caixa.ts'
import { aplicarRecepcaoCaixa } from '../src/sincronizacao/recepcao-caixa.ts'
import { iniciarSincronizacao } from '../src/sincronizacao/sincronizacao.ts'
import type { Nuvem, Resposta } from '../src/sincronizacao/nuvem.ts'

const GRANDE = 9007199254740993n, DIA = '2026-10-24'
const PROBLEMA: Problema = { codigo: '23505', mensagem: 'alvo já corrigido', em: `${DIA}T12:00:00Z` }
const bancos: BancoLocal[] = []
afterEach(() => { for (const b of bancos.splice(0)) b.close() })
function abrir(fabrica = new IDBFactory(), nome = uuidv7()) {
  const b = new BancoLocal(nome, { indexedDB: fabrica, IDBKeyRange }); bancos.push(b); return b
}
function ok<T>(r: ResultadoCaixa<T>): T { if (!r.ok) throw new Error(r.motivo); return r.valor }
function entrada(valor = GRANDE) {
  return { tipo: 'despesa', valor, categoria: 'Categoria livre', classificacao: 'negocio', mercadoria: true, data: DIA } as const
}
function portas(b: BancoLocal) { const repo = criarRepositorioCaixa(b); return { repo, op: criarOperacoesCaixa(repo) } }
function registro(valor = GRANDE): GrupoCaixa {
  const f = { ...entrada(valor), id: uuidv7(), revisao: 1 }
  return { operacao: { id: uuidv7(), formato: 1, revisao: 1, tipo: 'registro', fatos: [{ id: f.id, revisao: 1 }] }, fatos: [f] }
}
function corrigido(original: GrupoCaixa, valor = 8000n): GrupoCaixa {
  const alvo = original.operacao.fatos[0]; if (!alvo) throw new Error('sem alvo')
  const estorno = { id: uuidv7(), revisao: 1, tipo: 'estorno', data: DIA, alvo } as const
  const substituto = { ...entrada(valor), id: uuidv7(), revisao: 1 }
  return { operacao: { id: uuidv7(), formato: 1, revisao: 1, tipo: 'correcao', alvo,
    fatos: [estorno, substituto].map(({ id, revisao }) => ({ id, revisao })) }, fatos: [estorno, substituto] }
}
function nuvem(mudancas: Partial<Nuvem> = {}): Nuvem {
  const enviado = async (): Promise<Resposta<void>> => ({ ok: true, valor: undefined })
  const vazio = async (): Promise<Resposta<readonly Record<string, unknown>[]>> => ({ ok: true, valor: [] })
  return { temSessao: async () => true, aoMudarSessao: () => () => undefined, enviarCliente: enviado, enviarLancamento: enviado,
    enviarCategoria: enviado, enviarProduto: enviado, enviarGrupo: enviado, enviarEncerramento: async () => ({ ok: true, valor: 'id' }),
    buscarClientes: vazio, buscarLancamentos: vazio, buscarCategorias: vazio, buscarProdutos: vazio, buscarEstoque: vazio,
    enviarCaixa: enviado, buscarCaixa: vazio, enviarModelos: enviado, buscarModelos: vazio, ...mudancas }
}
function motor(banco: BancoLocal, n: Nuvem) {
  return iniciarSincronizacao({ banco, nuvem: n, agendar: () => () => undefined, janela: null, documento: null })
}
async function receber(b: BancoLocal, grupo: GrupoCaixa, recepcao = '1') { await aplicarRecepcaoCaixa(b, { grupo, recepcao }) }
async function captura(b: BancoLocal, g: GrupoCaixa) {
  const e = await criarRepositorioCaixa(b).capturarEnvio(g.operacao.id); if (!e) throw new Error('sem envio'); return e
}
async function retrato(b: BancoLocal) {
  return { fatos: await b.fatosCaixa.toArray(), operacoes: await b.operacoesCaixa.toArray(), versoes: await b.versoesCaixa.toArray(),
    fila: await b.fila.toArray(), cursores: await b.sincronizacao.toArray() }
}
async function recusar(p: Promise<unknown>, trecho = '') {
  let recebido: unknown
  try { await p } catch (erro) { recebido = erro }
  expect(recebido).toBeInstanceOf(Error)
  expect(String(recebido)).toContain(trecho)
}

describe('E-33: caixa no transporte e IndexedDB simulado, sem prova de aparelho', () => {
  test('todos os campos de despesa, receita, estorno e correção fazem ida/volta com centavos exatos', () => {
    const g = registro(), c = corrigido(g)
    const r: GrupoCaixa = { ...g, fatos: [{ id: g.fatos[0]!.id, revisao: 1, tipo: 'receita-avulsa', valor: 1n,
      categoria: 'Pessoal', classificacao: 'pessoal', data: '2026-09-30' }] }
    const e: GrupoCaixa = { operacao: { ...c.operacao, tipo: 'estorno', fatos: c.operacao.fatos.slice(0, 1) }, fatos: c.fatos.slice(0, 1) }
    for (const grupo of [g, r, e, c]) {
      expect(grupoCaixaDaNuvem(grupoCaixaParaNuvem(grupo))).toEqual(grupo)
      expect(recepcaoCaixaDaNuvem({ recepcao: '9007199254740993', grupo: grupoCaixaParaNuvem(grupo) })).toEqual({ recepcao: '9007199254740993', grupo })
    }
    expect(grupoCaixaParaNuvem(g)['fatos']).toEqual([{ ...g.fatos[0], valor: String(GRANDE) }])
  })
  test('borda rejeita dinheiro numérico/fracionário, campos perdidos, formas inválidas e correção incompleta', () => {
    const g = registro(), c = corrigido(g), f = grupoCaixaParaNuvem(g)['fatos']
    if (!Array.isArray(f)) throw new Error('sem fatos')
    for (const valor of [100, '1.5', '-1', '0', '9223372036854775808', null]) {
      expect(() => grupoCaixaDaNuvem({ ...grupoCaixaParaNuvem(g), fatos: [{ ...f[0], valor }] })).toThrow()
    }
    for (const extra of [{ data: '2026-02-30' }, { categoria: '' }, { mercadoria: 'true' }, { classificacao: 'pessoal' }, { desconhecido: true }]) {
      expect(() => grupoCaixaDaNuvem({ ...grupoCaixaParaNuvem(g), fatos: [{ ...f[0], ...extra }] })).toThrow()
    }
    expect(() => grupoCaixaDaNuvem({ ...grupoCaixaParaNuvem(c), fatos: f })).toThrow()
    expect(() => grupoCaixaDaNuvem({ ...grupoCaixaParaNuvem(g), operacao: { ...g.operacao, fatos: [] } })).toThrow()
    for (const recepcao of [1, '0', '-1', '1.5', null]) expect(() => recepcaoCaixaDaNuvem({ recepcao, grupo: grupoCaixaParaNuvem(g) })).toThrow()
  })
  test('alvo precisa de aceite, não basta um fato local pendente; grupo incompleto não muda cursor', async () => {
    const b = abrir(), { op } = portas(b), g = ok(await op.registrar(entrada())), c = corrigido(g)
    const antes = await retrato(b)
    await recusar(receber(b, c), 'vínculo')
    expect(await retrato(b)).toEqual(antes)
    await recusar(receber(b, { ...c, fatos: c.fatos.slice(0, 1) }))
    expect(await retrato(b)).toEqual(antes)
    await receber(b, g); await receber(b, c, '2')
    expect(await b.fatosCaixa.count()).toBe(3)
    expect(ok(projetarCaixa(await b.fatosCaixa.toArray(), [], '2026-10')).tudo.saiu).toBe(8000n)
  })
  test('erro no cursor desfaz grupo, aceite e efeitos; repetir posição não duplica nada', async () => {
    const b = abrir(), g = registro(), falhar = () => { throw new Error('falha no cursor') }
    b.sincronizacao.hook('creating', falhar)
    await recusar(receber(b, g), 'cursor')
    b.sincronizacao.hook('creating').unsubscribe(falhar)
    expect(await b.fatosCaixa.count()).toBe(0); expect(await b.versoesCaixa.count()).toBe(0)
    await receber(b, g); const antes = await retrato(b); await receber(b, g)
    expect(await retrato(b)).toEqual(antes)
    await recusar(receber(b, registro(), '3'), 'posição')
    expect(await retrato(b)).toEqual(antes)
  })
  test('resposta perdida conserva FIFO; retentativa usa mesmo grupo e base vazia restaura os campos', async () => {
    const a = abrir(), b = abrir(), { op } = portas(a), g = ok(await op.registrar(entrada()))
    const recebidos: unknown[] = [], documentos = [grupoCaixaParaNuvem(g)]
    let perder = true
    const n = nuvem({ enviarCaixa: async (doc) => {
      recebidos.push(doc)
      return perder ? { ok: false, falha: { tipo: 'rede', mensagem: 'resposta perdida após commit simulado' } } : { ok: true, valor: undefined }
    }, buscarCaixa: async (apos) => ({ ok: true, valor: apos === '0' ? [{ recepcao: '1', grupo: documentos[0] }] : [] }) })
    const m = motor(a, n); await m.sincronizar()
    expect(m.estado().ultimaFalha).toBe('rede'); expect(await a.fila.count()).toBe(1)
    perder = false; await m.sincronizar(); m.parar()
    expect(recebidos).toEqual([documentos[0], documentos[0]]); expect(await a.fila.count()).toBe(0)
    const outro = motor(b, n); await outro.sincronizar(); outro.parar()
    expect(await b.fatosCaixa.toArray()).toEqual([...g.fatos]); expect(await b.fila.count()).toBe(0)
    expect((await b.sincronizacao.get('caixa'))?.valor).toBe('1')
  })
  for (const recusa of [false, true]) test(`resposta ${recusa ? 'recusada' : 'aceita'} antiga e download não sobrescrevem edição em trânsito`, async () => {
    const b = abrir(), { op } = portas(b), g = ok(await op.registrar(entrada(100n)))
    const m = motor(b, nuvem({ enviarCaixa: async () => {
      ok(await op.corrigir(g.operacao.fatos[0]!, entrada(80n), DIA))
      return recusa ? { ok: false, falha: { tipo: 'recusa', codigo: '23514', mensagem: 'resposta antiga' } } : { ok: true, valor: undefined }
    }, buscarCaixa: async () => ({ ok: true, valor: [{ recepcao: '1', grupo: grupoCaixaParaNuvem(g) }] }) }))
    await m.sincronizar(); m.parar()
    expect((await b.fila.toArray())[0]?.versao).toBe(2); expect((await b.fila.toArray())[0]?.problema).toBeUndefined()
    expect(await b.fatosCaixa.toArray()).toEqual([{ ...entrada(80n), id: g.fatos[0]!.id, revisao: 2 }])
    expect((await b.versoesCaixa.toArray()).some((v) => v.aceita && v.grupo.operacao.revisao === 1)).toBe(true)
  })
  test('recusa não prende escrita independente nem é retentada; sessão/rede não viram recusa', async () => {
    for (const falha of [{ tipo: 'recusa', codigo: '23514', mensagem: 'recusada' }, { tipo: 'sessao', mensagem: 'sessão' },
      { tipo: 'rede', mensagem: 'rede' }, { tipo: 'recusa', codigo: '23503', mensagem: 'pai' }] as const) {
      const b = abrir(), { op } = portas(b), g = ok(await op.registrar(entrada())), independente = ok(await op.registrar(entrada(1n)))
      let tentativas = 0
      const m = motor(b, nuvem({ enviarCaixa: async (d) => {
        if (grupoCaixaDaNuvem(d).operacao.id !== g.operacao.id) return { ok: true, valor: undefined }
        tentativas++; return { ok: false, falha }
      } }))
      await m.sincronizar(); await m.sincronizar(); m.parar()
      const definitiva = falha.tipo === 'recusa' && falha.codigo !== '23503'
      expect(tentativas).toBe(definitiva ? 1 : 2)
      expect((await b.fila.toArray()).find((f) => f.registroId === g.operacao.id)?.problema !== undefined).toBe(definitiva)
      if (falha.tipo === 'recusa') expect(await criarRepositorioCaixa(b).sincronizado(independente.fatos[0]!.id)).toBe(true)
    }
  })
  for (const primeiroDownload of [false, true]) test(`D-070 preserva tentativa e dependentes; ${primeiroDownload ? 'aceite' : 'recusa'} chega primeiro`, async () => {
    const b = abrir(), { repo, op } = portas(b), g = registro(100n)
    await receber(b, g)
    const tentativa = ok(await op.corrigir(g.operacao.fatos[0]!, entrada(90n), DIA)), envio = await captura(b, tentativa)
    const substituto = tentativa.fatos.find((f) => f.tipo !== 'estorno'); if (!substituto) throw new Error('sem substituto')
    const dependente = ok(await op.estornar(substituto, DIA)), aceito = corrigido(g, 80n)
    if (primeiroDownload) await receber(b, aceito, '2')
    await repo.responderEnvio(envio, PROBLEMA)
    if (!primeiroDownload) await receber(b, aceito, '2')
    expect(ok(projetarCaixa(await repo.listarFatos(), [], '2026-10')).tudo.saiu).toBe(80n)
    const historico = await b.versoesCaixa.toArray()
    expect(historico.find((v) => v.operacaoId === tentativa.operacao.id)?.grupo).toEqual(tentativa)
    expect(historico.find((v) => v.operacaoId === tentativa.operacao.id)?.problema).toEqual(PROBLEMA)
    expect(historico.find((v) => v.operacaoId === dependente.operacao.id)?.foraDaProjecao).toBeDefined()
    expect(await repo.capturarEnvio(dependente.operacao.id)).toBeUndefined()
    expect(await b.fila.count()).toBe(2); expect(await repo.comProblema(substituto.id)).toBe(true)
    ok(await op.registrar(entrada(1n)))
    // Evidências/retirada também sobrevivem à reabertura da mesma fábrica.
    const antes = await retrato(b); b.close(); await b.open(); expect(await retrato(b)).toEqual(antes)
  })
  test('D-070 versão nova recusada cede à anterior aceita, sem apagar a fotografia da edição', async () => {
    const b = abrir(), { repo, op } = portas(b), g = ok(await op.registrar(entrada(100n))), e1 = await captura(b, g)
    ok(await op.corrigir(g.operacao.fatos[0]!, entrada(80n), DIA)); await repo.responderEnvio(e1)
    const e2 = await captura(b, { ...g, operacao: { ...g.operacao, revisao: 2 } })
    await receber(b, g); expect((await repo.listarFatos())[0]).toEqual({ ...entrada(80n), id: g.fatos[0]!.id, revisao: 2 })
    await repo.responderEnvio(e2, PROBLEMA)
    expect(await repo.listarFatos()).toEqual([...g.fatos]); expect(await b.versoesCaixa.count()).toBe(2)
    expect((await b.fila.toArray())[0]?.problema).toEqual(PROBLEMA)
  })
  test('download malformado não avança; retoma da última posição válida em duas conexões', async () => {
    const fabrica = new IDBFactory(), b = abrir(fabrica), outro = abrir(fabrica, b.name), g = registro()
    await Promise.all([receber(b, g), receber(outro, g)])
    expect(await b.versoesCaixa.count()).toBe(1)
    let malformado = true
    const n = nuvem({ buscarCaixa: async () => ({ ok: true, valor: [{ recepcao: '2', grupo: malformado ? {} : grupoCaixaParaNuvem(registro(1n)) }] }) })
    const m = motor(b, n); await m.sincronizar(); expect(m.estado().ultimaFalha).toBe('rede')
    expect((await b.sincronizacao.get('caixa'))?.valor).toBe('1')
    malformado = false; await m.sincronizar(); m.parar()
    expect((await b.sincronizacao.get('caixa'))?.valor).toBe('2')
  })
  test('501 grupos: interrupção após primeira página retoma sem perder ou repetir efeitos', async () => {
    const b = abrir(), grupos = Array.from({ length: 501 }, () => registro(1n))
    let interromper = true
    const n = nuvem({ buscarCaixa: async (apos, limite) => {
      if (apos === '500' && interromper) return { ok: false, falha: { tipo: 'rede', mensagem: 'interrompida' } }
      return { ok: true, valor: grupos.slice(Number(apos), Number(apos) + limite).map((g, i) =>
        ({ recepcao: String(BigInt(apos) + BigInt(i) + 1n), grupo: grupoCaixaParaNuvem(g) })) }
    } })
    const m = motor(b, n); await m.sincronizar()
    expect(m.estado().ultimaFalha).toBe('rede'); expect((await b.sincronizacao.get('caixa'))?.valor).toBe('500')
    interromper = false; await m.sincronizar(); m.parar()
    expect((await b.sincronizacao.get('caixa'))?.valor).toBe('501'); expect(await b.fatosCaixa.count()).toBe(501)
    expect(ok(projetarCaixa(await b.fatosCaixa.toArray(), [], '2026-10')).tudo.saiu).toBe(501n)
  }, 60_000)
})
