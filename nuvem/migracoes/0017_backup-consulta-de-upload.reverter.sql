-- D-041: restaura a resposta anterior sem mexer nas capturas ou nas permissões.
create or replace function public.consultar_upload_backup(conta uuid, captura uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'estado',c.estado,'arquivoId',c.arquivo_id,'pastaId',c.pasta_id,'sessao',c.sessao,
    'tamanho',c.tamanho::text,'sha256',c.sha256,'material',c.material,'exclusivos',c.exclusivos,'dia',c.dia,'capturadoEm',c.capturado_em)
    from backup_interno.capturas c where c.dono=conta and c.id=captura
$$;
