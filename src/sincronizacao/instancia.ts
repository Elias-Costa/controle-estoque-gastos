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

import { aoEnfileirar, banco } from '../dados/instancia.ts'
import { criarClienteSupabase, criarNuvemSupabase, type Nuvem } from './nuvem.ts'
import { iniciarSincronizacao } from './sincronizacao.ts'

const url: string | undefined = import.meta.env.VITE_SUPABASE_URL
const chaveAnonima: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY

/** A nuvem do app, ou `null` sem configuração. */
export const nuvemDoApp: Nuvem | null = url && chaveAnonima ? criarNuvemSupabase(criarClienteSupabase(url, chaveAnonima)) : null

/** O motor do app. Acorda a cada gravação local (a única ligação entre `dados` e esta pasta, e nesta direção). */
export const sincronizacao = iniciarSincronizacao({ banco, nuvem: nuvemDoApp })

aoEnfileirar(() => sincronizacao.acordar())
