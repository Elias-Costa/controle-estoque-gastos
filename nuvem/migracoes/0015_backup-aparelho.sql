-- BA-03 / D-084: catálogo de candidatas do aparelho e continuação separada do Cron.
create unique index backup_aparelho_diario on backup_interno.capturas(dono,aparelho_id,dia) where origem='aparelho';

create or replace function public.proxima_captura_backup(conta uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'estado',c.estado,'capturadoEm',c.capturado_em,'dia',c.dia,
    'vinculo',jsonb_build_object('contaId',c.dono,'destino',c.destino)) from backup_interno.capturas c
    where c.dono=conta and c.origem='servidor' and c.estado in ('aguardando','capturada','enviando')
    order by (c.estado='aguardando'),c.tentado_em,c.id limit 1
$$;

create function public.ultimo_backup_confirmado(conta uuid, destino text) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('origem',c.origem,'capturadoEm',c.capturado_em)
    from backup_interno.capturas c where c.dono=conta and c.destino=ultimo_backup_confirmado.destino and c.estado='pronta'
    order by c.capturado_em desc,c.id desc limit 1
$$;

create function public.consultar_backup_aparelho(conta uuid, captura uuid, aparelho uuid, destino text) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('estado',c.estado,'dia',c.dia,'capturadoEm',c.capturado_em,'arquivoId',c.arquivo_id,
    'pastaId',c.pasta_id,'tamanho',c.tamanho::text,'sha256',c.sha256,'sessao',c.sessao)
    from backup_interno.capturas c where c.dono=conta and c.id=captura and c.origem='aparelho'
      and c.aparelho_id=aparelho and c.destino=consultar_backup_aparelho.destino
$$;

create function public.reservar_backup_aparelho(conta uuid, captura uuid, aparelho uuid, destino text, instante timestamptz,
  arquivo text, pasta text, tamanho text, sha256 text, material text[], exclusivos text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c backup_interno.capturas; dia_local date := (instante at time zone 'America/Fortaleza')::date;
begin
  perform estoque_interno.exigir(conta is not null and captura is not null and aparelho is not null and destino ~ '^https?://[^/]+$'
    and dia_local <= (clock_timestamp() at time zone 'America/Fortaleza')::date,'backup_aparelho_invalido');
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into c from backup_interno.capturas b where b.id=captura;
  if not found then
    perform estoque_interno.exigir(exists(select 1 from backup_interno.destinos d where d.dono=conta
      and d.destino=reservar_backup_aparelho.destino and d.pasta_id=pasta),'backup_destino_divergente');
    insert into backup_interno.capturas(id,dono,destino,origem,aparelho_id,dia,capturado_em,estado)
      values(captura,conta,destino,'aparelho',aparelho,dia_local,instante,'capturada');
    perform public.registrar_upload_backup(conta,captura,arquivo,pasta,null,tamanho,sha256,material,exclusivos);
  else
    perform estoque_interno.exigir(c.dono=conta and c.destino=reservar_backup_aparelho.destino and c.origem='aparelho'
      and c.aparelho_id=aparelho and c.capturado_em=instante and c.tamanho::text=tamanho
      and c.sha256=reservar_backup_aparelho.sha256 and c.material=reservar_backup_aparelho.material
      and c.exclusivos=reservar_backup_aparelho.exclusivos and c.estado in ('enviando','pronta','removendo','removida'),
      'backup_upload_divergente');
  end if;
  return public.consultar_backup_aparelho(conta,captura,aparelho,destino);
end $$;

create function public.trocar_sessao_backup_aparelho(conta uuid, captura uuid, aparelho uuid, destino text, anterior text, nova text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform estoque_interno.exigir(nova ~ '^https://www[.]googleapis[.]com/upload/drive/v3/files([/?]|$)','backup_sessao_invalida');
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  -- Se duas aberturas pedirem uma sessão nova, ambas continuam pela vencedora.
  update backup_interno.capturas c set sessao=nova where c.dono=conta and c.id=captura and c.origem='aparelho'
    and c.aparelho_id=aparelho and c.destino=trocar_sessao_backup_aparelho.destino
    and c.estado='enviando' and c.sessao is not distinct from anterior;
  return public.consultar_backup_aparelho(conta,captura,aparelho,destino);
end $$;

revoke all on function public.ultimo_backup_confirmado(uuid,text), public.consultar_backup_aparelho(uuid,uuid,uuid,text),
  public.reservar_backup_aparelho(uuid,uuid,uuid,text,timestamptz,text,text,text,text,text[],text[]),
  public.trocar_sessao_backup_aparelho(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.ultimo_backup_confirmado(uuid,text), public.consultar_backup_aparelho(uuid,uuid,uuid,text),
  public.reservar_backup_aparelho(uuid,uuid,uuid,text,timestamptz,text,text,text,text,text[],text[]),
  public.trocar_sessao_backup_aparelho(uuid,uuid,uuid,text,text,text) to service_role;
