-- BA-02 / D-084: captura consistente retida, fotos protegidas e catálogo privado do Drive.
create schema backup_interno;
revoke all on schema backup_interno from public, anon, authenticated, service_role;

create table backup_interno.capturas (
  id uuid primary key,
  dono uuid not null,
  destino text not null,
  origem text not null check(origem in ('servidor','aparelho')),
  aparelho_id uuid,
  dia date not null,
  capturado_em timestamptz not null,
  estado text not null default 'aguardando' check(estado in ('aguardando','capturada','enviando','pronta','cancelada','removendo','removida')),
  documento jsonb,
  arquivo_id text,
  pasta_id text,
  sessao text,
  tamanho bigint check(tamanho between 1 and 268435456),
  sha256 text check(sha256 ~ '^[0-9a-f]{64}$'),
  material text[] not null default '{}',
  exclusivos text[] not null default '{}',
  confirmado_em timestamptz,
  tentado_em timestamptz not null default clock_timestamp(),
  problema text,
  constraint backup_origem check((origem='aparelho')=(aparelho_id is not null)),
  constraint backup_dia check(dia=(capturado_em at time zone 'America/Fortaleza')::date),
  constraint backup_material check(material @> exclusivos),
  constraint backup_pronto check(estado not in ('pronta','removendo','removida') or
    (arquivo_id is not null and pasta_id is not null and tamanho is not null and sha256 is not null and confirmado_em is not null)),
  unique(dono,id)
);
create unique index backup_servidor_diario on backup_interno.capturas(dono,dia) where origem='servidor';
create index backup_retencao on backup_interno.capturas(dono,dia desc,capturado_em desc);
create table backup_interno.destinos (
  dono uuid primary key,
  destino text not null,
  pasta_id text not null check(pasta_id ~ '^[a-zA-Z0-9_-]{1,200}$')
);
create table backup_interno.protecoes (
  dono uuid not null,
  captura_id uuid not null,
  copia_id uuid not null,
  primary key(dono,captura_id,copia_id),
  foreign key(dono,captura_id) references backup_interno.capturas(dono,id),
  foreign key(dono,copia_id) references fotos_interno.copias(dono,id)
);
create index backup_protecoes_copia on backup_interno.protecoes(dono,copia_id);
alter table backup_interno.capturas enable row level security;
alter table backup_interno.protecoes enable row level security;
alter table backup_interno.destinos enable row level security;
revoke all on all tables in schema backup_interno from public, anon, authenticated, service_role;

-- EL-03: dinheiro numérico legado dentro de JSON também vira texto ANTES de sair do Postgres.
create function backup_interno.dinheiro_textual(v jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare r jsonb; k text; item jsonb;
begin
  if jsonb_typeof(v)='object' then
    r := '{}';
    for k,item in select key,value from jsonb_each(v) loop
      r := r || jsonb_build_object(k,case when k in ('valor','preco','desconto','precoUnitario','custoUnitario','ordemCadastro','custo_manual','preco_venda')
        and jsonb_typeof(item)='number' then to_jsonb(item#>>'{}') else backup_interno.dinheiro_textual(item) end);
    end loop;
    return r;
  elsif jsonb_typeof(v)='array' then
    select coalesce(jsonb_agg(backup_interno.dinheiro_textual(value) order by ord),'[]') into r
      from jsonb_array_elements(v) with ordinality a(value,ord);
    return r;
  end if;
  return v;
end $$;

-- Função STABLE é uma única instrução de captura: todas as fontes usam a mesma visão MVCC.
create function backup_interno.fontes(conta uuid) returns jsonb
language sql stable set search_path='' as $$
select backup_interno.dinheiro_textual(jsonb_build_object(
  'clientes',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'nome',c.nome,'telefone',c.telefone,
    'apelido',c.apelido,'observacao',c.observacao,'desativado_em',c.desativado_em,'atualizado_em',c.atualizado_em) order by c.id)
    from public.clientes c where c.dono=conta),'[]'),
  'lancamentos',coalesce((select jsonb_agg(estoque_interno.lancamento_json(l) order by l.id) from public.lancamentos l where l.dono=conta),'[]'),
  'categorias',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'nome',c.nome) order by c.id) from public.categorias c where c.dono=conta),'[]'),
  'produtos',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'nome',p.nome,'categoria_id',p.categoria_id,'marca',p.marca,
    'classificacao',p.classificacao,'codigo_catalogo',p.codigo_catalogo,'foto_id',p.foto_id,'custo_manual',p.custo_manual::text,
    'preco_venda',p.preco_venda::text,'estoque_minimo',p.estoque_minimo,'atualizado_em',p.atualizado_em) order by p.id)
    from public.produtos p where p.dono=conta),'[]'),
  'estoque',coalesce((select jsonb_agg(x.registro order by x.recepcao) from (
    select o.recepcao,jsonb_build_object('recepcao',o.recepcao::text,'tipo','operacao','grupo',estoque_interno.grupo_json(o),
      'evidencias',o.evidencias,'encerramentoId',o.encerramento_id) registro from public.operacoes_estoque o where o.dono=conta
    union all select e.recepcao,jsonb_build_object('recepcao',e.recepcao::text,'tipo','encerramento','encerramento',estoque_interno.encerramento_json(e))
      from public.encerramentos_estoque e where e.dono=conta) x),'[]'),
  'caixa',coalesce((select jsonb_agg(jsonb_build_object('recepcao',o.recepcao::text,'grupo',caixa_interno.grupo_json(o)) order by o.recepcao)
    from public.operacoes_caixa o where o.dono=conta),'[]'),
  'modelos',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'chave',m.chave,'modelos',m.modelos,'atualizado_em',m.atualizado_em))
    from public.modelos_whatsapp m where m.dono=conta),'[]'),
  'identidades',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'chave',i.chave,'identidade',i.identidade,'atualizado_em',i.atualizado_em))
    from public.identidades_loja i where i.dono=conta),'[]'),
  'fotos',coalesce((select jsonb_agg(r order by foto) from (
    select distinct on(p.foto_id) p.foto_id foto,jsonb_build_object('fotoId',p.foto_id,'produtoId',p.id,'cadastroEm',p.atualizado_em,
      'copiaId',c.id,'sha256',f.sha256,'bytes',f.bytes,'largura',f.largura,'altura',f.altura,'caminho',c.caminho,
      'disponivel',coalesce(c.estado='disponivel' and exists(select 1 from storage.objects o where o.bucket_id='fotos-produtos'
        and o.name=c.caminho and (o.metadata->>'size')::bigint=f.bytes and o.metadata->>'mimetype'='image/jpeg'),false)) r
      from public.produtos p left join fotos_interno.fotos f on f.dono=p.dono and f.id=p.foto_id
      left join fotos_interno.copias c on c.dono=f.dono and c.id=f.copia_atual
      where p.dono=conta and p.foto_id is not null order by p.foto_id,p.id) fotos),'[]')
))
$$;

-- Foto lógica é imutável na 0005: completar os bytes recebidos depois não relê cadastro/financeiro.
create function backup_interno.completar_fotos(conta uuid, referencias jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare r jsonb; resultado jsonb := '[]'; f fotos_interno.fotos; c fotos_interno.copias;
begin
  for r in select value from jsonb_array_elements(referencias) loop
    if r->>'disponivel' is distinct from 'true' then
      select * into f from fotos_interno.fotos where dono=conta and id=(r->>'fotoId')::uuid;
      if found then
        select * into c from fotos_interno.copias where dono=conta and foto_id=f.id and estado in ('pendente','disponivel')
          order by (estado='disponivel') desc,(id=(r->>'copiaId')::uuid) desc nulls last,id limit 1;
        if found then
          r := r || jsonb_build_object('copiaId',c.id,'sha256',f.sha256,'bytes',f.bytes,'largura',f.largura,'altura',f.altura,'caminho',c.caminho,
            'disponivel',c.estado='disponivel' and exists(select 1 from storage.objects o where o.bucket_id='fotos-produtos' and o.name=c.caminho
              and (o.metadata->>'size')::bigint=f.bytes and o.metadata->>'mimetype'='image/jpeg'));
        end if;
      end if;
    end if;
    resultado := resultado || jsonb_build_array(r);
  end loop;
  return resultado;
end $$;

create function public.capturar_backup_servidor(conta uuid, captura uuid, destino text, agora timestamptz default clock_timestamp()) returns jsonb
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

create function public.ler_captura_backup(conta uuid, captura uuid, tabela text, inicio integer default 0, limite integer default 250) returns jsonb
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

create function public.registrar_upload_backup(conta uuid, captura uuid, arquivo text, pasta text, sessao text, tamanho text, sha256 text,
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

create function public.consultar_upload_backup(conta uuid, captura uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'estado',c.estado,'arquivoId',c.arquivo_id,'pastaId',c.pasta_id,'sessao',c.sessao,
    'tamanho',c.tamanho::text,'sha256',c.sha256,'material',c.material,'exclusivos',c.exclusivos,'dia',c.dia,'capturadoEm',c.capturado_em)
    from backup_interno.capturas c where c.dono=conta and c.id=captura
$$;

create function public.confirmar_backup(conta uuid, captura uuid, arquivo text, tamanho text, sha256 text) returns void
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

-- O plano conserva três datas e a versão mais nova por origem/dia. Protegidas extras
-- são avaliadas da mais nova para a antiga, sem cobertura circular entre arquivos a remover.
create function public.planejar_rotacao_backup(conta uuid) returns jsonb
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

create function public.concluir_rotacao_backup(conta uuid, captura uuid, arquivo text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  perform estoque_interno.exigir(exists(select 1 from backup_interno.capturas where dono=conta and id=captura
    and arquivo_id=arquivo and estado in ('removendo','removida')),'backup_rotacao_nao_autorizada');
  update backup_interno.capturas set estado='removida' where dono=conta and id=captura;
end $$;

create function public.cancelar_captura_backup(conta uuid, captura uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(22022,hashtext(conta::text));
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  perform estoque_interno.exigir(exists(select 1 from backup_interno.capturas where dono=conta and id=captura
    and estado in ('aguardando','capturada','enviando','cancelada')),'backup_cancelamento_invalido');
  update backup_interno.capturas set estado='cancelada',documento=null,sessao=null where dono=conta and id=captura;
  delete from backup_interno.protecoes where dono=conta and captura_id=captura;
end $$;

create function public.proxima_captura_backup(conta uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'estado',c.estado,'capturadoEm',c.capturado_em,'dia',c.dia,
    'vinculo',jsonb_build_object('contaId',c.dono,'destino',c.destino)) from backup_interno.capturas c
    where c.dono=conta and c.estado in ('aguardando','capturada','enviando')
    order by (c.estado='aguardando'),c.tentado_em,c.id limit 1
$$;

create function public.reservar_pasta_backup(conta uuid, destino text, pasta text) returns text
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

-- Credencial completa só é entregue ao papel servidor do Edge, nunca a authenticated/anon.
create function public.obter_autorizacao_backup() returns jsonb
language sql stable security definer set search_path='' as $$
  select decrypted_secret::jsonb from vault.decrypted_secrets where name='fichinhas-backup-google-homologacao-v1'
$$;
create function public.atualizar_renovacao_backup(conta uuid, anterior text, renovacao text) returns void
language plpgsql security definer set search_path='' as $$
declare segredo uuid; documento jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('fichinhas-backup-google-homologacao-v1',2));
  select id,decrypted_secret::jsonb into segredo,documento from vault.decrypted_secrets where name='fichinhas-backup-google-homologacao-v1';
  perform estoque_interno.exigir(segredo is not null and documento->>'contaId'=conta::text and
    (documento->>'renovacao'=anterior or documento->>'renovacao'=renovacao) and length(renovacao) between 1 and 4096,'backup_autorizacao_divergente');
  perform vault.update_secret(segredo,jsonb_set(documento,'{renovacao}',to_jsonb(renovacao))::text);
end $$;

create or replace function public.autorizar_coleta_fotos(limite integer default 20) returns jsonb
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); resultado jsonb;
begin
  perform estoque_interno.exigir(limite between 1 and 100,'foto_coleta_limite_invalido');
  update fotos_interno.copias c set estado='coleta' where c.dono=conta and c.estado='disponivel'
    and not exists(select 1 from fotos_interno.protecoes p where p.dono=conta and p.copia_id=c.id and not p.liberada)
    and not exists(select 1 from backup_interno.protecoes p where p.dono=conta and p.copia_id=c.id)
    and not exists(select 1 from public.produtos p join fotos_interno.fotos f on f.id=p.foto_id and f.dono=p.dono where p.dono=conta and f.copia_atual=c.id);
  select coalesce(jsonb_agg(item),'[]') into resultado from
    (select jsonb_build_object('copiaId',id,'caminho',caminho) item from fotos_interno.copias where dono=conta and estado='coleta'
      and not exists(select 1 from backup_interno.protecoes p where p.dono=conta and p.copia_id=copias.id)
      order by id limit autorizar_coleta_fotos.limite) tarefas;
  return resultado;
end $$;

create or replace function public.permitir_objeto_foto(caminho text, acao text) returns boolean
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); c fotos_interno.copias;
begin
  select * into c from fotos_interno.copias where dono=conta and copias.caminho=permitir_objeto_foto.caminho;
  if not found then return false; end if;
  if acao='inserir' then return c.estado='pendente'; end if;
  if acao='ler' then return c.estado<>'removida'; end if;
  if acao='apagar' then return c.estado='coleta'
    and not exists(select 1 from fotos_interno.protecoes p where p.dono=conta and p.copia_id=c.id and not p.liberada)
    and not exists(select 1 from backup_interno.protecoes p where p.dono=conta and p.copia_id=c.id); end if;
  return false;
end $$;

revoke all on all functions in schema backup_interno from public,anon,authenticated,service_role;
revoke all on function public.capturar_backup_servidor(uuid,uuid,text,timestamptz),public.ler_captura_backup(uuid,uuid,text,integer,integer),
  public.registrar_upload_backup(uuid,uuid,text,text,text,text,text,text[],text[]),public.consultar_upload_backup(uuid,uuid),
  public.confirmar_backup(uuid,uuid,text,text,text),public.planejar_rotacao_backup(uuid),public.concluir_rotacao_backup(uuid,uuid,text),
  public.cancelar_captura_backup(uuid,uuid),public.proxima_captura_backup(uuid),public.reservar_pasta_backup(uuid,text,text),
  public.obter_autorizacao_backup(),public.atualizar_renovacao_backup(uuid,text,text) from public,anon,authenticated;
grant execute on function public.capturar_backup_servidor(uuid,uuid,text,timestamptz),public.ler_captura_backup(uuid,uuid,text,integer,integer),
  public.registrar_upload_backup(uuid,uuid,text,text,text,text,text,text[],text[]),public.consultar_upload_backup(uuid,uuid),
  public.confirmar_backup(uuid,uuid,text,text,text),public.planejar_rotacao_backup(uuid),public.concluir_rotacao_backup(uuid,uuid,text),
  public.cancelar_captura_backup(uuid,uuid),public.proxima_captura_backup(uuid),public.reservar_pasta_backup(uuid,text,text),
  public.obter_autorizacao_backup(),public.atualizar_renovacao_backup(uuid,text,text) to service_role;
