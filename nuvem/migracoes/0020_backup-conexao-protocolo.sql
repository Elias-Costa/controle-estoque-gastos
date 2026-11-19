-- D-085: OAuth Web e catálogo por conexão; preserva arquivos e autorizações anteriores.
alter table backup_interno.protecoes add column geracao uuid not null default '00000000-0000-0000-0000-000000000000';
-- Reaplicar após reversão parcial restaura as chaves compostas da estrutura 0019.
alter table backup_interno.destinos drop constraint destinos_pkey, add primary key(dono,geracao);
alter table backup_interno.preparos drop constraint preparos_pkey, add primary key(dono,geracao);
alter table backup_interno.lotes_reutilizaveis drop constraint lotes_reutilizaveis_pkey, add primary key(dono,geracao);
create trigger backup_protecoes_geracao before insert on backup_interno.protecoes for each row execute function backup_interno.marcar_geracao();

create function public.configuracao_google_web(conta uuid) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('ambiente',w.ambiente,'destino',w.destino,'retorno',w.retorno,
    'cliente',s.decrypted_secret::jsonb,'anterior',c.id,'email',c.email,'googleId',c.google_id,'conectadoEm',c.criada_em)
  from backup_interno.clientes_web w join vault.decrypted_secrets s on s.id=w.segredo_id
  left join backup_interno.conexoes_google c on c.dono=w.dono and c.ativa
  where w.dono=conta
$$;

create function public.abrir_tentativa_google(conta uuid,estado_hash text,verificador text,anterior uuid) returns void
language plpgsql security definer set search_path='' as $$
declare ambiente text; atual uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(conta::text,86));
  select w.ambiente into ambiente from backup_interno.clientes_web w where w.dono=conta;
  select c.id into atual from backup_interno.conexoes_google c where c.dono=conta and c.ativa;
  perform estoque_interno.exigir(ambiente is not null and atual is not distinct from anterior
    and estado_hash ~ '^[a-f0-9]{64}$' and verificador ~ '^[A-Za-z0-9_-]{43}$','backup_tentativa_invalida');
  perform estoque_interno.exigir((select count(*) from backup_interno.tentativas_google t
    where t.dono=conta and t.ate>clock_timestamp())<5,'backup_tentativas_excedidas');
  insert into backup_interno.tentativas_google(estado_hash,dono,ambiente,verificador,anterior)
    values(estado_hash,conta,ambiente,verificador,anterior);
end $$;

create function public.consumir_tentativa_google(impressao text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t backup_interno.tentativas_google;
begin
  select * into t from backup_interno.tentativas_google where estado_hash=impressao for update;
  perform estoque_interno.exigir(found and not t.usada and t.ate>clock_timestamp(),'backup_tentativa_expirada');
  update backup_interno.tentativas_google set usada=true,verificador=null where estado_hash=impressao;
  return public.configuracao_google_web(t.dono) || jsonb_build_object('conta',t.dono,'anterior',t.anterior,'verificador',t.verificador);
end $$;

create function public.concluir_conexao_google(conta uuid,anterior uuid,documento jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare w backup_interno.clientes_web; ativa backup_interno.conexoes_google;
  segredo uuid; novo uuid := (documento->>'vinculoId')::uuid; cliente jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(conta::text,85));
  select * into w from backup_interno.clientes_web where dono=conta;
  select * into ativa from backup_interno.conexoes_google c where c.dono=conta and c.ativa;
  select decrypted_secret::jsonb into cliente from vault.decrypted_secrets where id=w.segredo_id;
  perform estoque_interno.exigir(w.dono is not null and ativa.id is not distinct from anterior
    and documento->>'formato'='2' and documento->>'contaId'=conta::text
    and documento->>'ambiente'=w.ambiente and documento->>'destino'=w.destino
    and documento->'cliente'=cliente and length(documento->>'renovacao') between 1 and 4096
    and length(documento->>'contaGoogleId') between 1 and 256 and documento->>'contaGoogleId' ~ '^[a-zA-Z0-9_-]+$'
    and length(documento->>'emailGoogle') between 3 and 320 and novo is not null,'backup_conexao_divergente');
  if novo=ativa.id then
    perform estoque_interno.exigir(ativa.google_id=documento->>'contaGoogleId','backup_conexao_divergente');
    perform vault.update_secret(ativa.segredo_id,documento::text);
    update backup_interno.conexoes_google set email=documento->>'emailGoogle' where id=novo;
  else
    select vault.create_secret(documento::text,'fichinhas-backup-google-app:'||novo::text) into segredo;
    update backup_interno.conexoes_google set ativa=false where dono=conta;
    insert into backup_interno.conexoes_google(id,dono,ambiente,email,google_id,segredo_id)
      values(novo,conta,w.ambiente,documento->>'emailGoogle',documento->>'contaGoogleId',segredo);
  end if;
end $$;

create function public.renovar_google_web(vinculo uuid,anterior text,renovacao text) returns void
language plpgsql security definer set search_path='' as $$
declare c backup_interno.conexoes_google; documento jsonb;
begin
  select * into c from backup_interno.conexoes_google where id=vinculo;
  perform set_config('fichinhas.backup_geracao',vinculo::text,true);
  perform estoque_interno.exigir(vinculo=backup_interno.geracao_atual(c.dono),'backup_conexao_alterada');
  perform pg_advisory_xact_lock(hashtextextended(vinculo::text,2));
  select decrypted_secret::jsonb into documento from vault.decrypted_secrets where id=c.segredo_id;
  perform estoque_interno.exigir((documento->>'renovacao'=anterior or documento->>'renovacao'=renovacao)
    and length(renovacao) between 1 and 4096,'backup_autorizacao_divergente');
  perform vault.update_secret(c.segredo_id,jsonb_set(documento,'{renovacao}',to_jsonb(renovacao))::text);
end $$;

create or replace function public.obter_autorizacao_backup() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce((select s.decrypted_secret::jsonb from backup_interno.conexoes_google c
    join vault.decrypted_secrets s on s.id=c.segredo_id where c.ativa and c.ambiente in ('local','homologacao')),
    (select decrypted_secret::jsonb from vault.decrypted_secrets where name='fichinhas-backup-google-homologacao-v1'))
$$;
create or replace function public.obter_autorizacao_backup_producao() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare documento jsonb;
begin
  select coalesce((select s.decrypted_secret::jsonb from backup_interno.conexoes_google c
    join vault.decrypted_secrets s on s.id=c.segredo_id where c.ativa and c.ambiente='producao'),
    (select decrypted_secret::jsonb from vault.decrypted_secrets where name='fichinhas-backup-google-producao-v1')) into documento;
  if documento is not null then
    perform estoque_interno.exigir(documento->>'ambiente'='producao'
      and documento->>'destino'='https://awmesexptpalzonbucwc.supabase.co'
      and documento->'cliente'->>'projetoId'='fichinhas-backup','backup_autorizacao_divergente');
  end if;
  return documento;
end $$;

revoke all on function public.configuracao_google_web(uuid),public.abrir_tentativa_google(uuid,text,text,uuid),
  public.consumir_tentativa_google(text),public.concluir_conexao_google(uuid,uuid,jsonb),public.renovar_google_web(uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.configuracao_google_web(uuid),public.abrir_tentativa_google(uuid,text,text,uuid),
  public.consumir_tentativa_google(text),public.concluir_conexao_google(uuid,uuid,jsonb),public.renovar_google_web(uuid,text,text)
  to service_role;

create or replace function public.capturar_backup_servidor(conta uuid, captura uuid, destino text, agora timestamptz default clock_timestamp()) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c backup_interno.capturas; fontes jsonb; total bigint;
begin
  perform backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(conta is not null and captura is not null and destino ~ '^https?://[^/]+$','backup_identidade_invalida');
  -- Mesma ordem da publicação/coleta da 0005: proteger antes de entregar referência ao HTTP.
  perform pg_advisory_xact_lock(22022,hashtext(conta::text));
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into c from backup_interno.capturas b where b.dono=conta and b.geracao=backup_interno.geracao_atual(conta) and b.dia=(agora at time zone 'America/Fortaleza')::date and b.origem='servidor';
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
language plpgsql security definer set search_path='' as $$
declare c backup_interno.capturas; linhas jsonb;
begin
  perform backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(tabela in ('clientes','lancamentos','categorias','produtos','estoque','caixa','modelos','identidades','fotos')
    and inicio>=0 and limite between 1 and 250,'backup_pagina_invalida');
  select * into c from backup_interno.capturas b where b.id=captura and b.dono=conta and b.geracao=backup_interno.geracao_atual(conta) and b.estado in ('capturada','enviando');
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
  perform backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(arquivo ~ '^[a-zA-Z0-9_-]{1,200}$' and pasta ~ '^[a-zA-Z0-9_-]{1,200}$'
    and (sessao is null or sessao ~ '^https://www[.]googleapis[.]com/upload/drive/v3/files([/?]|$)')
    and tamanho ~ '^[1-9][0-9]{0,8}$' and tamanho::bigint<=268435456 and sha256 ~ '^[0-9a-f]{64}$'
    and material is not null and exclusivos is not null and material @> exclusivos and cardinality(material)<=250000
    and not exists(select 1 from unnest(material) h where h !~ '^[0-9a-f]{64}$' or h is null),'backup_upload_invalido');
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into c from backup_interno.capturas b where b.id=captura and b.dono=conta and b.geracao=backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(found and c.estado in ('capturada','enviando'),'backup_captura_indisponivel');
  perform estoque_interno.exigir(c.arquivo_id is null or (c.arquivo_id=arquivo and c.pasta_id=pasta and c.tamanho=tamanho::bigint
    and c.sha256=registrar_upload_backup.sha256 and c.material=registrar_upload_backup.material and c.exclusivos=registrar_upload_backup.exclusivos),'backup_upload_divergente');
  update backup_interno.capturas b set estado='enviando',arquivo_id=arquivo,pasta_id=pasta,sessao=registrar_upload_backup.sessao,
    tamanho=registrar_upload_backup.tamanho::bigint,sha256=registrar_upload_backup.sha256,material=registrar_upload_backup.material,
    exclusivos=registrar_upload_backup.exclusivos where b.id=c.id;
end $$;

create or replace function public.consultar_upload_backup(conta uuid, captura uuid) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('estado',c.estado,'arquivoId',c.arquivo_id,'pastaId',c.pasta_id,'sessao',c.sessao,
    'tamanho',c.tamanho::text,'sha256',c.sha256)
    from backup_interno.capturas c where c.dono=conta and c.geracao=backup_interno.geracao_atual(conta) and c.id=captura
$$;

create or replace function public.confirmar_backup(conta uuid, captura uuid, arquivo text, tamanho text, sha256 text) returns void
language plpgsql security definer set search_path='' as $$
declare c backup_interno.capturas;
begin
  perform backup_interno.geracao_atual(conta);
  perform pg_advisory_xact_lock(22022,hashtext(conta::text));
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into c from backup_interno.capturas b where b.id=captura and b.dono=conta and b.geracao=backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(found and c.estado in ('enviando','pronta') and c.arquivo_id=arquivo and c.tamanho::text=tamanho
    and c.sha256=confirmar_backup.sha256,'backup_conferencia_divergente');
  update backup_interno.capturas set estado='pronta',confirmado_em=coalesce(confirmado_em,clock_timestamp()),
    sessao=null,documento=null where id=c.id;
  delete from backup_interno.protecoes where dono=conta and geracao=backup_interno.geracao_atual(conta) and captura_id=c.id;
end $$;

create or replace function public.planejar_rotacao_backup(conta uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c backup_interno.capturas; mantidas uuid[] := '{}'; datas date[]; coberta boolean;
begin
  perform backup_interno.geracao_atual(conta);
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select array_agg(dia order by dia desc) into datas from
    (select distinct dia from backup_interno.capturas where dono=conta and geracao=backup_interno.geracao_atual(conta) and estado='pronta' order by dia desc limit 3) x;
  for c in select * from backup_interno.capturas where dono=conta and geracao=backup_interno.geracao_atual(conta) and estado='pronta' order by capturado_em desc,id desc loop
    if c.dia=any(datas) and not exists(select 1 from backup_interno.capturas m where m.id=any(mantidas) and m.dia=c.dia and m.origem=c.origem) then
      mantidas := array_append(mantidas,c.id);
    else
      select exists(select 1 from backup_interno.capturas m where m.id=any(mantidas) and m.material @> c.exclusivos) into coberta;
      if cardinality(c.exclusivos)>0 and not coberta then mantidas := array_append(mantidas,c.id);
      else update backup_interno.capturas set estado='removendo' where id=c.id; end if;
    end if;
  end loop;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'arquivoId',arquivo_id,'pastaId',pasta_id) order by dia,id)
    from backup_interno.capturas where dono=conta and geracao=backup_interno.geracao_atual(conta) and estado='removendo'),'[]');
end $$;

create or replace function public.concluir_rotacao_backup(conta uuid, captura uuid, arquivo text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform backup_interno.geracao_atual(conta);
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  perform estoque_interno.exigir(exists(select 1 from backup_interno.capturas where dono=conta and geracao=backup_interno.geracao_atual(conta) and id=captura
    and arquivo_id=arquivo and estado in ('removendo','removida')),'backup_rotacao_nao_autorizada');
  update backup_interno.capturas set estado='removida' where dono=conta and geracao=backup_interno.geracao_atual(conta) and id=captura;
end $$;

create or replace function public.cancelar_captura_backup(conta uuid, captura uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform backup_interno.geracao_atual(conta);
  perform pg_advisory_xact_lock(22022,hashtext(conta::text));
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  perform estoque_interno.exigir(exists(select 1 from backup_interno.capturas where dono=conta and geracao=backup_interno.geracao_atual(conta) and id=captura
    and estado in ('aguardando','capturada','enviando','cancelada')),'backup_cancelamento_invalido');
  update backup_interno.capturas set estado='cancelada',documento=null,sessao=null where dono=conta and geracao=backup_interno.geracao_atual(conta) and id=captura;
  delete from backup_interno.protecoes where dono=conta and geracao=backup_interno.geracao_atual(conta) and captura_id=captura;
end $$;

create or replace function public.proxima_captura_backup(conta uuid) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('id',c.id,'estado',c.estado,'capturadoEm',c.capturado_em,'dia',c.dia,
    'vinculo',jsonb_build_object('contaId',c.dono,'destino',c.destino)) from backup_interno.capturas c
    where c.dono=conta and c.geracao=backup_interno.geracao_atual(conta) and c.origem='servidor' and c.estado in ('aguardando','capturada','enviando')
    order by (c.estado='aguardando'),c.tentado_em,c.id limit 1
$$;

create or replace function public.reservar_pasta_backup(conta uuid, destino text, pasta text) returns text
language plpgsql security definer set search_path='' as $$
declare d backup_interno.destinos;
begin
  perform backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(conta is not null and destino ~ '^https?://[^/]+$' and pasta ~ '^[a-zA-Z0-9_-]{1,200}$','backup_destino_invalido');
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  insert into backup_interno.destinos(dono,destino,pasta_id) values(conta,destino,pasta) on conflict do nothing;
  select * into d from backup_interno.destinos where dono=conta and geracao=backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(d.destino=reservar_pasta_backup.destino,'backup_destino_divergente');
  return d.pasta_id;
end $$;

create or replace function public.ultimo_backup_confirmado(conta uuid, destino text) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('origem',c.origem,'capturadoEm',c.capturado_em)
    from backup_interno.capturas c where c.dono=conta and c.geracao=backup_interno.geracao_atual(conta) and c.destino=ultimo_backup_confirmado.destino and c.estado='pronta'
    order by c.capturado_em desc,c.id desc limit 1
$$;

create or replace function public.consultar_backup_aparelho(conta uuid, captura uuid, aparelho uuid, destino text) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('estado',c.estado,'dia',c.dia,'capturadoEm',c.capturado_em,'arquivoId',c.arquivo_id,
    'pastaId',c.pasta_id,'tamanho',c.tamanho::text,'sha256',c.sha256,'sessao',c.sessao)
    from backup_interno.capturas c where c.dono=conta and c.geracao=backup_interno.geracao_atual(conta) and c.id=captura and c.origem='aparelho'
      and c.aparelho_id=aparelho and c.destino=consultar_backup_aparelho.destino
$$;

create or replace function public.reservar_backup_aparelho(conta uuid, captura uuid, aparelho uuid, destino text, instante timestamptz,
  arquivo text, pasta text, tamanho text, sha256 text, material text[], exclusivos text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c backup_interno.capturas; dia_local date := (instante at time zone 'America/Fortaleza')::date;
begin
  perform backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(conta is not null and captura is not null and aparelho is not null and destino ~ '^https?://[^/]+$'
    and dia_local <= (clock_timestamp() at time zone 'America/Fortaleza')::date,'backup_aparelho_invalido');
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into c from backup_interno.capturas b where b.id=captura;
  if not found then
    perform estoque_interno.exigir(exists(select 1 from backup_interno.destinos d where d.dono=conta and d.geracao=backup_interno.geracao_atual(conta)
      and d.destino=reservar_backup_aparelho.destino and d.pasta_id=pasta),'backup_destino_divergente');
    insert into backup_interno.capturas(id,dono,destino,origem,aparelho_id,dia,capturado_em,estado)
      values(captura,conta,destino,'aparelho',aparelho,dia_local,instante,'capturada');
    perform public.registrar_upload_backup(conta,captura,arquivo,pasta,null,tamanho,sha256,material,exclusivos);
  else
    perform estoque_interno.exigir(c.dono=conta and c.geracao=backup_interno.geracao_atual(conta) and c.destino=reservar_backup_aparelho.destino and c.origem='aparelho'
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
  perform backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(nova ~ '^https://www[.]googleapis[.]com/upload/drive/v3/files([/?]|$)','backup_sessao_invalida');
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  -- Se duas aberturas pedirem uma sessão nova, ambas continuam pela vencedora.
  update backup_interno.capturas c set sessao=nova where c.dono=conta and c.geracao=backup_interno.geracao_atual(conta) and c.id=captura and c.origem='aparelho'
    and c.aparelho_id=aparelho and c.destino=trocar_sessao_backup_aparelho.destino
    and c.estado='enviando' and c.sessao is not distinct from anterior;
  return public.consultar_backup_aparelho(conta,captura,aparelho,destino);
end $$;

create or replace function backup_interno.objetos_descartaveis(conta uuid) returns text[]
language sql set search_path='' as $$
  select array(select o.caminho from backup_interno.objetos_preparo o where o.dono=conta and o.geracao=backup_interno.geracao_atual(conta)
    and not exists(select 1 from backup_interno.lotes_reutilizaveis l
      cross join lateral jsonb_array_elements(l.lotes) f
      cross join lateral jsonb_array_elements(f->'lote'->'segmentos') s
      where l.dono=o.dono and l.geracao=backup_interno.geracao_atual(o.dono) and s->>'caminho'=o.caminho)
    order by o.caminho limit 32)
$$;

create or replace function public.assumir_preparo_backup(conta uuid,captura uuid,destino text,posse uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p backup_interno.preparos; c backup_interno.capturas; grupo jsonb; reutilizavel jsonb; estado jsonb;
begin
  perform backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(conta is not null and captura is not null and posse is not null,'backup_preparo_invalido');
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into p from backup_interno.preparos b where b.dono=conta and b.geracao=backup_interno.geracao_atual(conta);
  select * into c from backup_interno.capturas b where b.dono=conta and b.geracao=backup_interno.geracao_atual(conta) and b.id=coalesce(p.captura_id,captura)
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
    update backup_interno.preparos set fase='limpar',passo=passo+1 where dono=conta and geracao=backup_interno.geracao_atual(conta) returning * into p;
  end if;
  update backup_interno.preparos set posse=assumir_preparo_backup.posse,ate=clock_timestamp()+interval '180 seconds'
    where dono=conta and geracao=backup_interno.geracao_atual(conta) returning * into p;
  estado := jsonb_build_object('modo','preparo','versao',p.versao,'fase',p.fase,'passo',p.passo,
    'captura',jsonb_build_object('id',c.id,'dia',c.dia,'estado',c.estado,'capturadoEm',c.capturado_em,
      'vinculo',jsonb_build_object('contaId',c.dono,'destino',c.destino)));
  case p.fase
    when 'fotos' then
      grupo := p.plano->'grupos'->jsonb_array_length(p.fotos);
      select f->'lote' into reutilizavel from backup_interno.lotes_reutilizaveis l
        cross join lateral jsonb_array_elements(l.lotes) f where l.dono=conta and l.geracao=backup_interno.geracao_atual(conta) and f->>'chave'=grupo->>'chave';
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
  perform backup_interno.geracao_atual(conta);
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into p from backup_interno.preparos b where b.dono=conta and b.geracao=backup_interno.geracao_atual(conta) and b.captura_id=captura;
  perform estoque_interno.exigir(found and p.posse=reservar_objetos_backup.posse and p.ate>clock_timestamp()
    and p.passo=reservar_objetos_backup.passo and p.fase in ('dados','fotos','fechar'),'backup_preparo_sem_posse');
  perform estoque_interno.exigir(jsonb_typeof(objetos)='array' and jsonb_array_length(objetos) between 1 and 64,'backup_objetos_invalidos');
  for o in select value from jsonb_array_elements(objetos) loop
    insert into backup_interno.objetos_preparo(dono,captura_id,sha256,bytes)
      values(conta,captura,o->>'sha256',(o->>'bytes')::integer) on conflict do nothing;
    perform estoque_interno.exigir(exists(select 1 from backup_interno.objetos_preparo b where b.dono=conta and b.geracao=backup_interno.geracao_atual(conta)
      and b.captura_id=captura and b.sha256=o->>'sha256' and b.bytes=(o->>'bytes')::integer),'backup_objeto_divergente');
  end loop;
end $$;

create or replace function public.avancar_preparo_backup(conta uuid,captura uuid,posse uuid,passo integer,resultado jsonb,encadear boolean) returns void
language plpgsql security definer set search_path='' as $$
declare p backup_interno.preparos; c backup_interno.capturas; impressao bytea; manter boolean := false;
  continuar boolean := encadear; apagados text[]; url text; token text;
begin
  perform backup_interno.geracao_atual(conta);
  perform pg_advisory_xact_lock(hashtextextended(conta::text,84));
  select * into p from backup_interno.preparos b where b.dono=conta and b.geracao=backup_interno.geracao_atual(conta) and b.captura_id=captura;
  perform estoque_interno.exigir(found and jsonb_typeof(resultado)='object','backup_preparo_indisponivel');
  impressao := sha256(convert_to(resultado::text,'UTF8'));
  if p.passo=avancar_preparo_backup.passo+1 and p.ultima_posse=avancar_preparo_backup.posse and p.ultimo_resultado=impressao then return; end if;
  perform estoque_interno.exigir(p.posse=avancar_preparo_backup.posse and p.ate>clock_timestamp()
    and p.passo=avancar_preparo_backup.passo,'backup_preparo_sem_posse');
  select * into c from backup_interno.capturas b where b.dono=conta and b.geracao=backup_interno.geracao_atual(conta) and b.id=captura;
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
          on conflict(dono,geracao) do update set lotes=excluded.lotes;
        p.fase := 'limpar';
      else
        perform estoque_interno.exigir((resultado->>'enviados')::bigint between 0 and (p.indice->>'tamanho')::bigint,'backup_posicao_invalida');
        continuar := continuar and (resultado->>'enviados')::bigint>p.enviados;
        p.enviados := greatest(p.enviados,(resultado->>'enviados')::bigint);
      end if;
    when 'limpar' then
      apagados := backup_interno.objetos_descartaveis(conta);
      perform estoque_interno.exigir(resultado->'apagados'=to_jsonb(apagados),'backup_limpeza_divergente');
      delete from backup_interno.objetos_preparo where dono=conta and geracao=backup_interno.geracao_atual(conta) and caminho=any(apagados);
      if cardinality(backup_interno.objetos_descartaveis(conta))=0 then
        delete from backup_interno.preparos where dono=conta and geracao=backup_interno.geracao_atual(conta);
        return;
      end if;
  end case;
  update backup_interno.preparos b set fase=p.fase,passo=p.passo+1,plano=p.plano,material=p.material,
    fotos=p.fotos,indice=p.indice,enviados=p.enviados,ultima_posse=p.posse,ultimo_resultado=impressao,
    posse=case when manter then p.posse end,ate=case when manter then p.ate end where b.dono=conta and b.geracao=backup_interno.geracao_atual(conta);
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
    where b.dono=conta and b.geracao=backup_interno.geracao_atual(conta) and b.captura_id=captura and b.posse=soltar_preparo_backup.posse
$$;

create function public.rpc_backup_vinculado(vinculo uuid,nome text,argumentos jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare conta uuid := (argumentos->>'conta')::uuid;
begin
  perform set_config('fichinhas.backup_geracao',vinculo::text,true);
  perform estoque_interno.exigir(vinculo=backup_interno.geracao_atual(conta),'backup_conexao_alterada');
  case nome
    when 'capturar_backup_servidor' then return to_jsonb(public.capturar_backup_servidor((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'destino')::text,(argumentos->>'agora')::timestamptz));
    when 'ler_captura_backup' then return to_jsonb(public.ler_captura_backup((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'tabela')::text,(argumentos->>'inicio')::integer,(argumentos->>'limite')::integer));
    when 'registrar_upload_backup' then perform public.registrar_upload_backup((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'arquivo')::text,(argumentos->>'pasta')::text,(argumentos->>'sessao')::text,(argumentos->>'tamanho')::text,(argumentos->>'sha256')::text,array(select jsonb_array_elements_text(argumentos->'material')),array(select jsonb_array_elements_text(argumentos->'exclusivos'))); return null;
    when 'consultar_upload_backup' then return to_jsonb(public.consultar_upload_backup((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid));
    when 'confirmar_backup' then perform public.confirmar_backup((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'arquivo')::text,(argumentos->>'tamanho')::text,(argumentos->>'sha256')::text); return null;
    when 'planejar_rotacao_backup' then return to_jsonb(public.planejar_rotacao_backup((argumentos->>'conta')::uuid));
    when 'concluir_rotacao_backup' then perform public.concluir_rotacao_backup((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'arquivo')::text); return null;
    when 'cancelar_captura_backup' then perform public.cancelar_captura_backup((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid); return null;
    when 'proxima_captura_backup' then return to_jsonb(public.proxima_captura_backup((argumentos->>'conta')::uuid));
    when 'reservar_pasta_backup' then return to_jsonb(public.reservar_pasta_backup((argumentos->>'conta')::uuid,(argumentos->>'destino')::text,(argumentos->>'pasta')::text));
    when 'ultimo_backup_confirmado' then return to_jsonb(public.ultimo_backup_confirmado((argumentos->>'conta')::uuid,(argumentos->>'destino')::text));
    when 'consultar_backup_aparelho' then return to_jsonb(public.consultar_backup_aparelho((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'aparelho')::uuid,(argumentos->>'destino')::text));
    when 'reservar_backup_aparelho' then return to_jsonb(public.reservar_backup_aparelho((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'aparelho')::uuid,(argumentos->>'destino')::text,(argumentos->>'instante')::timestamptz,(argumentos->>'arquivo')::text,(argumentos->>'pasta')::text,(argumentos->>'tamanho')::text,(argumentos->>'sha256')::text,array(select jsonb_array_elements_text(argumentos->'material')),array(select jsonb_array_elements_text(argumentos->'exclusivos'))));
    when 'trocar_sessao_backup_aparelho' then return to_jsonb(public.trocar_sessao_backup_aparelho((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'aparelho')::uuid,(argumentos->>'destino')::text,(argumentos->>'anterior')::text,(argumentos->>'nova')::text));
    when 'assumir_preparo_backup' then return to_jsonb(public.assumir_preparo_backup((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'destino')::text,(argumentos->>'posse')::uuid));
    when 'reservar_objetos_backup' then perform public.reservar_objetos_backup((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'posse')::uuid,(argumentos->>'passo')::integer,argumentos->'objetos'); return null;
    when 'avancar_preparo_backup' then perform public.avancar_preparo_backup((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'posse')::uuid,(argumentos->>'passo')::integer,argumentos->'resultado',(argumentos->>'encadear')::boolean); return null;
    when 'soltar_preparo_backup' then perform public.soltar_preparo_backup((argumentos->>'conta')::uuid,(argumentos->>'captura')::uuid,(argumentos->>'posse')::uuid); return null;
    else raise exception 'backup_rpc_invalida' using errcode='23514';
  end case;
end $$;
revoke all on function public.rpc_backup_vinculado(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.rpc_backup_vinculado(uuid,text,jsonb) to service_role;
