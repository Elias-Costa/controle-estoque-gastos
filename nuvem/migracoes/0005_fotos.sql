-- E-22: fotos privadas, publicação e coleta coordenadas (D-025/Q34/35B/41A).
-- D-025/Q34/41: coordenação única por conta; arquivo e metadados têm confirmações separadas.
create schema fotos_interno;
revoke all on schema fotos_interno from public, anon, authenticated;

create table fotos_interno.fotos (
  id uuid primary key,
  dono uuid not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer not null check (bytes between 1 and 204800),
  largura integer not null check (largura between 1 and 1024),
  altura integer not null check (altura between 1 and 1024),
  copia_atual uuid,
  unique(dono,id)
);
create table fotos_interno.copias (
  id uuid primary key,
  dono uuid not null,
  foto_id uuid not null,
  estado text not null default 'pendente' check(estado in ('pendente','disponivel','coleta','removida')),
  caminho text generated always as (dono::text || '/' || foto_id::text || '/' || id::text || '.jpeg') stored unique,
  unique(dono,id),
  foreign key(dono,foto_id) references fotos_interno.fotos(dono,id)
);
alter table fotos_interno.fotos add foreign key(dono,copia_atual) references fotos_interno.copias(dono,id);
create table fotos_interno.protecoes (
  dono uuid not null,
  aparelho_id uuid not null,
  copia_id uuid not null,
  geracao uuid not null,
  liberada boolean not null default false,
  primary key(dono,aparelho_id,copia_id,geracao),
  foreign key(dono,copia_id) references fotos_interno.copias(dono,id)
);
create index protecoes_fotos_ativas on fotos_interno.protecoes(dono,copia_id) where not liberada;

create function fotos_interno.coordenar() returns uuid language plpgsql security definer set search_path='' as $$
declare conta uuid := auth.uid();
begin
  if conta is null then raise exception 'Sessão necessária' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(22022, pg_catalog.hashtext(conta::text));
  return conta;
end $$;

create function fotos_interno.referencia(copia uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('fotoId',f.id,'copiaId',c.id,'sha256',f.sha256,'bytes',f.bytes,
    'largura',f.largura,'altura',f.altura,'caminho',c.caminho,'disponivel',c.estado='disponivel')
  from fotos_interno.copias c join fotos_interno.fotos f on f.id=c.foto_id and f.dono=c.dono where c.id=copia
$$;

create function public.registrar_foto_fila(documento jsonb, aparelho_id uuid, geracao uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); f fotos_interno.fotos; c fotos_interno.copias;
  identidade uuid; copia uuid;
begin
  perform estoque_interno.exigir(aparelho_id is not null and geracao is not null,'foto_identidade_invalida');
  perform estoque_interno.exigir(estoque_interno.uuid_valido(documento->'fotoId')
    and estoque_interno.uuid_valido(documento->'copiaId') and documento->>'sha256' ~ '^[0-9a-f]{64}$'
    and estoque_interno.inteiro(documento->'bytes',1,204800)
    and estoque_interno.inteiro(documento->'largura',1,1024)
    and estoque_interno.inteiro(documento->'altura',1,1024),'foto_metadados_invalidos');
  identidade := (documento->>'fotoId')::uuid; copia := (documento->>'copiaId')::uuid;
  select * into f from fotos_interno.fotos where id=identidade;
  if found then
    perform estoque_interno.exigir(f.dono=conta and f.sha256=documento->>'sha256' and f.bytes=(documento->>'bytes')::integer
      and f.largura=(documento->>'largura')::integer and f.altura=(documento->>'altura')::integer,'foto_conteudo_imutavel');
  else
    insert into fotos_interno.fotos(id,dono,sha256,bytes,largura,altura) values
      (identidade,conta,documento->>'sha256',(documento->>'bytes')::integer,(documento->>'largura')::integer,(documento->>'altura')::integer);
  end if;
  select * into c from fotos_interno.copias where id=copia;
  if found then
    perform estoque_interno.exigir(c.dono=conta and c.foto_id=identidade and c.estado in ('pendente','disponivel'),'foto_caminho_encerrado');
  else
    insert into fotos_interno.copias(id,dono,foto_id) values(copia,conta,identidade);
    update fotos_interno.fotos set copia_atual=copia where id=identidade and (copia_atual is null or not exists
      (select 1 from fotos_interno.copias atual where atual.id=copia_atual and atual.estado in ('pendente','disponivel')));
  end if;
  perform estoque_interno.exigir(not exists(select 1 from fotos_interno.protecoes p where p.dono=conta
    and p.aparelho_id=registrar_foto_fila.aparelho_id and p.copia_id=copia and p.geracao=registrar_foto_fila.geracao and p.liberada),'foto_geracao_encerrada');
  insert into fotos_interno.protecoes(dono,aparelho_id,copia_id,geracao) values(conta,aparelho_id,copia,geracao) on conflict do nothing;
  return fotos_interno.referencia(copia)||jsonb_build_object('aparelhoId',aparelho_id,'geracao',geracao);
end $$;

create function fotos_interno.intencao_produto() returns trigger language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); existente public.produtos;
begin
  perform estoque_interno.exigir(new.dono=conta,'foto_conta_invalida');
  select * into existente from public.produtos where id=new.id;
  -- O LWW existente ainda descarta a escrita antiga; ela não republica arquivo nenhum.
  if found and existente.atualizado_em>new.atualizado_em then return new; end if;
  if new.foto_id is not null then
    perform estoque_interno.exigir(not exists(select 1 from fotos_interno.fotos where id=new.foto_id and dono<>conta),'foto_conta_invalida');
    if exists(select 1 from fotos_interno.fotos where id=new.foto_id and dono=conta) then
      perform estoque_interno.exigir(exists(select 1 from fotos_interno.copias where foto_id=new.foto_id and dono=conta
        and estado in ('pendente','disponivel')),'foto_caminho_encerrado');
    end if;
  end if;
  return new;
end $$;
create trigger produtos_foto_intencao before insert or update on public.produtos for each row execute function fotos_interno.intencao_produto();

create function public.confirmar_arquivo_foto(copia_id uuid, sha256 text, produto_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); c fotos_interno.copias; f fotos_interno.fotos; desfecho text;
begin
  select * into c from fotos_interno.copias where id=copia_id and dono=conta;
  perform estoque_interno.exigir(found and c.estado in ('pendente','disponivel'),'foto_caminho_encerrado');
  select * into f from fotos_interno.fotos where id=c.foto_id and dono=conta;
  perform estoque_interno.exigir(f.sha256=confirmar_arquivo_foto.sha256,'foto_conteudo_divergente');
  -- Hash é conferido pelo cliente lendo bytes do Storage; o banco também exige arquivo/tamanho/MIME.
  perform estoque_interno.exigir(exists(select 1 from storage.objects o where o.bucket_id='fotos-produtos' and o.name=c.caminho
    and (o.metadata->>'size')::bigint=f.bytes and o.metadata->>'mimetype'='image/jpeg'),'foto_arquivo_nao_confirmado');
  update fotos_interno.copias set estado='disponivel' where id=c.id;
  update fotos_interno.fotos set copia_atual=c.id where id=f.id and (copia_atual=c.id or not exists
    (select 1 from fotos_interno.copias atual where atual.id=copia_atual and atual.estado='disponivel'));
  if exists(select 1 from public.produtos p where p.dono=conta and p.foto_id=f.id) then
    -- Só a chegada muda: não gerar carimbo LWW nem recompor campos de uma versão perdedora.
    update public.produtos set recebido_em=clock_timestamp() where dono=conta and foto_id=f.id;
    desfecho := 'publicada';
  elsif exists(select 1 from public.produtos p where p.dono=conta and p.id=produto_id and p.foto_id is distinct from f.id) then
    desfecho := 'superada';
  else desfecho := 'aguardando'; end if;
  return jsonb_build_object('situacao',desfecho);
end $$;

create function public.buscar_produtos_fotos(aparelho_id uuid, geracao uuid, desde timestamptz default null,
  inicio integer default 0, limite integer default 500) returns setof jsonb
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); p public.produtos; c fotos_interno.copias; ref jsonb;
begin
  perform estoque_interno.exigir(aparelho_id is not null and geracao is not null and inicio>=0 and limite between 1 and 500,'foto_pagina_invalida');
  for p in select * from public.produtos where dono=conta and (desde is null or recebido_em>=desde)
    order by recebido_em,id limit buscar_produtos_fotos.limite offset inicio loop
    ref := null;
    if p.foto_id is not null then
      select cp.* into c from fotos_interno.fotos f join fotos_interno.copias cp on cp.id=f.copia_atual and cp.dono=f.dono
        where f.id=p.foto_id and f.dono=conta and cp.estado in ('pendente','disponivel');
      if found then
        perform estoque_interno.exigir(not exists(select 1 from fotos_interno.protecoes pr where pr.dono=conta
          and pr.aparelho_id=buscar_produtos_fotos.aparelho_id and pr.copia_id=c.id and pr.geracao=buscar_produtos_fotos.geracao and pr.liberada),'foto_geracao_encerrada');
        insert into fotos_interno.protecoes(dono,aparelho_id,copia_id,geracao) values(conta,aparelho_id,c.id,geracao) on conflict do nothing;
        ref := fotos_interno.referencia(c.id)||jsonb_build_object('aparelhoId',aparelho_id,'geracao',geracao);
      end if;
    end if;
    return next to_jsonb(p)||jsonb_build_object('custo_manual',p.custo_manual::text,'preco_venda',p.preco_venda::text,'foto_referencia',ref);
  end loop;
end $$;

create function public.listar_protecoes_fotos(aparelho_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); resultado jsonb;
begin
  select coalesce(jsonb_agg(fotos_interno.referencia(p.copia_id)||jsonb_build_object('aparelhoId',p.aparelho_id,'geracao',p.geracao)), '[]')
    into resultado from fotos_interno.protecoes p where p.dono=conta and p.aparelho_id=listar_protecoes_fotos.aparelho_id and not p.liberada;
  return resultado;
end $$;

create function public.liberar_protecao_foto(aparelho_id uuid, copia_id uuid, geracao uuid) returns void
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar();
begin
  update fotos_interno.protecoes p set liberada=true where p.dono=conta and p.aparelho_id=liberar_protecao_foto.aparelho_id
    and p.copia_id=liberar_protecao_foto.copia_id and p.geracao=liberar_protecao_foto.geracao;
end $$;

create function public.autorizar_coleta_fotos(limite integer default 20) returns jsonb
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); resultado jsonb;
begin
  perform estoque_interno.exigir(limite between 1 and 100,'foto_coleta_limite_invalido');
  update fotos_interno.copias c set estado='coleta' where c.dono=conta and c.estado='disponivel'
    and not exists(select 1 from fotos_interno.protecoes p where p.dono=conta and p.copia_id=c.id and not p.liberada)
    and not exists(select 1 from public.produtos p join fotos_interno.fotos f on f.id=p.foto_id and f.dono=p.dono
      where p.dono=conta and f.copia_atual=c.id);
  select coalesce(jsonb_agg(item), '[]') into resultado from
    (select jsonb_build_object('copiaId',id,'caminho',caminho) item from fotos_interno.copias
      where dono=conta and estado='coleta' order by id limit autorizar_coleta_fotos.limite) tarefas;
  return resultado;
end $$;

create function public.confirmar_coleta_foto(copia_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); c fotos_interno.copias;
begin
  select * into c from fotos_interno.copias where id=copia_id and dono=conta;
  perform estoque_interno.exigir(found and c.estado in ('coleta','removida'),'foto_coleta_nao_autorizada');
  perform estoque_interno.exigir(not exists(select 1 from storage.objects where bucket_id='fotos-produtos' and name=c.caminho),'foto_arquivo_ainda_existe');
  update fotos_interno.copias set estado='removida' where id=c.id;
end $$;

-- RLS de bytes usa a mesma coordenação de publicação/proteções/coleta, não apenas prefixo de pasta.
create function public.permitir_objeto_foto(caminho text, acao text) returns boolean
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); c fotos_interno.copias;
begin
  select * into c from fotos_interno.copias where dono=conta and copias.caminho=permitir_objeto_foto.caminho;
  if not found then return false; end if;
  if acao='inserir' then return c.estado='pendente'; end if;
  if acao='ler' then return c.estado<>'removida'; end if;
  if acao='apagar' then return c.estado='coleta'
    and not exists(select 1 from fotos_interno.protecoes p where p.dono=conta and p.copia_id=c.id and not p.liberada); end if;
  return false;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('fotos-produtos','fotos-produtos',false,204800,array['image/jpeg']) on conflict(id) do nothing;
do $$ begin
  perform estoque_interno.exigir(exists(select 1 from storage.buckets where id='fotos-produtos' and not public
    and file_size_limit=204800 and allowed_mime_types=array['image/jpeg']),'foto_bucket_incompativel');
end $$;
create policy fotos_objetos_inserir on storage.objects for insert to authenticated
  with check(bucket_id='fotos-produtos' and public.permitir_objeto_foto(name,'inserir'));
create policy fotos_objetos_ler on storage.objects for select to authenticated
  using(bucket_id='fotos-produtos' and public.permitir_objeto_foto(name,'ler'));
create policy fotos_objetos_apagar on storage.objects for delete to authenticated
  using(bucket_id='fotos-produtos' and public.permitir_objeto_foto(name,'apagar'));

revoke all on all tables in schema fotos_interno from public, anon, authenticated;
revoke all on all functions in schema fotos_interno from public, anon, authenticated;
revoke all on function public.registrar_foto_fila(jsonb,uuid,uuid), public.confirmar_arquivo_foto(uuid,text,uuid),
  public.buscar_produtos_fotos(uuid,uuid,timestamptz,integer,integer), public.listar_protecoes_fotos(uuid),
  public.liberar_protecao_foto(uuid,uuid,uuid), public.autorizar_coleta_fotos(integer),
  public.confirmar_coleta_foto(uuid), public.permitir_objeto_foto(text,text) from public,anon;
grant execute on function public.registrar_foto_fila(jsonb,uuid,uuid), public.confirmar_arquivo_foto(uuid,text,uuid),
  public.buscar_produtos_fotos(uuid,uuid,timestamptz,integer,integer), public.listar_protecoes_fotos(uuid),
  public.liberar_protecao_foto(uuid,uuid,uuid), public.autorizar_coleta_fotos(integer),
  public.confirmar_coleta_foto(uuid), public.permitir_objeto_foto(text,text) to authenticated;
