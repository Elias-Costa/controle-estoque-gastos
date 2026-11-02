import { afterEach, expect, test } from 'bun:test'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal, ESQUEMA_V9 } from '../src/dados/banco.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { criarRepositorioLembretes } from '../src/dados/repositorio-lembretes.ts'
import { criarRepositorioCopia, vincularContaCopia } from '../src/dados/repositorio-copia.ts'
import { inscricaoPushValida } from '../src/dados/tipos-lembretes.ts'
const bancos: BancoLocal[] = []
afterEach(() => { bancos.splice(0).forEach((b) => b.close()) })
const inscricao = { endpoint: 'https://fcm.googleapis.com/fcm/send/ficticio', p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) }
const vinculo = { contaId: uuidv7(), destino: 'http://127.0.0.1:54321' }
async function abrir(indexedDB = new IDBFactory(), nome = uuidv7()) {
  const b = new BancoLocal(nome, { indexedDB, IDBKeyRange }); bancos.push(b)
  await vincularContaCopia(b, vinculo)
  return b
}
test('upgrade v9 preserva dados/fila; tabelas técnicas começam vazias', async () => {
  const indexedDB = new IDBFactory(), nome = uuidv7()
  const antiga = new Dexie(nome, { indexedDB, IDBKeyRange })
  antiga.version(9).stores(ESQUEMA_V9)
  const cliente = { id: uuidv7(), nome: 'Fictícia', atualizadoEm: '2026-10-31T12:00:00Z' }
  await antiga.table('clientes').add(cliente)
  await antiga.table('fila').add({ tabela: 'clientes', registroId: cliente.id, criadoEm: cliente.atualizadoEm })
  antiga.close()
  const b = await abrir(indexedDB, nome)
  expect(await b.clientes.toArray()).toEqual([cliente])
  expect(await b.fila.count()).toBe(1)
  expect(await b.inscricoesLembretes.count()).toBe(0)
  expect(await b.observacoesLembretes.count()).toBe(0)
})
test('resposta antiga de ativação não religa intenção desligada; persiste ao reabrir', async () => {
  const indexedDB = new IDBFactory(), nome = uuidv7(), b = await abrir(indexedDB, nome)
  const repo = criarRepositorioLembretes(b)
  const pedido = await repo.solicitar(); await repo.completar(pedido.revisao, inscricao)
  const envio = await repo.capturar(); if (!envio) throw new Error('Sem envio')
  await repo.desligar()
  await repo.responder(envio.local, 1, 'ativa')
  expect((await repo.capturar())?.pedido).toEqual({ aparelhoId: pedido.aparelhoId, revisao: 2, anterior: 1, ativa: false })
  expect(await b.fila.count()).toBe(0)
  b.close()
  const outra = criarRepositorioLembretes(await abrir(indexedDB, nome))
  expect((await outra.capturar())?.pedido.ativa).toBe(false)
})
test('completar inscrição antiga não sobrescreve nova intenção nem acrescenta FIFO financeira', async () => {
  const b = await abrir(), r = criarRepositorioLembretes(b)
  const antiga = await r.solicitar(), nova = await r.solicitar()
  await r.completar(antiga.revisao, inscricao)
  expect(await r.capturar()).toBeNull()
  await r.completar(nova.revisao, inscricao)
  expect((await r.capturar())?.pedido.revisao).toBe(2)
  expect(await b.fila.count()).toBe(0)
})
test('observação local sobrevive recarga, mantém motivo no dia e repete só na segunda', async () => {
  const b = await abrir()
  await b.produtos.add({ id: uuidv7(), nome: 'Fictício', categoriaId: uuidv7(), estoqueMinimo: 0, atualizadoEm: '2026-10-31T12:00:00Z' })
  let agora = '2026-10-31T11:00:00Z'
  const r = criarRepositorioLembretes(b, () => agora)
  expect((await r.ler()).motivos.minimo).toHaveLength(1)
  agora = '2026-10-31T12:00:00Z'; expect((await r.ler()).motivos.minimo).toHaveLength(1)
  agora = '2026-11-01T12:00:00Z'; expect((await r.ler()).motivos.minimo).toHaveLength(0)
  agora = '2026-11-02T12:00:00Z'; expect((await r.ler()).motivos.minimo).toHaveLength(1)
})
test('cópia exclui credenciais, intenção e observações; importação preserva inscrição própria do destino', async () => {
  const a = await abrir(), b = await abrir(), ra = criarRepositorioLembretes(a), rb = criarRepositorioLembretes(b)
  const origem = await ra.solicitar(); await ra.completar(origem.revisao, inscricao)
  await ra.ler()
  const destino = await rb.solicitar(); await rb.completar(destino.revisao, { ...inscricao, endpoint: `${inscricao.endpoint}-destino` })
  const dados = await criarRepositorioCopia(a).conferirDados()
  expect(JSON.stringify(dados)).not.toContain('fcm.googleapis.com')
  const copia = criarRepositorioCopia(b), id = await copia.reservarImportacao()
  await copia.prepararImportacao(id, vinculo, '2026-10-31T12:00:00Z', dados)
  await copia.publicar(id, vinculo)
  expect((await rb.capturar())?.local.aparelhoId).toBe(destino.aparelhoId)
  expect((await rb.capturar())?.local.aparelhoId).not.toBe(origem.aparelhoId)
})
test('provedor validado recusa HTTP, host malicioso, credencial na URL, porta, fragmento e campos extras', () => {
  expect(inscricaoPushValida(inscricao)).toBe(true)
  expect(inscricaoPushValida({ ...inscricao, endpoint: 'https://web.push.apple.com/token' })).toBe(true)
  for (const endpoint of ['http://fcm.googleapis.com/a', 'https://fcm.googleapis.com.evil.test/a', 'https://evilpush.apple.com/a',
    'https://localhost/a', 'https://u:p@fcm.googleapis.com/a', 'https://fcm.googleapis.com:8443/a', 'https://fcm.googleapis.com/a#x']) {
    expect(inscricaoPushValida({ ...inscricao, endpoint })).toBe(false)
  }
  expect(inscricaoPushValida({ ...inscricao, segredo: 'extra' })).toBe(false)
})
