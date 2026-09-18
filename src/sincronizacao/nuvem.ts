/**
 * O transporte até a nuvem (E-07, D-021, D-042): a interface `Nuvem` que o motor consome e a
 * implementação sobre `supabase-js`, que fala com o PostgREST do projeto.
 *
 * O motor (`sincronizacao.ts`) nunca importa `supabase-js`: ele recebe uma `Nuvem`. Nos testes a
 * `Nuvem` é de mentira, em memória, com as mesmas regras do banco; na integração é esta, contra o
 * projeto real com um usuário de teste. É a mesma separação que `Repositorio` faz para o Dexie.
 *
 * **A classificação da falha mora aqui**, por classe de SQLSTATE (D-042):
 *
 * - `rede`: a requisição não chegou ou o servidor não respondeu como PostgREST. O `supabase-js`
 *   engole a falha de `fetch` e devolve um erro com `code: ''` (verificado em
 *   `@supabase/postgrest-js` 2.115, `PostgrestBuilder.then`); um gateway fora do ar devolve
 *   HTML, que vira erro sem SQLSTATE; `08*`, `53*`, `57*` são o Postgres indisponível. Tudo
 *   isso é "tenta de novo".
 * - `sessao`: `42501` (sem privilégio ou política — é o que `anon` recebe) e `PGRST3xx` (JWT
 *   ausente, expirado, inválido). Não é problema do dado dela: a fila espera o login (D-005).
 * - `recusa`: classes `22` (dado), `23` (integridade) e `42` (fora `42501`) — o banco olhou a
 *   linha e disse não. O motor decide o que é definitivo (quase tudo) e o que é "o pai ainda
 *   não chegou" (`23503`).
 *
 * "Só o que o banco recusou de verdade é definitivo; o resto é tenta de novo."
 *
 * O nome da constraint vem em `message`/`details` para violação de `check`, unicidade e chave
 * estrangeira (`… constraint "nome"`); para o `raise … using constraint` dos gatilhos, o que o
 * PostgREST devolve é medido em `testes/integracao/sincronizacao.test.ts`, não presumido.
 *
 * `dono` nunca é enviado (o banco carimba com `auth.uid()`); `recebido_em` e `criado_em` nunca são
 * enviados (o servidor carimba) e voltam no download como cursor.
 */

import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js'
import type { ClienteNaNuvem, LancamentoNaNuvem } from './borda.ts'

/** Por que uma ida à nuvem não deu certo. */
export type Falha =
  | { readonly tipo: 'rede'; readonly mensagem: string }
  | { readonly tipo: 'sessao'; readonly mensagem: string }
  | { readonly tipo: 'recusa'; readonly codigo: string; readonly constraint?: string; readonly mensagem: string }

/** O que toda ida à nuvem devolve: o valor, ou a falha classificada. Falha é valor, não exceção. */
export type Resposta<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly falha: Falha }

/** Uma linha como veio do servidor, ainda sem forma conferida: a borda é quem a lê. */
export type LinhaRecebida = Readonly<Record<string, unknown>>

/**
 * O que o motor precisa da nuvem. `desde` é um carimbo ISO do servidor, ou `null` para tudo;
 * o download devolve as linhas com o carimbo do servidor (`recebido_em` / `criado_em`) dentro.
 */
export type Nuvem = {
  readonly temSessao: () => Promise<boolean>
  /** Avisa quando a sessão muda (entrou, saiu, renovou). Devolve a função que cancela. */
  readonly aoMudarSessao: (ouvinte: () => void) => () => void
  readonly enviarCliente: (linha: ClienteNaNuvem) => Promise<Resposta<void>>
  readonly enviarLancamento: (linha: LancamentoNaNuvem) => Promise<Resposta<void>>
  readonly buscarClientes: (desde: string | null) => Promise<Resposta<readonly LinhaRecebida[]>>
  readonly buscarLancamentos: (desde: string | null) => Promise<Resposta<readonly LinhaRecebida[]>>
}

/**
 * Linhas por página do download. O Supabase limita cada resposta a 1000 linhas por padrão
 * (`db-max-rows`, documentado na plataforma; não medido aqui) — sem paginar, uma base de anos
 * chegaria truncada em silêncio. 500 fica com folga.
 */
export const LINHAS_POR_PAGINA = 500

/**
 * As colunas pedidas, com `::text` no dinheiro: o PostgREST serializa `bigint` como número JSON,
 * e número não entra (RI-01). **Toda coluna que sobe pela borda tem de estar aqui** — uma que
 * falte desce como ausente em silêncio (`testes/sincronizacao.test.ts` confere as duas listas
 * contra `clienteParaNuvem`; lição de E-16, quando `desativado_em` subiu sem descer).
 */
export const COLUNAS_CLIENTE = 'id, nome, telefone, apelido, observacao, desativado_em, atualizado_em, recebido_em'
export const COLUNAS_LANCAMENTO =
  'id, cliente_id, data, tipo, pagamento, forma, itens, desconto::text, parcelas, valor::text, observacao, estorna_id, motivo, criado_em'

const CONSTRAINT = /constraint "([a-z0-9_]+)"/i

/** Classifica o erro do PostgREST (ver o cabeçalho). */
export function classificar(erro: Pick<PostgrestError, 'code' | 'message' | 'details'>): Falha {
  const codigo = erro.code ?? ''
  const mensagem = erro.message ?? ''
  if (codigo === '') return { tipo: 'rede', mensagem }
  if (codigo === '42501' || /^PGRST3\d\d$/.test(codigo)) return { tipo: 'sessao', mensagem }
  if (/^(22|23|42)/.test(codigo)) {
    const achado = CONSTRAINT.exec(`${mensagem}\n${erro.details ?? ''}`)
    const constraint = achado?.[1]
    return constraint === undefined ? { tipo: 'recusa', codigo, mensagem } : { tipo: 'recusa', codigo, constraint, mensagem }
  }
  return { tipo: 'rede', mensagem }
}

/** O cliente do Supabase do app: chave pública, sessão persistida no navegador e renovada sozinha (D-005). */
export function criarClienteSupabase(url: string, chaveAnonima: string): SupabaseClient {
  return createClient(url, chaveAnonima)
}

/** A `Nuvem` sobre um cliente do Supabase — o do app ou o de um teste. */
export function criarNuvemSupabase(supabase: SupabaseClient): Nuvem {
  async function enviar(tabela: 'clientes' | 'lancamentos', linha: LinhaRecebida): Promise<Resposta<void>> {
    // Sem `.select()`: `return=minimal`, nada volta e nada precisa voltar. O `on conflict (id)`
    // é o reenvio idempotente de RI-05; o gatilho do lado de lá decide o resto.
    const { error } = await supabase.from(tabela).upsert(linha, { onConflict: 'id' })
    return error ? { ok: false, falha: classificar(error) } : { ok: true, valor: undefined }
  }

  /** Uma linha como veio do PostgREST, se for objeto; qualquer outra coisa é forma errada e a borda vai lançar. */
  function comoLinha(valor: unknown): LinhaRecebida {
    return typeof valor === 'object' && valor !== null ? { ...valor } : { malformada: valor }
  }

  /** Página a página, em ordem estável (carimbo, id), até uma página vir curta. */
  async function buscar(tabela: 'clientes' | 'lancamentos', colunas: string, carimbo: string, desde: string | null): Promise<Resposta<readonly LinhaRecebida[]>> {
    const todas: LinhaRecebida[] = []
    for (let inicio = 0; ; inicio += LINHAS_POR_PAGINA) {
      let consulta = supabase.from(tabela).select(colunas).order(carimbo, { ascending: true }).order('id', { ascending: true })
      if (desde !== null) consulta = consulta.gte(carimbo, desde)
      const { data, error } = await consulta.range(inicio, inicio + LINHAS_POR_PAGINA - 1)
      if (error) return { ok: false, falha: classificar(error) }
      const pagina: LinhaRecebida[] = Array.isArray(data) ? data.map(comoLinha) : []
      todas.push(...pagina)
      if (pagina.length < LINHAS_POR_PAGINA) return { ok: true, valor: todas }
    }
  }

  return {
    temSessao: async () => {
      const { data } = await supabase.auth.getSession()
      return data.session !== null
    },
    aoMudarSessao: (ouvinte) => {
      const { data } = supabase.auth.onAuthStateChange(() => ouvinte())
      return () => data.subscription.unsubscribe()
    },
    enviarCliente: (linha) => enviar('clientes', { ...linha }),
    enviarLancamento: (linha) => enviar('lancamentos', { ...linha }),
    buscarClientes: (desde) => buscar('clientes', COLUNAS_CLIENTE, 'recebido_em', desde),
    buscarLancamentos: (desde) => buscar('lancamentos', COLUNAS_LANCAMENTO, 'criado_em', desde),
  }
}
