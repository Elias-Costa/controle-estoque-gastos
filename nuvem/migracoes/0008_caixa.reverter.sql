-- Exclusivo de teste, nunca recuperação de produção (D-041/050/069).
-- Com qualquer histórico de caixa, recusa ANTES de alterar o esquema.
do $$ begin
  if exists(select 1 from public.operacoes_caixa) or exists(select 1 from public.fatos_caixa) then
    raise exception 'Há histórico de caixa; a reversão não apaga nem invalida esses dados.';
  end if;
end $$;
drop function public.baixar_caixa(text,integer);
drop function public.aceitar_grupo_caixa(jsonb);
alter table public.operacoes_caixa drop constraint operacoes_caixa_alvo_fato;
drop table public.fatos_caixa;
drop function caixa_interno.grupo_json(public.operacoes_caixa);
drop table public.operacoes_caixa;
drop schema caixa_interno cascade;
