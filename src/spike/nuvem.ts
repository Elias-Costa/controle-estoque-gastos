import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Cliente do Supabase para o spike (D-021).
 *
 * Ausência de configuração NÃO é erro: o spike precisa rodar e provar as
 * verificações locais mesmo antes de o projeto na nuvem existir. As verificações
 * que dependem da rede se reportam como indisponíveis, e não como falhas — a
 * diferença importa, porque uma delas reabriria D-021 e a outra não.
 */
const url: string | undefined = import.meta.env.VITE_SUPABASE_URL
const chaveAnonima: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY

export const nuvem: SupabaseClient | null =
  url && chaveAnonima ? createClient(url, chaveAnonima) : null

/** Tabela que E-00 usa para provar o envio idempotente. Some em E-01. */
export const TABELA_SONDA = 'spike_sondas'

/** SQL que o mantenedor roda no editor do Supabase antes da verificação de rede. */
export const SQL_TABELA_SONDA = `create table if not exists ${TABELA_SONDA} (
  id uuid primary key,
  rotulo text not null,
  valor_centavos numeric(19,2) not null,
  criado_em timestamptz not null default now()
);
alter table ${TABELA_SONDA} enable row level security;
create policy "spike aberto para anon" on ${TABELA_SONDA}
  for all to anon using (true) with check (true);`
