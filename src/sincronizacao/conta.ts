/**
 * A conta na nuvem (E-13, RF-27, D-005, D-048): entrar, e o que a tela precisa saber — se há
 * sessão guardada neste aparelho ou se alguém precisa entrar.
 *
 * É deliberadamente separada do `sessao` do motor (`sincronizacao.ts`): lá a pergunta é
 * "consegui usar a sessão agora?", que é `false` também sem rede; aqui a pergunta é "há uma
 * sessão guardada?". A diferença é o que impede a linha "Entrar ›" de aparecer para ela num
 * lugar sem sinal — e D-005 diz que o app segue offline com os dados locais até o login voltar.
 *
 * O que o `@supabase/auth-js` 2.115.0 faz, conferido no fonte (`docs/fatos-verificados.md`):
 * - com o token vencido e a rede fora, `getSession()` devolve `session: null` com um
 *   `AuthRetryableFetchError` **e mantém a sessão guardada** — vai tentar de novo depois;
 * - refresh recusado em definitivo (token inválido) apaga a guardada e emite `SIGNED_OUT`;
 * - `INITIAL_SESSION` vem com `null` também no caso retentável, por isso ele não decide nada.
 *
 * Nada aqui toca a base local: sessão não é problema do dado dela (D-005, EL-05). A guarda em
 * `testes/sem-rede.test.ts` garante que continua assim.
 */

import { isAuthApiError, isAuthRetryableFetchError, type AuthChangeEvent, type Session } from '@supabase/supabase-js'

/** O que a tela mostra: `conferindo` só até a primeira leitura; `sem-nuvem` é o build sem configuração. */
export type EstadoDaConta = 'sem-nuvem' | 'conferindo' | 'entrou' | 'precisa-entrar'

/** Por que o login foi recusado. `outra` guarda a mensagem para o console, nunca para ela. */
export type RecusaDoLogin = { readonly motivo: 'credenciais' } | { readonly motivo: 'rede' } | { readonly motivo: 'sem-nuvem' } | { readonly motivo: 'outra'; readonly mensagem: string }

/** O que `getSession()` devolve, no que importa aqui. */
export type LeituraDaSessao = { readonly data: { readonly session: Session | null }; readonly error: unknown }

/**
 * O pedaço do `supabase.auth` que a conta usa. Os testes passam um de mentira; o app passa o
 * cliente de `instancia.ts`.
 */
export interface Autenticacao {
  getSession(): Promise<LeituraDaSessao>
  signInWithPassword(credenciais: { email: string; password: string }): Promise<{ readonly error: unknown }>
  onAuthStateChange(ouvinte: (evento: AuthChangeEvent, sessao: Session | null) => void): { data: { subscription: { unsubscribe: () => void } } }
}

/** A conta do app, para a tela (`useSyncExternalStore`) e para a tela de login. */
export interface Conta {
  readonly estado: () => EstadoDaConta
  readonly assinar: (ouvinte: () => void) => () => void
  readonly entrar: (email: string, senha: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly recusa: RecusaDoLogin }>
  /** Relê a sessão guardada. Chamado na criação; exposto para o laboratório e os testes. */
  readonly conferir: () => Promise<void>
  readonly parar: () => void
}

/**
 * Sessão guardada ou não, a partir do que `getSession()` devolveu. Sem sessão **e** sem erro
 * retentável é "precisa entrar"; com erro retentável, a sessão existe e a rede é que falhou.
 */
export function estadoDaSessao(leitura: LeituraDaSessao): 'entrou' | 'precisa-entrar' {
  if (leitura.data.session !== null) return 'entrou'
  if (leitura.error !== null && leitura.error !== undefined && isAuthRetryableFetchError(leitura.error)) return 'entrou'
  return 'precisa-entrar'
}

/** O motivo da recusa do login, a partir do erro do `signInWithPassword`. */
export function motivoDaRecusa(erro: unknown): RecusaDoLogin {
  if (isAuthRetryableFetchError(erro)) return { motivo: 'rede' }
  if (isAuthApiError(erro) && erro.code === 'invalid_credentials') return { motivo: 'credenciais' }
  return { motivo: 'outra', mensagem: erro instanceof Error ? erro.message : String(erro) }
}

/** Cria a conta sobre uma autenticação — ou sobre `null`, quando o build veio sem nuvem. */
export function criarConta(auth: Autenticacao | null): Conta {
  let estado: EstadoDaConta = auth === null ? 'sem-nuvem' : 'conferindo'
  const ouvintes = new Set<() => void>()

  function mudar(novo: EstadoDaConta): void {
    if (novo === estado) return
    estado = novo
    for (const ouvinte of ouvintes) ouvinte()
  }

  async function conferir(): Promise<void> {
    if (auth === null) return
    mudar(estadoDaSessao(await auth.getSession()))
  }

  async function entrar(email: string, senha: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly recusa: RecusaDoLogin }> {
    if (auth === null) return { ok: false, recusa: { motivo: 'sem-nuvem' } }
    const { error } = await auth.signInWithPassword({ email, password: senha })
    if (error !== null && error !== undefined) return { ok: false, recusa: motivoDaRecusa(error) }
    // `SIGNED_IN` chega pelo ouvinte abaixo, mas a tela não precisa esperar por ele.
    mudar('entrou')
    return { ok: true }
  }

  // `SIGNED_OUT` é a única forma de a sessão guardada sumir; `SIGNED_IN` e `TOKEN_REFRESHED`
  // só existem com sessão. `INITIAL_SESSION` não decide: vem `null` também sem rede.
  const assinatura = auth?.onAuthStateChange((evento, sessao) => {
    if (evento === 'SIGNED_OUT') mudar('precisa-entrar')
    else if ((evento === 'SIGNED_IN' || evento === 'TOKEN_REFRESHED') && sessao !== null) mudar('entrou')
  })

  void conferir()

  return {
    estado: () => estado,
    assinar: (ouvinte) => {
      ouvintes.add(ouvinte)
      return () => ouvintes.delete(ouvinte)
    },
    entrar,
    conferir,
    parar: () => assinatura?.data.subscription.unsubscribe(),
  }
}
