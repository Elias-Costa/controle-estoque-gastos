import { describe, expect, test } from 'bun:test'
import { PROJETO_DE_HOMOLOGACAO } from '../nuvem/destinos-de-teste.ts'
import { exigirDestinoDeTeste } from '../nuvem/ambiente-de-teste.ts'
import { exigirDestinoConfiguracaoLembretes, validarDestinoDeProducao } from '../nuvem/lembretes/destino.ts'
import { comandoDeProducao } from '../nuvem/lembretes/producao.ts'

// Somente a origem pública na validação pura; nenhuma função deste teste faz rede.
const PROJETO = 'awmesexptpalzonbucwc'
const API = `https://${PROJETO}.supabase.co`
const BANCO = `postgresql://postgres.${PROJETO}:senha-ficticia@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`

describe('D-081 configuração de produção sem conexão ou credenciais reais', () => {
  test('identificador explícito, API e banco coincidem; direta e Session pooler são aceitos', () => {
    expect(() => validarDestinoDeProducao(PROJETO, API, BANCO)).not.toThrow()
    expect(() => validarDestinoDeProducao(PROJETO, API,
      `postgresql://postgres:senha-ficticia@db.${PROJETO}.supabase.co:5432/postgres`)).not.toThrow()
    for (const acao of ['preparar', 'segredos', 'agendar'] as const) {
      expect(comandoDeProducao([acao, `--projeto=${PROJETO}`])).toEqual({ acao, projeto: PROJETO })
    }
  })

  test('sem confirmação, ação indevida ou homologação nunca selecionam produção', () => {
    for (const argumentos of [[], ['preparar'], ['preparar', '--projeto='], ['migrar', `--projeto=${PROJETO}`],
      ['preparar', `--projeto=${PROJETO}`, '--extra'], ['preparar', PROJETO]]) {
      expect(() => comandoDeProducao(argumentos)).toThrow()
    }
    expect(() => validarDestinoDeProducao('', API, BANCO)).toThrow()
    expect(() => validarDestinoDeProducao('abcdefghijklmnopqrst', 'https://abcdefghijklmnopqrst.supabase.co',
      'postgresql://postgres:senha@db.abcdefghijklmnopqrst.supabase.co:5432/postgres')).toThrow()
    expect(() => validarDestinoDeProducao(PROJETO_DE_HOMOLOGACAO ?? '', API, BANCO)).toThrow('homologação')
  })

  test('mistura de projetos, loopback, porta de transação e URLs disfarçadas são recusados', () => {
    for (const [api, banco] of [
      [undefined, BANCO], [API, undefined], ['http://127.0.0.1:54321', BANCO],
      [`${API}.exemplo.test`, BANCO], [`${API}/rest/v1`, BANCO], [`${API}?outro=1`, BANCO],
      [API.replace('https:', 'http:'), BANCO], [API.replace('https://', 'https://usuario:senha@'), BANCO],
      [`${API}#fragmento`, BANCO], [API, BANCO.replace(PROJETO, 'outroprojetodiferente')],
      [API, BANCO.replace(':5432/', ':6543/')], [API, BANCO.replace('/postgres', '/outro')],
      [API, BANCO.replace('.pooler.supabase.com', '.pooler.supabase.com.exemplo.test')],
      [API, `${BANCO}?host=db.outro.supabase.co`], [API, 'postgresql://postgres:senha@127.0.0.1:54322/postgres'],
    ]) expect(() => validarDestinoDeProducao(PROJETO, api, banco)).toThrow()
  })

  test('mensagem não revela senha nem URL malformada', () => {
    try {
      validarDestinoDeProducao(PROJETO, API, 'senha-ficticia-na-url-invalida')
      throw new Error('URL deveria ser recusada')
    } catch (erro) {
      expect(String(erro)).toContain('API e Postgres')
      expect(String(erro)).not.toContain('senha-ficticia-na-url-invalida')
    }
  })

  test('entrada de produção não afrouxa testes e recusa mistura de variáveis antes de conectar', () => {
    const campos = ['AMBIENTE_DE_TESTE', 'INTEGRACAO', 'VITE_LABORATORIO', 'VITE_SUPABASE_URL', 'SUPABASE_DB_URL']
    const anteriores = campos.map((campo) => process.env[campo])
    try {
      for (const campo of campos) delete process.env[campo]
      process.env.VITE_SUPABASE_URL = API
      process.env.SUPABASE_DB_URL = BANCO
      expect(exigirDestinoConfiguracaoLembretes(PROJETO)).toBe('producao')
      expect(() => exigirDestinoConfiguracaoLembretes()).toThrow('Produção não recebe suítes')
      for (const campo of campos.slice(0, 3)) {
        process.env[campo] = campo === 'AMBIENTE_DE_TESTE' ? 'homologacao' : '1'
        expect(() => exigirDestinoConfiguracaoLembretes(PROJETO)).toThrow('variáveis de teste')
        delete process.env[campo]
      }
      process.env.AMBIENTE_DE_TESTE = 'producao'
      expect(() => exigirDestinoDeTeste()).toThrow('Produção não recebe suítes')
      process.env.AMBIENTE_DE_TESTE = 'local'
      process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:54321'
      process.env.SUPABASE_DB_URL = 'postgresql://postgres:senha@127.0.0.1:54322/postgres'
      expect(exigirDestinoConfiguracaoLembretes()).toBe('local')
    } finally {
      for (const [indice, campo] of campos.entries()) {
        const anterior = anteriores[indice]
        if (anterior === undefined) delete process.env[campo]
        else process.env[campo] = anterior
      }
    }
  })
})
