-- BA-04/D-084: o catálogo do preparo é privado e separado da confirmação do Drive.
insert into storage.buckets(id,name,public,file_size_limit)
values ('backup-partes','backup-partes',false,4194304);

create table backup_interno.preparos (
  dono uuid primary key,
  captura_id uuid not null,
  versao integer not null default 1 check(versao=1),
  fase text not null default 'dados' check(fase in ('dados','fotos','fechar','enviar','limpar')),
  passo integer not null default 0 check(passo>=0),
  posse uuid,
  ate timestamptz,
  ultima_posse uuid,
  ultimo_resultado bytea,
  plano jsonb,
  material text[] not null default '{}',
  fotos jsonb not null default '[]' check(jsonb_typeof(fotos)='array'),
  indice jsonb,
  enviados bigint not null default 0 check(enviados between 0 and 268435456),
  foreign key(dono,captura_id) references backup_interno.capturas(dono,id),
  check((posse is null)=(ate is null))
);
create table backup_interno.lotes_reutilizaveis (
  dono uuid primary key,
  lotes jsonb not null check(jsonb_typeof(lotes)='array')
);
create table backup_interno.objetos_preparo (
  dono uuid not null,
  captura_id uuid not null,
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer not null check(bytes between 1 and 4194304),
  caminho text generated always as (dono::text||'/'||captura_id::text||'/'||sha256||'.bin') stored,
  primary key(dono,caminho),
  foreign key(dono,captura_id) references backup_interno.capturas(dono,id)
);
create index backup_objetos_captura on backup_interno.objetos_preparo(dono,captura_id);
alter table backup_interno.preparos enable row level security;
alter table backup_interno.lotes_reutilizaveis enable row level security;
alter table backup_interno.objetos_preparo enable row level security;
revoke all on backup_interno.preparos,backup_interno.lotes_reutilizaveis,backup_interno.objetos_preparo
  from public,anon,authenticated,service_role;

-- Só há um preparo ativo por dono. Em limpeza, o conjunto reutilizável já está confirmado.
create function backup_interno.objetos_descartaveis(conta uuid) returns text[]
language sql stable set search_path='' as $$
  select array(select o.caminho from backup_interno.objetos_preparo o where o.dono=conta
    and not exists(select 1 from backup_interno.lotes_reutilizaveis l
      cross join lateral jsonb_array_elements(l.lotes) f
      cross join lateral jsonb_array_elements(f->'lote'->'segmentos') s
      where l.dono=o.dono and s->>'caminho'=o.caminho)
    order by o.caminho limit 32)
$$;

create function public.assumir_preparo_backup(conta uuid,captura uuid,destino text,posse uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p backup_interno.preparos; c backup_interno.capturas; grupo jsonb; reutilizavel jsonb; estado jsonb;
begin
  perform estoque_interno.exigir(conta is not null and captura is not null and posse is not null,'backup_preparo_invalido');
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into p from backup_interno.preparos b where b.dono=conta;
  select * into c from backup_interno.capturas b where b.dono=conta and b.id=coalesce(p.captura_id,captura)
    and b.origem='servidor' and b.destino=assumir_preparo_backup.destino;
  perform estoque_interno.exigir(found,'backup_preparo_conta');
  if p.dono is null then
    -- Reserva prévia continua vinculada ao empacotador que a criou.
    if c.estado<>'capturada' or c.arquivo_id is not null then return jsonb_build_object('modo','legado'); end if;
    insert into backup_interno.preparos(dono,captura_id) values(conta,c.id) returning * into p;
  end if;
  if p.posse is not null and p.ate>clock_timestamp() and p.posse<>assumir_preparo_backup.posse then
    return jsonb_build_object('modo','ocupado','id',c.id);
  end if;
  if c.estado='cancelada' and p.fase<>'limpar' then
    update backup_interno.preparos set fase='limpar',passo=passo+1 where dono=conta returning * into p;
  end if;
  update backup_interno.preparos set posse=assumir_preparo_backup.posse,ate=clock_timestamp()+interval '180 seconds'
    where dono=conta returning * into p;
  estado := jsonb_build_object('modo','preparo','versao',p.versao,'fase',p.fase,'passo',p.passo,
    'captura',jsonb_build_object('id',c.id,'dia',c.dia,'estado',c.estado,'capturadoEm',c.capturado_em,
      'vinculo',jsonb_build_object('contaId',c.dono,'destino',c.destino)));
  case p.fase
    when 'fotos' then
      grupo := p.plano->'grupos'->jsonb_array_length(p.fotos);
      select f->'lote' into reutilizavel from backup_interno.lotes_reutilizaveis l
        cross join lateral jsonb_array_elements(l.lotes) f where l.dono=conta and f->>'chave'=grupo->>'chave';
      estado := estado || jsonb_build_object('grupo',grupo,'reutilizavel',reutilizavel);
    when 'fechar' then
      estado := estado || jsonb_build_object('plano',p.plano-'grupos','fotos',p.fotos,'material',p.material);
    when 'enviar' then
      estado := estado || jsonb_build_object('indice',p.indice,'material',p.material);
    when 'limpar' then estado := estado || jsonb_build_object('apagar',backup_interno.objetos_descartaveis(conta));
    else null;
  end case;
  return estado;
end $$;

create function public.reservar_objetos_backup(conta uuid,captura uuid,posse uuid,passo integer,objetos jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare p backup_interno.preparos; o jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into p from backup_interno.preparos b where b.dono=conta and b.captura_id=captura;
  perform estoque_interno.exigir(found and p.posse=reservar_objetos_backup.posse and p.ate>clock_timestamp()
    and p.passo=reservar_objetos_backup.passo and p.fase in ('dados','fotos','fechar'),'backup_preparo_sem_posse');
  perform estoque_interno.exigir(jsonb_typeof(objetos)='array' and jsonb_array_length(objetos) between 1 and 64,'backup_objetos_invalidos');
  for o in select value from jsonb_array_elements(objetos) loop
    insert into backup_interno.objetos_preparo(dono,captura_id,sha256,bytes)
      values(conta,captura,o->>'sha256',(o->>'bytes')::integer) on conflict do nothing;
    perform estoque_interno.exigir(exists(select 1 from backup_interno.objetos_preparo b where b.dono=conta
      and b.captura_id=captura and b.sha256=o->>'sha256' and b.bytes=(o->>'bytes')::integer),'backup_objeto_divergente');
  end loop;
end $$;

create function public.avancar_preparo_backup(conta uuid,captura uuid,posse uuid,passo integer,resultado jsonb,encadear boolean) returns void
language plpgsql security definer set search_path='' as $$
declare p backup_interno.preparos; c backup_interno.capturas; impressao bytea; manter boolean := false;
  continuar boolean := encadear; apagados text[]; url text; token text;
begin
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into p from backup_interno.preparos b where b.dono=conta and b.captura_id=captura;
  perform estoque_interno.exigir(found and jsonb_typeof(resultado)='object','backup_preparo_indisponivel');
  impressao := sha256(convert_to(resultado::text,'UTF8'));
  if p.passo=avancar_preparo_backup.passo+1 and p.ultima_posse=avancar_preparo_backup.posse and p.ultimo_resultado=impressao then return; end if;
  perform estoque_interno.exigir(p.posse=avancar_preparo_backup.posse and p.ate>clock_timestamp()
    and p.passo=avancar_preparo_backup.passo,'backup_preparo_sem_posse');
  select * into c from backup_interno.capturas b where b.dono=conta and b.id=captura;
  perform estoque_interno.exigir(found and c.origem='servidor' and (c.estado<>'cancelada' or p.fase='limpar'),'backup_preparo_indisponivel');
  case p.fase
    when 'dados' then
      perform estoque_interno.exigir(jsonb_typeof(resultado->'grupos')='array' and jsonb_typeof(resultado->'dados')='array'
        and jsonb_typeof(resultado->'consultas')='array' and jsonb_typeof(resultado->'quantidades')='object'
        and jsonb_typeof(resultado->'material')='array' and jsonb_array_length(resultado->'material')<=250000,'backup_plano_invalido');
      p.plano := resultado-'material';
      p.material := array(select jsonb_array_elements_text(resultado->'material'));
      p.fase := case when jsonb_array_length(p.plano->'grupos')>0 then 'fotos' else 'fechar' end;
    when 'fotos' then
      perform estoque_interno.exigir(resultado->>'chave'=p.plano->'grupos'->jsonb_array_length(p.fotos)->>'chave'
        and jsonb_typeof(resultado->'lote')='object','backup_lote_divergente');
      p.fotos := p.fotos || jsonb_build_array(resultado);
      if jsonb_array_length(p.fotos)=jsonb_array_length(p.plano->'grupos') then p.fase := 'fechar'; end if;
    when 'fechar' then
      perform estoque_interno.exigir(jsonb_typeof(resultado->'indice')='object' and jsonb_typeof(resultado->'material')='array'
        and jsonb_array_length(resultado->'material')<=250000 and resultado->'indice'->>'sha256' ~ '^[0-9a-f]{64}$'
        and (resultado->'indice'->>'tamanho')::bigint between 1 and 268435456,'backup_indice_invalido');
      p.indice := resultado->'indice';
      p.material := array(select jsonb_array_elements_text(resultado->'material'));
      p.fase := 'enviar';
      manter := coalesce(resultado->>'manter'='true',false);
      if manter then continuar := false; end if;
    when 'enviar' then
      if resultado->>'pronta'='true' then
        perform estoque_interno.exigir(c.estado in ('pronta','removendo','removida')
          and c.tamanho::text=p.indice->>'tamanho' and c.sha256=p.indice->>'sha256','backup_sem_conferencia');
        insert into backup_interno.lotes_reutilizaveis(dono,lotes) values(conta,p.fotos)
          on conflict(dono) do update set lotes=excluded.lotes;
        p.fase := 'limpar';
      else
        perform estoque_interno.exigir((resultado->>'enviados')::bigint between 0 and (p.indice->>'tamanho')::bigint,'backup_posicao_invalida');
        continuar := continuar and (resultado->>'enviados')::bigint>p.enviados;
        p.enviados := greatest(p.enviados,(resultado->>'enviados')::bigint);
      end if;
    when 'limpar' then
      apagados := backup_interno.objetos_descartaveis(conta);
      perform estoque_interno.exigir(resultado->'apagados'=to_jsonb(apagados),'backup_limpeza_divergente');
      delete from backup_interno.objetos_preparo where dono=conta and caminho=any(apagados);
      if cardinality(backup_interno.objetos_descartaveis(conta))=0 then
        delete from backup_interno.preparos where dono=conta;
        return;
      end if;
  end case;
  update backup_interno.preparos b set fase=p.fase,passo=p.passo+1,plano=p.plano,material=p.material,
    fotos=p.fotos,indice=p.indice,enviados=p.enviados,ultima_posse=p.posse,ultimo_resultado=impressao,
    posse=case when manter then p.posse end,ate=case when manter then p.ate end where b.dono=conta;
  -- O POST só é entregue após commit; o Cron cobre perda da fila não durável do pg_net.
  if continuar then
    url := case when c.destino='http://127.0.0.1:54321' then 'http://kong:8000' else c.destino end || '/functions/v1/enviar-backup';
    if to_regclass('cron.job') is not null and to_regnamespace('net') is not null then
      if exists(select 1 from cron.job j where j.jobname='fichinhas-backup' and j.active and position(quote_literal(url) in j.command)>0) then
        select decrypted_secret into token from vault.decrypted_secrets where name='fichinhas-backup-servico-v1';
        if token ~ '^[0-9a-f]{64}$' then
          perform net.http_post(url:=url,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),
            body:='{}'::jsonb,timeout_milliseconds:=120000);
        end if;
      end if;
    end if;
  end if;
end $$;

create function public.soltar_preparo_backup(conta uuid,captura uuid,posse uuid) returns void
language sql security definer set search_path='' as $$
  update backup_interno.preparos b set posse=null,ate=null
    where b.dono=conta and b.captura_id=captura and b.posse=soltar_preparo_backup.posse
$$;

revoke all on function public.assumir_preparo_backup(uuid,uuid,text,uuid),
  public.reservar_objetos_backup(uuid,uuid,uuid,integer,jsonb),
  public.avancar_preparo_backup(uuid,uuid,uuid,integer,jsonb,boolean),
  public.soltar_preparo_backup(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.assumir_preparo_backup(uuid,uuid,text,uuid),
  public.reservar_objetos_backup(uuid,uuid,uuid,integer,jsonb),
  public.avancar_preparo_backup(uuid,uuid,uuid,integer,jsonb,boolean),
  public.soltar_preparo_backup(uuid,uuid,uuid) to service_role;
