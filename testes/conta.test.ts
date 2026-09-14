import { describe, expect, test } from 'bun:test'
import { AuthApiError, AuthRetryableFetchError, type AuthChangeEvent, type Session } from '@supabase/supabase-js'
import { criarConta, estadoDaSessao, motivoDaRecusa, type Autenticacao, type LeituraDaSessao } from '../src/sincronizacao/conta.ts'

/**
 * A conta (E-13, RF-27, D-005, D-048): a linha "Entrar ›" só aparece quando não há sessão
 * guardada — nunca por falta de rede —, e a recusa do login vira um motivo que a tela sabe
 * dizer. As formas de erro são as do `@supabase/auth-js` 2.115.0, conferidas no fonte.
 */

/** Uma sessão qualquer: só o que `estadoDaSessao` olha. */
function sessao(): Session {
  return { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'bearer', user: { id: 'u', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' } }
}

const SEM_REDE = new AuthRetryableFetchError('TypeError: Load failed', 0)
const SENHA_ERRADA = new AuthApiError('Invalid login credentials', 400, 'invalid_credentials')
const TOKEN_MORTO = new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found')

describe('estadoDaSessao: sessão guardada ou não, nunca "sem rede" (D-005, D-048)', () => {
  test('com sessão é "entrou"', () => {
    expect(estadoDaSessao({ data: { session: sessao() }, error: null })).toBe('entrou')
  })
  test('sem sessão e sem erro é "precisa entrar" — nunca houve login neste aparelho', () => {
    expect(estadoDaSessao({ data: { session: null }, error: null })).toBe('precisa-entrar')
  })
  test('sem sessão por falha de rede (token vencido, offline) é "entrou": a guardada continua lá', () => {
    expect(estadoDaSessao({ data: { session: null }, error: SEM_REDE })).toBe('entrou')
  })
  test('sem sessão por refresh recusado em definitivo é "precisa entrar"', () => {
    expect(estadoDaSessao({ data: { session: null }, error: TOKEN_MORTO })).toBe('precisa-entrar')
  })
})

describe('motivoDaRecusa: duas frases para ela, o resto para o console', () => {
  test('rede', () => expect(motivoDaRecusa(SEM_REDE)).toEqual({ motivo: 'rede' }))
  test('credenciais', () => expect(motivoDaRecusa(SENHA_ERRADA)).toEqual({ motivo: 'credenciais' }))
  test('qualquer outra coisa guarda a mensagem', () => {
    expect(motivoDaRecusa(new AuthApiError('Too many requests', 429, 'over_request_rate_limit'))).toEqual({ motivo: 'outra', mensagem: 'Too many requests' })
    expect(motivoDaRecusa('estranho')).toEqual({ motivo: 'outra', mensagem: 'estranho' })
  })
})

/** Uma autenticação de mentira: a leitura programável, o login programável e os eventos disparados à mão. */
function autenticacaoDeMentira(inicial: LeituraDaSessao) {
  let leitura = inicial
  let recusa: unknown = null
  let ouvinte: ((evento: AuthChangeEvent, sessao: Session | null) => void) | null = null
  const chamadas: string[] = []
  const auth: Autenticacao = {
    getSession: () => {
      chamadas.push('getSession')
      return Promise.resolve(leitura)
    },
    signInWithPassword: ({ email }) => {
      chamadas.push(`signIn:${email}`)
      return Promise.resolve({ error: recusa })
    },
    onAuthStateChange: (novo) => {
      ouvinte = novo
      return { data: { subscription: { unsubscribe: () => chamadas.push('unsubscribe') } } }
    },
  }
  return {
    auth,
    chamadas,
    recusarCom: (erro: unknown) => (recusa = erro),
    lerComo: (nova: LeituraDaSessao) => (leitura = nova),
    disparar: (evento: AuthChangeEvent, s: Session | null) => ouvinte?.(evento, s),
  }
}

/** Espera as promessas pendentes da conta (a leitura inicial é assíncrona). */
const assentar = (): Promise<void> => new Promise((resolver) => setTimeout(resolver, 0))

describe('criarConta: o estado que a tela lê', () => {
  test('sem nuvem: "sem-nuvem" para sempre, e entrar recusa sem tentar', async () => {
    const conta = criarConta(null)
    expect(conta.estado()).toBe('sem-nuvem')
    expect(await conta.entrar('a@b', 'x')).toEqual({ ok: false, recusa: { motivo: 'sem-nuvem' } })
    expect(conta.estado()).toBe('sem-nuvem')
  })

  test('começa "conferindo", lê a sessão guardada e avisa quem assinou', async () => {
    const mentira = autenticacaoDeMentira({ data: { session: null }, error: null })
    const conta = criarConta(mentira.auth)
    const avisos: string[] = []
    conta.assinar(() => avisos.push(conta.estado()))
    expect(conta.estado()).toBe('conferindo')
    await assentar()
    expect(conta.estado()).toBe('precisa-entrar')
    expect(avisos).toEqual(['precisa-entrar'])
  })

  test('entrar: sucesso vira "entrou"; senha errada e rede viram o motivo, sem mudar o estado', async () => {
    const mentira = autenticacaoDeMentira({ data: { session: null }, error: null })
    const conta = criarConta(mentira.auth)
    await assentar()
    mentira.recusarCom(SENHA_ERRADA)
    expect(await conta.entrar('ela@exemplo', 'errada')).toEqual({ ok: false, recusa: { motivo: 'credenciais' } })
    mentira.recusarCom(SEM_REDE)
    expect(await conta.entrar('ela@exemplo', 'certa')).toEqual({ ok: false, recusa: { motivo: 'rede' } })
    expect(conta.estado()).toBe('precisa-entrar')
    mentira.recusarCom(null)
    expect(await conta.entrar('ela@exemplo', 'certa')).toEqual({ ok: true })
    expect(conta.estado()).toBe('entrou')
    expect(mentira.chamadas.filter((c) => c.startsWith('signIn'))).toEqual(['signIn:ela@exemplo', 'signIn:ela@exemplo', 'signIn:ela@exemplo'])
  })

  test('SIGNED_OUT derruba para "precisa entrar"; SIGNED_IN e TOKEN_REFRESHED com sessão levantam; INITIAL_SESSION nulo não decide', async () => {
    const mentira = autenticacaoDeMentira({ data: { session: sessao() }, error: null })
    const conta = criarConta(mentira.auth)
    await assentar()
    expect(conta.estado()).toBe('entrou')
    mentira.disparar('INITIAL_SESSION', null)
    expect(conta.estado()).toBe('entrou')
    mentira.disparar('SIGNED_OUT', null)
    expect(conta.estado()).toBe('precisa-entrar')
    mentira.disparar('TOKEN_REFRESHED', sessao())
    expect(conta.estado()).toBe('entrou')
    mentira.disparar('SIGNED_OUT', null)
    mentira.disparar('SIGNED_IN', sessao())
    expect(conta.estado()).toBe('entrou')
    conta.parar()
    expect(mentira.chamadas).toContain('unsubscribe')
  })

  test('conferir relê: offline com token vencido continua "entrou"', async () => {
    const mentira = autenticacaoDeMentira({ data: { session: sessao() }, error: null })
    const conta = criarConta(mentira.auth)
    await assentar()
    mentira.lerComo({ data: { session: null }, error: SEM_REDE })
    await conta.conferir()
    expect(conta.estado()).toBe('entrou')
    mentira.lerComo({ data: { session: null }, error: TOKEN_MORTO })
    await conta.conferir()
    expect(conta.estado()).toBe('precisa-entrar')
  })
})
