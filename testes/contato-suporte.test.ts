import { expect, test } from 'bun:test'
import { criarConsultaContatoSuporte } from '../src/sincronizacao/contato-suporte.ts'

test('D-077 não busca contato ao criar e não conserva número entre consultas explícitas', async () => {
  let chamadas = 0
  const consultar = criarConsultaContatoSuporte(async () => ({ data: ++chamadas === 1 ? '5511999999999' : '5511888888888', error: null }))
  expect(chamadas).toBe(0)
  expect(await consultar()).toEqual({ ok: true, telefone: '5511999999999' })
  expect(await consultar()).toEqual({ ok: true, telefone: '5511888888888' })
  expect(chamadas).toBe(2)
})

test('contato ausente, malformado ou falha não produzem número nem conversa sem destino', async () => {
  for (const data of ['', 'https://externo/', '11999999999', 5511999999999, { telefone: '5511999999999' }]) {
    expect(await criarConsultaContatoSuporte(async () => ({ data, error: null }))()).toEqual({ ok: false, motivo: 'falhou' })
  }
  expect(await criarConsultaContatoSuporte(async () => ({ data: null, error: null }))()).toEqual({ ok: false, motivo: 'nao-configurado' })
  expect(await criarConsultaContatoSuporte(null)()).toEqual({ ok: false, motivo: 'falhou' })
  expect(await criarConsultaContatoSuporte(async () => { throw new Error('Sem rede') })()).toEqual({ ok: false, motivo: 'falhou' })
})

test('recusa de autenticação exige entrar; qualquer erro conserva o contato fora da resposta', async () => {
  for (const code of ['42501', 'PGRST301', 'PGRST302']) {
    expect(await criarConsultaContatoSuporte(async () => ({ data: '5511999999999', error: { code } }))()).toEqual({ ok: false, motivo: 'entrar' })
  }
  expect(await criarConsultaContatoSuporte(async () => ({ data: '5511999999999', error: { code: '' } }))()).toEqual({ ok: false, motivo: 'falhou' })
})
