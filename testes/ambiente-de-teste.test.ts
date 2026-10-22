import { describe, expect, test } from 'bun:test'
import { validarDestinoDeTeste, type DestinoDeTeste } from '../nuvem/ambiente-de-teste.ts'

const PROJETO = 'abcdefghijklmnopqrst'
const LOCAL: DestinoDeTeste = {
  ambiente: 'local', api: 'http://127.0.0.1:54321',
  banco: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
}
const HOMOLOGACAO: DestinoDeTeste = {
  ambiente: 'homologacao', api: `https://${PROJETO}.supabase.co`,
  banco: `postgresql://postgres.${PROJETO}:senha@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`,
}

describe('destino de testes: preservar a produção em uso (D-050)', () => {
  test('local só aceita as duas portas de loopback; não precisa de projeto remoto', () => {
    expect(validarDestinoDeTeste(LOCAL)).toBe('local')
  })

  for (const api of ['https://producao.supabase.co', 'http://localhost:54321', 'http://127.0.0.1:54321/rest/v1', 'http://127.0.0.1:54321?host=producao']) {
    test(`local recusa API fora da raiz autorizada: ${api}`, () => {
      expect(() => validarDestinoDeTeste({ ...LOCAL, api })).toThrow()
    })
  }

  for (const banco of [
    'postgresql://postgres:segredo@db.producao.supabase.co:5432/postgres',
    'postgresql://postgres:segredo@127.0.0.1:5432/postgres',
    'postgresql://postgres:segredo@127.0.0.1:54322/outro',
    'postgresql://postgres:segredo@127.0.0.1:54322/postgres?host=db.producao.supabase.co',
  ]) {
    test(`local recusa outro banco, porta ou parâmetros: ${new URL(banco).hostname}:${new URL(banco).port}`, () => {
      expect(() => validarDestinoDeTeste({ ...LOCAL, banco })).toThrow()
    })
  }

  test('sem seleção de ambiente ou com produção, recusa antes de conectar', () => {
    expect(() => validarDestinoDeTeste({ ...LOCAL, ambiente: undefined })).toThrow()
    expect(() => validarDestinoDeTeste({ ...HOMOLOGACAO, ambiente: 'producao' }, PROJETO)).toThrow()
  })

  test('homologação fica fechada enquanto o mantenedor não confirmar seu identificador', () => {
    expect(() => validarDestinoDeTeste(HOMOLOGACAO, null)).toThrow('Homologação bloqueada')
    expect(() => validarDestinoDeTeste(HOMOLOGACAO, 'nome-do-projeto')).toThrow('Homologação bloqueada')
  })

  test('homologação aceita API e session pooler do mesmo projeto confirmado', () => {
    expect(validarDestinoDeTeste(HOMOLOGACAO, PROJETO)).toBe('homologacao')
    expect(validarDestinoDeTeste({ ...HOMOLOGACAO, banco: `postgresql://postgres:senha@db.${PROJETO}.supabase.co:5432/postgres` }, PROJETO)).toBe('homologacao')
  })

  for (const destino of [
    { ...HOMOLOGACAO, api: 'https://outroprojetodiferente.supabase.co' },
    { ...HOMOLOGACAO, banco: 'postgresql://postgres.outroprojetodiferente:senha@aws-0-sa-east-1.pooler.supabase.com:5432/postgres' },
    { ...HOMOLOGACAO, banco: HOMOLOGACAO.banco?.replace(':5432/', ':6543/') },
    { ...HOMOLOGACAO, banco: HOMOLOGACAO.banco?.replace('.pooler.supabase.com', '.pooler.supabase.com.exemplo.test') },
    { ...HOMOLOGACAO, api: `http://${PROJETO}.supabase.co` },
  ]) {
    test(`recusa mistura de projetos, transaction pooler, host falso ou API sem TLS: ${destino.api} / ${new URL(destino.banco ?? '').hostname}:${new URL(destino.banco ?? '').port}`, () => {
      expect(() => validarDestinoDeTeste(destino, PROJETO)).toThrow()
    })
  }

  test('mensagens de configuração inválida não incluem a senha', () => {
    try {
      validarDestinoDeTeste({ ...LOCAL, banco: 'postgresql://postgres:segredo-nao-expor@[invalido' })
      throw new Error('aceitou URL inválida')
    } catch (erro) {
      expect(erro).toBeInstanceOf(Error)
      expect(String(erro)).not.toContain('segredo-nao-expor')
      expect(String(erro)).toContain('Destino de teste ausente ou inválido')
    }
  })
})
