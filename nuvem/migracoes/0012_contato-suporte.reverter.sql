-- Apenas teste: não apagar configuração já existente para reverter.
do $$ begin
  if exists (select 1 from public.contato_suporte) then
    raise exception 'Contato configurado impede reversão' using errcode = '23514';
  end if;
end $$;
drop function public.obter_contato_suporte();
drop table public.contato_suporte;
