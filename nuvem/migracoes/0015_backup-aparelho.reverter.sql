-- Apenas ensaio sem capturas do aparelho. Uma candidata existente impede a reversão.
do $$ begin
  if exists(select 1 from backup_interno.capturas where origem='aparelho') then
    raise exception 'backup_aparelho_existente_impede_reversao' using errcode='23514';
  end if;
end $$;

drop function public.ultimo_backup_confirmado(uuid,text),public.consultar_backup_aparelho(uuid,uuid,uuid,text),
  public.reservar_backup_aparelho(uuid,uuid,uuid,text,timestamptz,text,text,text,text,text[],text[]),
  public.trocar_sessao_backup_aparelho(uuid,uuid,uuid,text,text,text);
drop index backup_interno.backup_aparelho_diario;

create or replace function public.proxima_captura_backup(conta uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'estado',c.estado,'capturadoEm',c.capturado_em,'dia',c.dia,
    'vinculo',jsonb_build_object('contaId',c.dono,'destino',c.destino)) from backup_interno.capturas c
    where c.dono=conta and c.estado in ('aguardando','capturada','enviando')
    order by (c.estado='aguardando'),c.tentado_em,c.id limit 1
$$;
