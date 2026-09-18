-- 0003_fichinha-desativada — A marca de "fichinha desativada" em `clientes` (E-16, D-050 item 6).
--
-- Ela pediu, na visita de E-15, para remover um cliente criado por engano. Cliente não se apaga
-- (gatilho `clientes_nao_se_apaga`, 0001, D-041): desativar é uma marca, com a data do dia em que
-- ela desativou, e reativar é tirar a marca. A fichinha desativada some das listas do app e
-- continua abrindo; a dívida, se houver, continua na ficha.
--
-- É uma edição de cliente como qualquer outra: passa pelo mesmo `upsert`, pelo mesmo carimbo
-- `atualizado_em` e pelo mesmo gatilho de último-que-escreve (0002) — não há gatilho novo.
-- `date`, não `timestamptz`: o app guarda a data do fato (RN-09) como em todo lançamento, e o
-- domínio só conhece `Dia` (AAAA-MM-DD).
--
-- Ordem de publicação: o app envia `desativado_em` em TODA gravação de cliente. Esta migration vem
-- ANTES do deploy que a usa — sem a coluna, o `upsert` de qualquer cliente é recusado.
--
-- Reverter: `0003_fichinha-desativada.reverter.sql`. Nunca edite esta migration depois de aplicada.

alter table public.clientes
  add column desativado_em date null;
