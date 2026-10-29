import { afterEach, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal, ESQUEMA_V4 } from '../src/dados/banco.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { identidadeLojaValida, logoValida, type IdentidadeLoja } from '../src/dados/identidade-loja.ts'
import { criarRepositorioIdentidadeLoja } from '../src/dados/repositorio-identidade-loja.ts'
import { aplicarIdentidadeLoja, identidadeDaNuvem, identidadeParaNuvem } from '../src/sincronizacao/identidade-loja.ts'
import { iniciarSincronizacao } from '../src/sincronizacao/sincronizacao.ts'
import type { Nuvem, Resposta } from '../src/sincronizacao/nuvem.ts'

const T = '2026-10-26T12:00:00.000Z', DEPOIS = '2026-10-26T12:01:00.000Z'
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII='
const identidade: IdentidadeLoja = { nome: 'Cícera Mult', descricao: 'Perfumaria e acessórios', logo: LOGO }
const bancos: Dexie[] = []
afterEach(() => { for (const b of bancos.splice(0)) b.close() })
function abrir(fabrica = new IDBFactory(), nome = uuidv7()) {
  const b = new BancoLocal(nome, { indexedDB: fabrica, IDBKeyRange }); bancos.push(b); return b
}

test('D-076 primeiro uso vazio; identidade/logo e fila sobrevivem à reabertura sem inventar marca', async () => {
  const fabrica = new IDBFactory(), nome = uuidv7(), b = abrir(fabrica, nome), r = criarRepositorioIdentidadeLoja(b, () => T)
  expect(await r.ler()).toBeUndefined()
  expect(await b.fila.count()).toBe(0)
  const salva = await r.salvar(identidade, undefined)
  expect(salva.ok).toBe(true); b.close()
  const reaberto = abrir(fabrica, nome)
  expect((await criarRepositorioIdentidadeLoja(reaberto).ler())?.identidade).toEqual(identidade)
  expect(await reaberto.fila.count()).toBe(1)
})
test('v4 preenchida recebe a união: financeiro, fila recusada, captura e bytes são preservados', async () => {
  const fabrica = new IDBFactory(), nome = uuidv7(), antigo = new Dexie(nome, { indexedDB: fabrica, IDBKeyRange }); bancos.push(antigo)
  antigo.version(4).stores(ESQUEMA_V4)
  const dados = { clientes: { id: 'c', nome: 'Vera' }, lancamentos: { id: 'l', clienteId: 'c', valor: 9007199254740993n },
    fila: { ordem: 1, registroId: 'l', tabela: 'lancamentos', problema: { codigo: '23514' } },
    fotos: { id: 'f', produtoId: 'p', binario: new Uint8Array([1, 2, 3]) },
    enviosProdutoFoto: { id: 'e', produtoId: 'p', cadastro: { id: 'p', nome: 'Produto legado' } } }
  for (const [tabela, linha] of Object.entries(dados)) await antigo.table(tabela).put(linha)
  antigo.close(); const atual = abrir(fabrica, nome); await atual.open()
  expect(atual.verno).toBe(9)
  for (const [tabela, linha] of Object.entries(dados)) expect(await atual.table(tabela).toArray()).toEqual([linha])
  expect(await atual.identidadesLoja.count()).toBe(0)
})
test('rollback não deixa preferência sem fila nem fila sem preferência', async () => {
  const b = abrir(), r = criarRepositorioIdentidadeLoja(b)
  await expect(Promise.resolve(b.transaction('rw', b.identidadesLoja, b.fila, async () => {
    await r.salvar(identidade, undefined); throw new Error('interrupção')
  }))).rejects.toThrow('interrupção')
  expect(await b.identidadesLoja.count()).toBe(0); expect(await b.fila.count()).toBe(0)
})
test('duas edições conhecidas exigem conferência e resposta antiga não conclui nem recusa a nova versão', async () => {
  const b = abrir(), r = criarRepositorioIdentidadeLoja(b, () => T)
  await r.salvar(identidade, undefined)
  const base = await r.ler(), envio = base && await r.capturarEnvio(base.id)
  if (!envio) throw new Error('sem captura')
  await r.salvar({ nome: 'Outra marca', descricao: '' }, base)
  expect((await r.salvar(identidade, base)).ok).toBe(false)
  await r.responderEnvio(envio)
  await r.responderEnvio(envio, { codigo: '23514', mensagem: 'antiga', em: T })
  const [fila] = await b.fila.toArray()
  expect(fila?.versao).toBe(1); expect(fila?.problema).toBeUndefined()
  expect((await r.ler())?.identidade.logo).toBeUndefined()
})
test('borda fechada conserva PNG e remoção; inválida não substitui dados recebidos', async () => {
  const b = abrir(), r = criarRepositorioIdentidadeLoja(b, () => T)
  await r.salvar(identidade, undefined); const p = await r.ler(); if (!p) throw new Error('sem preferência')
  expect(identidadeDaNuvem(identidadeParaNuvem(p))).toEqual(p)
  for (const valor of [{ nome: ' ', descricao: '' }, { nome: 'Loja', descricao: '', logo: 'https://externo/imagem.png' },
    { nome: 'Loja', descricao: '', logo: 'data:image/svg+xml;base64,PHN2Zz4=' }, { ...identidade, outro: true }]) expect(identidadeLojaValida(valor)).toBe(false)
  expect(logoValida(LOGO)).toBe(true)
  expect(logoValida(LOGO.replace('iVBOR', 'AAAAA'))).toBe(false)
  expect(() => identidadeDaNuvem({ ...identidadeParaNuvem(p), identidade: { ...identidade, logo: 'inválida' } })).toThrow()
  expect(await r.ler()).toEqual(p)
  await aplicarIdentidadeLoja(b, { ...p, atualizadoEm: DEPOIS, identidade: { nome: 'Outra loja', descricao: '' } })
  expect((await r.ler())?.identidade).toEqual({ nome: 'Outra loja', descricao: '' })
  expect(await b.fila.count()).toBe(0)
  await aplicarIdentidadeLoja(b, p)
  expect((await r.ler())?.identidade.nome).toBe('Outra loja')
})

test('download malformado não publica identidade nem cursor; retomada aceita só o conteúdo completo', async () => {
  const b = abrir(), id = uuidv7()
  let malformado = true
  const vazio = async (): Promise<Resposta<readonly Record<string, unknown>[]>> => ({ ok: true, valor: [] })
  const enviado = async (): Promise<Resposta<void>> => ({ ok: true, valor: undefined })
  const nuvem: Nuvem = { temSessao: async () => true, aoMudarSessao: () => () => undefined,
    enviarCliente: enviado, enviarLancamento: enviado, enviarCategoria: enviado, enviarProduto: enviado, enviarGrupo: enviado,
    enviarEncerramento: async () => ({ ok: true, valor: 'id' }), buscarClientes: vazio, buscarLancamentos: vazio,
    buscarCategorias: vazio, buscarProdutos: vazio, buscarEstoque: vazio,
    enviarCaixa: enviado, buscarCaixa: vazio, enviarModelos: enviado, buscarModelos: vazio,
    identidadeLoja: { enviar: enviado, buscar: async () => ({ ok: true, valor: [{ chave: 'loja', id, atualizado_em: T,
      recebido_em: T, identidade: malformado ? { ...identidade, logo: 'inválida' } : identidade }] }) } }
  const motor = iniciarSincronizacao({ banco: b, nuvem, agendar: () => () => undefined, janela: null, documento: null })
  try {
    await motor.sincronizar()
    expect(motor.estado().ultimaFalha).toBe('rede')
    expect(await b.identidadesLoja.count()).toBe(0)
    expect(await b.sincronizacao.get('identidadeLoja')).toBeUndefined()
    malformado = false; await motor.sincronizar()
    expect(motor.estado().ultimaFalha).toBeNull()
    expect((await b.identidadesLoja.get('loja'))?.identidade).toEqual(identidade)
    expect((await b.sincronizacao.get('identidadeLoja'))?.valor).toBe(T)
  } finally { motor.parar() }
})
