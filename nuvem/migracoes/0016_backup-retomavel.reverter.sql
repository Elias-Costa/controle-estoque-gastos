-- D-041: recusar antes de qualquer DDL quando houver preparo, objetos ou conjunto reutilizável.
do $$ begin
  if exists(select 1 from backup_interno.preparos)
    or exists(select 1 from backup_interno.objetos_preparo)
    or exists(select 1 from backup_interno.lotes_reutilizaveis)
    or exists(select 1 from storage.objects where bucket_id='backup-partes') then
    raise exception 'backup_preparo_existente_impede_reversao' using errcode='23514';
  end if;
end $$;
drop function public.assumir_preparo_backup(uuid,uuid,text,uuid),
  public.reservar_objetos_backup(uuid,uuid,uuid,integer,jsonb),
  public.avancar_preparo_backup(uuid,uuid,uuid,integer,jsonb,boolean),
  public.soltar_preparo_backup(uuid,uuid,uuid),backup_interno.objetos_descartaveis(uuid);
drop table backup_interno.objetos_preparo,backup_interno.lotes_reutilizaveis,backup_interno.preparos;
delete from storage.buckets where id='backup-partes';
