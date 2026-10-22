-- Reversão destrutiva APENAS nos destinos de teste validados (D-041/050).
-- Mantém clientes e todo o histórico financeiro. Descarta estoque, cadastros F2,
-- evidências, resoluções, cursor e vínculos de grupo; não recupera produção com F2 em uso.
drop trigger lancamentos_estoque_completos on public.lancamentos;
drop trigger lancamentos_estoque_proteger on public.lancamentos;
drop function public.baixar_estoque(text,integer);
drop function public.gravar_encerramento_estoque(jsonb);
drop function public.aceitar_grupo_estoque(jsonb,jsonb,uuid);
drop function public.gravar_produto_estoque(jsonb);
drop function public.gravar_categoria_estoque(jsonb);
alter table public.lancamentos drop constraint lancamentos_operacao_estoque;
alter table public.lancamentos drop constraint lancamentos_vinculo_estoque;
alter table public.lancamentos drop column operacao_estoque_id, drop column revisao_estoque;
-- As funções privadas dependem dos tipos das tabelas; CASCADE é restrito ao esquema de F2.
drop schema estoque_interno cascade;
drop table public.movimentos_estoque;
drop table public.operacoes_estoque;
drop table public.encerramentos_estoque;
drop table public.produtos;
drop table public.categorias;
