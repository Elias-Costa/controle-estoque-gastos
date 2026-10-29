-- Apenas teste: configuração existente nunca é apagada para reverter.
do $$ begin
  if exists (select 1 from public.identidades_loja) then
    raise exception 'Identificação existente impede reversão' using errcode = '23514';
  end if;
end $$;
drop table public.identidades_loja;
drop function public.identidade_loja_ultimo_que_escreve();
drop function public.identidade_loja_valida(jsonb);
drop function public.logo_loja_valida(text);
