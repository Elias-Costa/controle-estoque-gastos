-- Reverte 0001_fichas: desfaz tudo que a migration criou, na ordem inversa, e devolve o banco ao
-- estado anterior — com uma exceção deliberada, registrada no fim.
--
-- Roda dentro de uma transação (`nuvem/migrar.ts`): ou desfaz tudo, ou nada. `drop table` leva
-- junto as políticas, os índices e os gatilhos da tabela; as funções ficam e são apagadas
-- explicitamente.
--
-- ATENÇÃO: apaga os dados das duas tabelas. É o que "reverter o esquema" significa; a base local
-- de cada aparelho continua intacta (D-002), e é dela que a nuvem seria repovoada.

drop table if exists public.lancamentos;
drop table if exists public.clientes;

drop function if exists public.cliente_nao_se_apaga();
drop function if exists public.lancamento_imutavel();
drop function if exists public.estorno_nao_se_estorna();
drop function if exists public.soma_parcelas(jsonb);
drop function if exists public.soma_itens(jsonb);
drop function if exists public.parcelas_validas(jsonb);
drop function if exists public.itens_validos(jsonb);
drop function if exists public.dia_valido(text);

-- A exceção: a tabela do spike de E-00 volta com a estrutura de antes, vazia, e SEM a política
-- aberta para `anon` que ela tinha. Recriar a política seria reabrir uma tabela que qualquer um
-- com a chave pública do bundle escrevia — não é "voltar atrás", é voltar a um erro.
create table if not exists public.spike_sondas (
  id uuid primary key,
  rotulo text not null,
  valor_centavos numeric(19,2) not null,
  criado_em timestamptz not null default now()
);
alter table public.spike_sondas enable row level security;
