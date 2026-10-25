-- Só teste e somente sem preferência salva: não descarta configurações existentes.
do $$ begin
  if exists (select 1 from public.modelos_whatsapp) then
    raise exception 'Modelos existentes impedem reversão' using errcode = '23514';
  end if;
end $$;
drop table public.modelos_whatsapp;
drop function public.modelos_whatsapp_ultimo_que_escreve();
drop function public.modelos_whatsapp_validos(jsonb);
drop function public.modelo_whatsapp_valido(text, boolean);
