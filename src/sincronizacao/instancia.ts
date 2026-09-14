/**
 * A sincronização do aplicativo — um motor só, sobre a base do app e a nuvem configurada no
 * build (E-07, D-042).
 *
 * Fica num arquivo próprio pelo mesmo motivo de `src/dados/instancia.ts`: os testes importam
 * `iniciarSincronizacao` e criam o seu motor sobre uma base e uma nuvem de mentira; nunca
 * tocam neste. Quem o usa: `main.tsx` (liga na abertura) e o indicador (`src/interface`).
 *
 * Sem `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` no build, `nuvemDoApp` é `null` e o motor
 * nunca tenta a rede: o app funciona inteiro no aparelho e o indicador fica em "para enviar" —
 * honesto. É o mesmo ternário de E-00, com o mesmo cuidado: sem as variáveis o `supabase-js` some
 * do bundle por tree-shaking e a medição de tamanho mente (`AGENTS.md` §2.1).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { aoEnfileirar, banco } from '../dados/instancia.ts'
import { criarConta, type Conta } from './conta.ts'
import { criarClienteSupabase, criarNuvemSupabase, type Nuvem } from './nuvem.ts'
import { iniciarSincronizacao } from './sincronizacao.ts'

const url: string | undefined = import.meta.env.VITE_SUPABASE_URL
const chaveAnonima: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * O cliente `supabase-js` do app, ou `null` sem configuração. Exportado para o laboratório de
 * E-08 entrar e sair com o usuário de teste (`D-043`); o motor não o vê — só a `Nuvem` abaixo,
 * e a tela de login só a `Conta`.
 */
export const supabaseDoApp: SupabaseClient | null = url && chaveAnonima ? criarClienteSupabase(url, chaveAnonima) : null

/** A nuvem do app, ou `null` sem configuração. */
export const nuvemDoApp: Nuvem | null = supabaseDoApp ? criarNuvemSupabase(supabaseDoApp) : null

/** A conta do app (E-13, D-048): a tela de login e a linha "Entrar ›" da tela inicial vivem sobre ela. */
export const conta: Conta = criarConta(supabaseDoApp?.auth ?? null)

/** O motor do app. Acorda a cada gravação local (a única ligação entre `dados` e esta pasta, e nesta direção). */
export const sincronizacao = iniciarSincronizacao({ banco, nuvem: nuvemDoApp })

aoEnfileirar(() => sincronizacao.acordar())
