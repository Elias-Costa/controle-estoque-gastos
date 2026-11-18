-- D-084: a consulta de progresso leva só os campos do transporte. O material segue no catálogo para a retenção.
create or replace function public.consultar_upload_backup(conta uuid, captura uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('estado',c.estado,'arquivoId',c.arquivo_id,'pastaId',c.pasta_id,'sessao',c.sessao,
    'tamanho',c.tamanho::text,'sha256',c.sha256)
    from backup_interno.capturas c where c.dono=conta and c.id=captura
$$;
