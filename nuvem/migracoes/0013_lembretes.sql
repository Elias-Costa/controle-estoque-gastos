-- E-38 / D-079: inscrições e rodadas aditivas. Não agenda nem contém segredos.
create schema lembretes_interno;
revoke all on schema lembretes_interno from public, anon, authenticated;

create table lembretes_interno.configuracao (
  chave boolean primary key default true check(chave),
  chave_publica text not null check(chave_publica ~ '^[A-Za-z0-9_-]{87}$')
);
create table lembretes_interno.inscricoes (
  dono uuid not null,
  aparelho_id uuid not null,
  revisao bigint not null check(revisao between 1 and 9007199254740991),
  ativa boolean not null,
  inscricao jsonb,
  invalida boolean not null default false,
  primary key(dono,aparelho_id),
  check((ativa and inscricao is not null) or (not ativa and inscricao is null))
);
create table lembretes_interno.observacoes (
  dono uuid primary key,
  conteudo jsonb not null default '{"baixos":[],"pendentes":[],"lembrados":[]}'::jsonb
);
create table lembretes_interno.rodadas (
  dono uuid not null,
  dia date not null,
  primary key(dono,dia)
);
create table lembretes_interno.envios (
  dono uuid not null,
  dia date not null,
  aparelho_id uuid not null,
  revisao bigint not null,
  tentativa integer not null default 0 check(tentativa between 0 and 3),
  oportunidade integer not null default -1 check(oportunidade in (-1,0,15,30)),
  estado text not null default 'pendente' check(estado in ('pendente','em-envio','aceito','incerto','invalida','retentavel','problema')),
  retentar_apos timestamptz,
  primary key(dono,dia,aparelho_id),
  foreign key(dono,dia) references lembretes_interno.rodadas(dono,dia),
  foreign key(dono,aparelho_id) references lembretes_interno.inscricoes(dono,aparelho_id)
);
alter table lembretes_interno.configuracao enable row level security;
alter table lembretes_interno.inscricoes enable row level security;
alter table lembretes_interno.observacoes enable row level security;
alter table lembretes_interno.rodadas enable row level security;
alter table lembretes_interno.envios enable row level security;
revoke all on all tables in schema lembretes_interno from public, anon, authenticated;

create function lembretes_interno.inscricao_valida(i jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(i)='object' and i-array['endpoint','p256dh','auth']='{}'::jsonb
    and jsonb_typeof(i->'endpoint')='string' and length(i->>'endpoint')<=4096
    and (i->>'endpoint') ~ '^https://(fcm\.googleapis\.com|([a-z0-9-]+\.)+push\.apple\.com)/[^#[:space:]]+$'
    and jsonb_typeof(i->'p256dh')='string' and (i->>'p256dh') ~ '^[A-Za-z0-9_-]{87}$'
    and jsonb_typeof(i->'auth')='string' and (i->>'auth') ~ '^[A-Za-z0-9_-]{22}$',false)
$$;
alter table lembretes_interno.inscricoes add constraint inscricoes_conteudo_valido
  check(inscricao is null or lembretes_interno.inscricao_valida(inscricao));
-- A mesma inscrição do navegador pode sobreviver à perda da identidade local.
-- MD5 só limita o índice, não autentica: colisão recusa cadastro, nunca troca destino.
create unique index inscricoes_um_destino on lembretes_interno.inscricoes(dono,md5(inscricao->>'endpoint'))
  where ativa and not invalida;

create function public.obter_configuracao_lembretes() returns text
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise insufficient_privilege; end if;
  return (select chave_publica from lembretes_interno.configuracao where chave);
end
$$;

create function public.registrar_inscricao_lembretes(pedido jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  conta uuid := auth.uid();
  aparelho uuid;
  versao bigint;
  anterior bigint;
  ligada boolean;
  atual lembretes_interno.inscricoes;
begin
  if conta is null then raise insufficient_privilege; end if;
  if jsonb_typeof(pedido) is distinct from 'object'
    or pedido-array['aparelhoId','revisao','anterior','ativa','inscricao']<>'{}'::jsonb
    or not estoque_interno.uuid_valido(pedido->'aparelhoId')
    or not estoque_interno.inteiro(pedido->'revisao',1,9007199254740991)
    or not estoque_interno.inteiro(pedido->'anterior',0,9007199254740991)
    or jsonb_typeof(pedido->'ativa') is distinct from 'boolean'
    or (case when pedido->'ativa'='true'::jsonb then not lembretes_interno.inscricao_valida(pedido->'inscricao')
      else pedido ? 'inscricao' end) then
    raise exception 'inscricao_invalida' using errcode='23514';
  end if;
  aparelho := (pedido->>'aparelhoId')::uuid;
  versao := (pedido->>'revisao')::bigint;
  anterior := (pedido->>'anterior')::bigint;
  ligada := (pedido->>'ativa')::boolean;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(conta::text,38));
  select * into atual from lembretes_interno.inscricoes where dono=conta and aparelho_id=aparelho for update;
  if found then
    if atual.revisao=versao and atual.ativa=ligada and atual.inscricao is not distinct from pedido->'inscricao' then
      return jsonb_build_object('revisao',atual.revisao,'estado',case when atual.invalida then 'invalida' when atual.ativa then 'ativa' else 'desligada' end);
    end if;
    if atual.revisao<>anterior or versao<=atual.revisao then
      return jsonb_build_object('revisao',atual.revisao,'estado','conflito');
    end if;
  elsif anterior<>0 then
    return jsonb_build_object('revisao',0,'estado','conflito');
  end if;
  if ligada then
    update lembretes_interno.inscricoes set invalida=true
      where dono=conta and aparelho_id<>aparelho and ativa and not invalida and inscricao->>'endpoint'=pedido->'inscricao'->>'endpoint';
  end if;
  insert into lembretes_interno.inscricoes(dono,aparelho_id,revisao,ativa,inscricao)
    values(conta,aparelho,versao,ligada,pedido->'inscricao')
    on conflict(dono,aparelho_id) do update set revisao=excluded.revisao,ativa=excluded.ativa,inscricao=excluded.inscricao,invalida=false;
  insert into lembretes_interno.observacoes(dono) values(conta) on conflict do nothing;
  return jsonb_build_object('revisao',versao,'estado',case when ligada then 'ativa' else 'desligada' end);
end
$$;

-- Uma instrução SQL fornece a mesma fotografia MVCC de todas as fontes. Centavos são texto.
create function lembretes_interno.fontes(conta uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'clientes',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.clientes c where c.dono=conta),'[]'::jsonb),
    'lancamentos',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('valor',l.valor::text,'desconto',l.desconto::text) order by l.id)
      from public.lancamentos l where l.dono=conta),'[]'::jsonb),
    'produtos',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('preco_venda',p.preco_venda::text,'custo_manual',p.custo_manual::text) order by p.id)
      from public.produtos p where p.dono=conta),'[]'::jsonb),
    'movimentos',coalesce((select jsonb_agg(estoque_interno.movimento_json(m) order by m.id,m.revisao)
      from public.movimentos_estoque m where m.dono=conta),'[]'::jsonb),
    'evidencias',coalesce((select jsonb_agg(o.evidencias order by o.id) from public.operacoes_estoque o where o.dono=conta),'[]'::jsonb),
    'caixa',coalesce((select jsonb_agg(caixa_interno.grupo_json(o) order by o.id) from public.operacoes_caixa o where o.dono=conta),'[]'::jsonb))
$$;
create function public.listar_contas_lembretes() returns setof uuid
language sql security definer set search_path = '' as $$
  select distinct dono from lembretes_interno.inscricoes where ativa and not invalida
$$;
create function public.fotografia_lembretes(conta uuid) returns jsonb
language sql security definer set search_path = '' as $$
  with fotografia as (select lembretes_interno.fontes(conta) fontes,
    coalesce((select conteudo from lembretes_interno.observacoes where dono=conta),'{"baixos":[],"pendentes":[],"lembrados":[]}'::jsonb) observacao)
  select jsonb_build_object('fontes',fontes,'observacao',observacao,'carimbo',md5((fontes||jsonb_build_object('observacao',observacao))::text)) from fotografia
$$;

create function public.preparar_rodada_lembretes(conta uuid, carimbo text, observacao jsonb, tem_motivo boolean, agora timestamptz default clock_timestamp(), observacao_rodada jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  local_agora timestamp := agora at time zone 'America/Fortaleza';
  data_rodada date := local_agora::date;
  slot integer := case when extract(minute from local_agora)>=30 then 30 when extract(minute from local_agora)>=15 then 15 else 0 end;
  fotografia jsonb;
  destinos jsonb;
begin
  if local_agora::time < time '09:00' or local_agora::time >= time '09:31' then return '{"estado":"fora-do-horario","destinos":[]}'::jsonb; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(conta::text,38));
  fotografia := public.fotografia_lembretes(conta);
  if fotografia->>'carimbo' is distinct from carimbo then return '{"estado":"alterada","destinos":[]}'::jsonb; end if;
  if jsonb_typeof(observacao) is distinct from 'object'
    or jsonb_typeof(observacao->'baixos') is distinct from 'array'
    or jsonb_typeof(observacao->'pendentes') is distinct from 'array'
    or jsonb_typeof(observacao->'lembrados') is distinct from 'array' then raise exception 'observacao_invalida' using errcode='23514'; end if;
  insert into lembretes_interno.observacoes(dono,conteudo) values(conta,observacao) on conflict(dono) do update set conteudo=excluded.conteudo;
  if not tem_motivo then return '{"estado":"sem-motivo","destinos":[]}'::jsonb; end if;
  insert into lembretes_interno.rodadas(dono,dia) values(conta,data_rodada) on conflict do nothing;
  insert into lembretes_interno.envios(dono,dia,aparelho_id,revisao)
    select conta,data_rodada,i.aparelho_id,i.revisao from lembretes_interno.inscricoes i where i.dono=conta and i.ativa and not i.invalida
    on conflict do nothing;
  -- Início sem conclusão de oportunidade anterior é ambíguo, nunca elegível ao reenvio.
  update lembretes_interno.envios set estado='incerto' where dono=conta and dia=data_rodada and estado='em-envio' and oportunidade<slot;
  with reservados as (
    update lembretes_interno.envios e set estado='em-envio',tentativa=e.tentativa+1,oportunidade=slot,revisao=i.revisao
      from lembretes_interno.inscricoes i
      where e.dono=conta and e.dia=data_rodada and e.dono=i.dono and e.aparelho_id=i.aparelho_id and i.ativa and not i.invalida
        and e.estado in ('pendente','retentavel') and e.oportunidade<slot and e.tentativa<3 and (e.retentar_apos is null or e.retentar_apos<=agora)
      returning e.aparelho_id,e.revisao,e.tentativa,i.inscricao
  ) select coalesce(jsonb_agg(jsonb_build_object('aparelhoId',aparelho_id,'revisao',revisao,'tentativa',tentativa,'inscricao',inscricao) order by aparelho_id),'[]'::jsonb) into destinos from reservados;
  if jsonb_array_length(destinos)>0 and observacao_rodada is not null then
    update lembretes_interno.observacoes set conteudo=observacao_rodada where dono=conta;
  end if;
  return jsonb_build_object('estado','preparada','dia',data_rodada,'destinos',destinos);
end
$$;

create function public.concluir_envio_lembretes(conta uuid, dia date, aparelho uuid, revisao bigint, tentativa integer, resultado text, retentar_apos timestamptz default null) returns void
language plpgsql security definer set search_path = '' as $$
declare alterados integer;
begin
  if resultado not in ('aceito','incerto','invalida','retentavel','problema') then raise exception 'resultado_invalido' using errcode='23514'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(conta::text,38));
  update lembretes_interno.envios e set estado=resultado,retentar_apos=concluir_envio_lembretes.retentar_apos
    where e.dono=conta and e.dia=concluir_envio_lembretes.dia and e.aparelho_id=aparelho and e.revisao=concluir_envio_lembretes.revisao
      and e.tentativa=concluir_envio_lembretes.tentativa and e.estado='em-envio';
  get diagnostics alterados = row_count;
  if alterados=1 and resultado='invalida' then
    update lembretes_interno.inscricoes i set invalida=true where i.dono=conta and i.aparelho_id=aparelho and i.revisao=concluir_envio_lembretes.revisao;
  end if;
end
$$;

revoke all on all functions in schema lembretes_interno from public,anon,authenticated;
revoke all on function public.obter_configuracao_lembretes(),public.registrar_inscricao_lembretes(jsonb),
  public.listar_contas_lembretes(),public.fotografia_lembretes(uuid),public.preparar_rodada_lembretes(uuid,text,jsonb,boolean,timestamptz,jsonb),
  public.concluir_envio_lembretes(uuid,date,uuid,bigint,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function public.obter_configuracao_lembretes(),public.registrar_inscricao_lembretes(jsonb) to authenticated;
grant execute on function public.listar_contas_lembretes(),public.fotografia_lembretes(uuid),public.preparar_rodada_lembretes(uuid,text,jsonb,boolean,timestamptz,jsonb),
  public.concluir_envio_lembretes(uuid,date,uuid,bigint,integer,text,timestamptz) to service_role;
