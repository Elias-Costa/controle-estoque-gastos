-- Reverte 0002_ultimo-que-escreve: gatilho, função, índices e as duas colunas, na ordem inversa.
--
-- Roda dentro de uma transação (`nuvem/migrar.ts`): ou desfaz tudo, ou nada. Apagar as colunas
-- apaga os carimbos das linhas existentes — o download por cursor deixa de existir até a migration
-- ser reaplicada, e o cursor local de cada aparelho passa a apontar para um carimbo que a nuvem
-- não tem mais (o aparelho puxa tudo de novo, o que é inofensivo: aplicar duas vezes não muda nada).

drop index if exists public.lancamentos_por_chegada;
drop index if exists public.clientes_por_chegada;

drop trigger if exists clientes_ultimo_que_escreve on public.clientes;
drop function if exists public.cliente_ultimo_que_escreve();

alter table public.clientes
  drop column if exists recebido_em,
  drop column if exists atualizado_em;
