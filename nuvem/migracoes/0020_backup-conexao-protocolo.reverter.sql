-- D-085: reversão nunca remove cliente, conexão, tentativa ou autorização existente.
do $$ begin
  if exists(select 1 from backup_interno.clientes_web) or exists(select 1 from backup_interno.conexoes_google)
    or exists(select 1 from backup_interno.tentativas_google) then
    raise exception 'Conexão Google existente: preservar catálogo e autorizações.';
  end if;
end $$;
alter table backup_interno.destinos drop constraint destinos_pkey, add primary key(dono);
alter table backup_interno.preparos drop constraint preparos_pkey, add primary key(dono);
alter table backup_interno.lotes_reutilizaveis drop constraint lotes_reutilizaveis_pkey, add primary key(dono);
create or replace function public.capturar_backup_servidor(conta uuid, captura uuid, destino text, agora timestamptz default clock_timestamp()) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c backup_interno.capturas; fontes jsonb; total bigint;
begin
  perform estoque_interno.exigir(conta is not null and captura is not null and destino ~ '^https?://[^/]+$','backup_identidade_invalida');
  -- Mesma ordem da publicação/coleta da 0005: proteger antes de entregar referência ao HTTP.
  perform pg_advisory_xact_lock(22022,hashtext(conta::text));
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into c from backup_interno.capturas b where b.dono=conta and b.dia=(agora at time zone 'America/Fortaleza')::date and b.origem='servidor';
  if not found then
    perform estoque_interno.exigir(not exists(select 1 from backup_interno.capturas where id=captura),'backup_identidade_divergente');
    insert into backup_interno.capturas(id,dono,destino,origem,dia,capturado_em) values
      (captura,conta,destino,'servidor',(agora at time zone 'America/Fortaleza')::date,agora) returning * into c;
  end if;
  perform estoque_interno.exigir(c.destino=capturar_backup_servidor.destino,'backup_destino_divergente');
  update backup_interno.capturas set tentado_em=clock_timestamp() where id=c.id;
  if c.estado='aguardando' then
    fontes := coalesce(c.documento,backup_interno.fontes(conta));
    fontes := jsonb_set(fontes,'{fotos}',backup_interno.completar_fotos(conta,fontes->'fotos'));
    select sum(jsonb_array_length(value)) into total from jsonb_each(fontes);
    perform estoque_interno.exigir(total<=250000 and octet_length(fontes::text)<=67108864,'backup_limite_excedido');
    insert into backup_interno.protecoes(dono,captura_id,copia_id)
      select conta,c.id,cp.id from jsonb_array_elements(fontes->'fotos') f join fotos_interno.copias cp
        on cp.id=(f->>'copiaId')::uuid and cp.dono=conta and cp.estado in ('pendente','disponivel') on conflict do nothing;
    if exists(select 1 from jsonb_array_elements(fontes->'fotos') f where f->>'disponivel' is distinct from 'true') then
      update backup_interno.capturas set documento=fontes,problema='foto_indisponivel' where id=c.id;
      return jsonb_build_object('id',c.id,'estado','aguardando','problema','foto_indisponivel');
    end if;
    update backup_interno.capturas set documento=fontes,estado='capturada',problema=null where id=c.id;
  end if;
  return jsonb_build_object('id',c.id,'estado',case when c.estado='aguardando' then 'capturada' else c.estado end,
    'capturadoEm',c.capturado_em,'dia',c.dia,'vinculo',jsonb_build_object('contaId',c.dono,'destino',c.destino));
end $$;

create or replace function public.ler_captura_backup(conta uuid, captura uuid, tabela text, inicio integer default 0, limite integer default 250) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c backup_interno.capturas; linhas jsonb;
begin
  perform estoque_interno.exigir(tabela in ('clientes','lancamentos','categorias','produtos','estoque','caixa','modelos','identidades','fotos')
    and inicio>=0 and limite between 1 and 250,'backup_pagina_invalida');
  select * into c from backup_interno.capturas b where b.id=captura and b.dono=conta and b.estado in ('capturada','enviando');
  perform estoque_interno.exigir(found and c.documento is not null,'backup_captura_indisponivel');
  select coalesce(jsonb_agg(value order by ord),'[]') into linhas from
    (select value,ord from jsonb_array_elements(c.documento->tabela) with ordinality e(value,ord) order by ord limit ler_captura_backup.limite offset inicio) x;
  return jsonb_build_object('linhas',linhas,'total',jsonb_array_length(c.documento->tabela));
end $$;

create or replace function public.registrar_upload_backup(conta uuid, captura uuid, arquivo text, pasta text, sessao text, tamanho text, sha256 text,
  material text[], exclusivos text[] default '{}') returns void
language plpgsql security definer set search_path='' as $$
declare c backup_interno.capturas;
begin
  perform estoque_interno.exigir(arquivo ~ '^[a-zA-Z0-9_-]{1,200}$' and pasta ~ '^[a-zA-Z0-9_-]{1,200}$'
    and (sessao is null or sessao ~ '^https://www[.]googleapis[.]com/upload/drive/v3/files([/?]|$)')
    and tamanho ~ '^[1-9][0-9]{0,8}$' and tamanho::bigint<=268435456 and sha256 ~ '^[0-9a-f]{64}$'
    and material is not null and exclusivos is not null and material @> exclusivos and cardinality(material)<=250000
    and not exists(select 1 from unnest(material) h where h !~ '^[0-9a-f]{64}$' or h is null),'backup_upload_invalido');
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into c from backup_interno.capturas b where b.id=captura and b.dono=conta;
  perform estoque_interno.exigir(found and c.estado in ('capturada','enviando'),'backup_captura_indisponivel');
  perform estoque_interno.exigir(c.arquivo_id is null or (c.arquivo_id=arquivo and c.pasta_id=pasta and c.tamanho=tamanho::bigint
    and c.sha256=registrar_upload_backup.sha256 and c.material=registrar_upload_backup.material and c.exclusivos=registrar_upload_backup.exclusivos),'backup_upload_divergente');
  update backup_interno.capturas b set estado='enviando',arquivo_id=arquivo,pasta_id=pasta,sessao=registrar_upload_backup.sessao,
    tamanho=registrar_upload_backup.tamanho::bigint,sha256=registrar_upload_backup.sha256,material=registrar_upload_backup.material,
    exclusivos=registrar_upload_backup.exclusivos where b.id=c.id;
end $$;

create or replace function public.consultar_upload_backup(conta uuid, captura uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('estado',c.estado,'arquivoId',c.arquivo_id,'pastaId',c.pasta_id,'sessao',c.sessao,
    'tamanho',c.tamanho::text,'sha256',c.sha256)
    from backup_interno.capturas c where c.dono=conta and c.id=captura
$$;

create or replace function public.confirmar_backup(conta uuid, captura uuid, arquivo text, tamanho text, sha256 text) returns void
language plpgsql security definer set search_path='' as $$
declare c backup_interno.capturas;
begin
  perform pg_advisory_xact_lock(22022,hashtext(conta::text));
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into c from backup_interno.capturas b where b.id=captura and b.dono=conta;
  perform estoque_interno.exigir(found and c.estado in ('enviando','pronta') and c.arquivo_id=arquivo and c.tamanho::text=tamanho
    and c.sha256=confirmar_backup.sha256,'backup_conferencia_divergente');
  update backup_interno.capturas set estado='pronta',confirmado_em=coalesce(confirmado_em,clock_timestamp()),
    sessao=null,documento=null where id=c.id;
  delete from backup_interno.protecoes where dono=conta and captura_id=c.id;
end $$;

create or replace function public.planejar_rotacao_backup(conta uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c backup_interno.capturas; mantidas uuid[] := '{}'; datas date[]; coberta boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select array_agg(dia order by dia desc) into datas from
    (select distinct dia from backup_interno.capturas where dono=conta and estado='pronta' order by dia desc limit 3) x;
  for c in select * from backup_interno.capturas where dono=conta and estado='pronta' order by capturado_em desc,id desc loop
    if c.dia=any(datas) and not exists(select 1 from backup_interno.capturas m where m.id=any(mantidas) and m.dia=c.dia and m.origem=c.origem) then
      mantidas := array_append(mantidas,c.id);
    else
      select exists(select 1 from backup_interno.capturas m where m.id=any(mantidas) and m.material @> c.exclusivos) into coberta;
      if cardinality(c.exclusivos)>0 and not coberta then mantidas := array_append(mantidas,c.id);
      else update backup_interno.capturas set estado='removendo' where id=c.id; end if;
    end if;
  end loop;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'arquivoId',arquivo_id,'pastaId',pasta_id) order by dia,id)
    from backup_interno.capturas where dono=conta and estado='removendo'),'[]');
end $$;

create or replace function public.concluir_rotacao_backup(conta uuid, captura uuid, arquivo text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  perform estoque_interno.exigir(exists(select 1 from backup_interno.capturas where dono=conta and id=captura
    and arquivo_id=arquivo and estado in ('removendo','removida')),'backup_rotacao_nao_autorizada');
  update backup_interno.capturas set estado='removida' where dono=conta and id=captura;
end $$;

create or replace function public.cancelar_captura_backup(conta uuid, captura uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(22022,hashtext(conta::text));
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  perform estoque_interno.exigir(exists(select 1 from backup_interno.capturas where dono=conta and id=captura
    and estado in ('aguardando','capturada','enviando','cancelada')),'backup_cancelamento_invalido');
  update backup_interno.capturas set estado='cancelada',documento=null,sessao=null where dono=conta and id=captura;
  delete from backup_interno.protecoes where dono=conta and captura_id=captura;
end $$;

create or replace function public.proxima_captura_backup(conta uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'estado',c.estado,'capturadoEm',c.capturado_em,'dia',c.dia,
    'vinculo',jsonb_build_object('contaId',c.dono,'destino',c.destino)) from backup_interno.capturas c
    where c.dono=conta and c.origem='servidor' and c.estado in ('aguardando','capturada','enviando')
    order by (c.estado='aguardando'),c.tentado_em,c.id limit 1
$$;

create or replace function public.reservar_pasta_backup(conta uuid, destino text, pasta text) returns text
language plpgsql security definer set search_path='' as $$
declare d backup_interno.destinos;
begin
  perform estoque_interno.exigir(conta is not null and destino ~ '^https?://[^/]+$' and pasta ~ '^[a-zA-Z0-9_-]{1,200}$','backup_destino_invalido');
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  insert into backup_interno.destinos(dono,destino,pasta_id) values(conta,destino,pasta) on conflict do nothing;
  select * into d from backup_interno.destinos where dono=conta;
  perform estoque_interno.exigir(d.destino=reservar_pasta_backup.destino,'backup_destino_divergente');
  return d.pasta_id;
end $$;

create or replace function public.ultimo_backup_confirmado(conta uuid, destino text) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('origem',c.origem,'capturadoEm',c.capturado_em)
    from backup_interno.capturas c where c.dono=conta and c.destino=ultimo_backup_confirmado.destino and c.estado='pronta'
    order by c.capturado_em desc,c.id desc limit 1
$$;

create or replace function public.consultar_backup_aparelho(conta uuid, captura uuid, aparelho uuid, destino text) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('estado',c.estado,'dia',c.dia,'capturadoEm',c.capturado_em,'arquivoId',c.arquivo_id,
    'pastaId',c.pasta_id,'tamanho',c.tamanho::text,'sha256',c.sha256,'sessao',c.sessao)
    from backup_interno.capturas c where c.dono=conta and c.id=captura and c.origem='aparelho'
      and c.aparelho_id=aparelho and c.destino=consultar_backup_aparelho.destino
$$;

create or replace function public.reservar_backup_aparelho(conta uuid, captura uuid, aparelho uuid, destino text, instante timestamptz,
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

create or replace function public.trocar_sessao_backup_aparelho(conta uuid, captura uuid, aparelho uuid, destino text, anterior text, nova text) returns jsonb
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

create or replace function backup_interno.objetos_descartaveis(conta uuid) returns text[]
language sql stable set search_path='' as $$
  select array(select o.caminho from backup_interno.objetos_preparo o where o.dono=conta
    and not exists(select 1 from backup_interno.lotes_reutilizaveis l
      cross join lateral jsonb_array_elements(l.lotes) f
      cross join lateral jsonb_array_elements(f->'lote'->'segmentos') s
      where l.dono=o.dono and s->>'caminho'=o.caminho)
    order by o.caminho limit 32)
$$;

create or replace function public.assumir_preparo_backup(conta uuid,captura uuid,destino text,posse uuid) returns jsonb
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

create or replace function public.reservar_objetos_backup(conta uuid,captura uuid,posse uuid,passo integer,objetos jsonb) returns void
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

create or replace function public.avancar_preparo_backup(conta uuid,captura uuid,posse uuid,passo integer,resultado jsonb,encadear boolean) returns void
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

create or replace function public.soltar_preparo_backup(conta uuid,captura uuid,posse uuid) returns void
language sql security definer set search_path='' as $$
  update backup_interno.preparos b set posse=null,ate=null
    where b.dono=conta and b.captura_id=captura and b.posse=soltar_preparo_backup.posse
$$;

create or replace function public.obter_autorizacao_backup() returns jsonb
language sql stable security definer set search_path='' as $$
  select decrypted_secret::jsonb from vault.decrypted_secrets where name='fichinhas-backup-google-homologacao-v1'
$$;
create or replace function public.obter_autorizacao_backup_producao() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare documento jsonb;
begin
  select decrypted_secret::jsonb into documento from vault.decrypted_secrets where name='fichinhas-backup-google-producao-v1';
  if documento is null then return null; end if;
  perform estoque_interno.exigir(coalesce(documento->>'ambiente'='producao' and
    documento->>'destino'='https://awmesexptpalzonbucwc.supabase.co' and
    documento#>>'{cliente,projetoId}'='fichinhas-backup',false),'backup_autorizacao_divergente');
  return documento;
end $$;
drop function public.rpc_backup_vinculado(uuid,text,jsonb),public.abrir_tentativa_google(uuid,text,text,uuid),
  public.consumir_tentativa_google(text),public.concluir_conexao_google(uuid,uuid,jsonb),
  public.renovar_google_web(uuid,text,text),public.configuracao_google_web(uuid);
drop trigger backup_protecoes_geracao on backup_interno.protecoes;
alter table backup_interno.protecoes drop column geracao;
