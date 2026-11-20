import { expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarRepositorioPrazoEncalhe } from '../src/dados/repositorio-prazo-encalhe.ts'

const AGORA = '2026-11-20T12:00:00.000Z'

test('prazo e fila abortam juntos e só avisam o motor após a gravação', async () => {
  const banco = new BancoLocal('prazo', { indexedDB: new IDBFactory(), IDBKeyRange })
  let avisos = 0
  const r = criarRepositorioPrazoEncalhe(banco, () => AGORA, () => { avisos++ })
  expect(await r.ler()).toBeUndefined()
  for (const dias of [-1, 2.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) await expect(r.salvar(dias, undefined)).rejects.toThrow('Prazo de encalhe inválido')
  const impedirFila = () => { throw new Error('fila indisponível') }
  const hook = banco.fila.hook('creating')
  hook.subscribe(impedirFila)
  await expect(r.salvar(45, undefined)).rejects.toThrow('fila indisponível')
  expect(await r.ler()).toBeUndefined()
  expect(await banco.fila.count()).toBe(0)
  expect(avisos).toBe(0)
  hook.unsubscribe(impedirFila)
  expect(await r.salvar(45, undefined)).toMatchObject({ ok: true, preferencia: { dias: 45 } })
  expect(await banco.fila.count()).toBe(1)
  expect(avisos).toBe(1)
  banco.close()
})

test('conferência conhecida preserva a versão mais nova e resposta antiga não fecha a fila', async () => {
  const banco = new BancoLocal('prazo', { indexedDB: new IDBFactory(), IDBKeyRange })
  const r = criarRepositorioPrazoEncalhe(banco, () => AGORA)
  const primeira = await r.salvar(45, undefined)
  if (!primeira.ok) throw new Error('Primeira escolha ausente')
  const envio = await r.capturarEnvio(primeira.preferencia.id)
  if (!envio) throw new Error('Envio ausente')
  const segunda = await r.salvar(60, primeira.preferencia)
  if (!segunda.ok) throw new Error('Segunda escolha ausente')
  expect(await r.salvar(80, primeira.preferencia)).toEqual({ ok: false, atual: segunda.preferencia })
  await r.responderEnvio(envio)
  await r.responderEnvio(envio, { codigo: '23514', mensagem: 'Recusa antiga', em: AGORA })
  expect(await r.capturarEnvio(primeira.preferencia.id)).toEqual({ preferencia: segunda.preferencia, fila: { ...envio.fila, versao: 1 } })
  banco.close()
})
