-- Reverte 0003_fichinha-desativada: apaga a coluna, e com ela a marca de toda fichinha desativada.
--
-- Roda dentro de uma transação (`nuvem/migrar.ts`). Depois de reverter, toda fichinha volta a
-- aparecer nas listas assim que o aparelho baixar as linhas de novo — e um app que ainda envie
-- `desativado_em` tem toda gravação de cliente recusada até a migration ser reaplicada.

alter table public.clientes
  drop column if exists desativado_em;
