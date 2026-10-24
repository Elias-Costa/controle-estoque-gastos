-- E-32 / D-069: fatos próprios, sem alterar financeiro, estoque ou fotos publicados.
-- Dinheiro entra como texto validado ANTES do cast; a coluna bigint é derivada desse texto.
create schema caixa_interno;
revoke all on schema caixa_interno from public, anon, authenticated;

create function caixa_interno.exigir(condicao boolean, regra text) returns void
language plpgsql set search_path = '' as $$
begin
  if condicao is distinct from true then
    raise exception '%', regra using errcode='23514', constraint=regra;
  end if;
end
$$;

-- Reutiliza somente validadores puros já publicados, sem ampliar RPCs de estoque.
create function caixa_interno.fato_valido(f jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(f) is distinct from 'object'
    or not estoque_interno.uuid_valido(f->'id')
    or not estoque_interno.inteiro(f->'revisao',1,9007199254740991)
    or jsonb_typeof(f->'data') is distinct from 'string'
    or not coalesce(public.dia_valido(f->>'data'),false) then return false; end if;
  case f->>'tipo'
    when 'despesa', 'receita-avulsa' then
      return coalesce(
        f - (array['id','revisao','data','tipo','valor','categoria','classificacao']
          || case when f->>'tipo'='despesa' then array['mercadoria'] else array[]::text[] end)='{}'::jsonb
        and estoque_interno.inteiro(f->'valor',1,9223372036854775807,true)
        and jsonb_typeof(f->'categoria')='string' and btrim(f->>'categoria')<>''
        and f->>'classificacao' in ('negocio','pessoal')
        and (f->>'tipo'<>'despesa' or (jsonb_typeof(f->'mercadoria')='boolean'
          and (f->'mercadoria'='false'::jsonb or f->>'classificacao'='negocio'))),false);
    when 'estorno' then
      return f - array['id','revisao','data','tipo','alvo']='{}'::jsonb
        and estoque_interno.refs_validas(jsonb_build_array(f->'alvo'));
    else return false;
  end case;
end
$$;

create table caixa_interno.contadores (
  dono uuid primary key,
  ultimo bigint not null check (ultimo>=0)
);
create table public.operacoes_caixa (
  id uuid primary key,
  dono uuid not null default auth.uid(),
  revisao bigint not null check (revisao between 1 and 9007199254740991),
  formato integer not null check (formato=1),
  tipo text not null check (tipo in ('registro','estorno','correcao')),
  fatos jsonb not null check (estoque_interno.refs_validas(fatos)),
  alvo_id uuid, alvo_revisao bigint,
  recepcao bigint not null,
  constraint operacoes_caixa_referencia unique(id,revisao,dono),
  constraint operacoes_caixa_recepcao unique(dono,recepcao),
  constraint operacoes_caixa_alvo check (
    (tipo='registro' and alvo_id is null and alvo_revisao is null)
    or (tipo in ('estorno','correcao') and alvo_id is not null and alvo_revisao between 1 and 9007199254740991))
);
-- O alvo não pode ser corrigido outra vez, nem sob revisão inventada (D-069).
create unique index operacoes_caixa_um_alvo on public.operacoes_caixa(dono,alvo_id) where alvo_id is not null;

create table public.fatos_caixa (
  id uuid primary key,
  dono uuid not null default auth.uid(),
  revisao bigint not null check (revisao between 1 and 9007199254740991),
  operacao_id uuid not null,
  revisao_operacao bigint not null,
  conteudo jsonb not null,
  tipo text generated always as (conteudo->>'tipo') stored,
  valor bigint generated always as ((conteudo->>'valor')::bigint) stored,
  alvo_id uuid generated always as ((conteudo->'alvo'->>'id')::uuid) stored,
  alvo_revisao bigint generated always as ((conteudo->'alvo'->>'revisao')::bigint) stored,
  constraint fatos_caixa_conteudo check (caixa_interno.fato_valido(conteudo)
    and conteudo->>'id'=id::text and conteudo->'revisao'=to_jsonb(revisao)),
  constraint fatos_caixa_referencia unique(id,revisao,dono),
  constraint fatos_caixa_operacao foreign key (operacao_id,revisao_operacao,dono)
    references public.operacoes_caixa(id,revisao,dono) deferrable initially deferred,
  constraint fatos_caixa_alvo foreign key (alvo_id,alvo_revisao,dono)
    references public.fatos_caixa(id,revisao,dono) deferrable initially deferred
);
alter table public.operacoes_caixa add constraint operacoes_caixa_alvo_fato
  foreign key (alvo_id,alvo_revisao,dono) references public.fatos_caixa(id,revisao,dono)
  deferrable initially deferred;
create unique index fatos_caixa_um_estorno on public.fatos_caixa(dono,alvo_id) where alvo_id is not null;
create index fatos_caixa_por_operacao on public.fatos_caixa(operacao_id);

create function caixa_interno.imutavel() returns trigger
language plpgsql set search_path = '' as $$
declare mudou boolean;
begin
  if tg_op='DELETE' then
    raise exception 'caixa_imutavel' using errcode='23514', constraint='caixa_imutavel';
  end if;
  -- BEFORE ainda não recalculou as colunas geradas. Só suas fontes são editáveis.
  -- Exceção local de D-041 em 24/10: comparar o conteúdo, sem recusar um no-op legítimo.
  if tg_table_name='fatos_caixa' then
    mudou := (new.id,new.dono,new.revisao,new.operacao_id,new.revisao_operacao,new.conteudo)
      is distinct from (old.id,old.dono,old.revisao,old.operacao_id,old.revisao_operacao,old.conteudo);
  else
    mudou := new is distinct from old;
  end if;
  if mudou then
    raise exception 'caixa_imutavel' using errcode='23514', constraint='caixa_imutavel';
  end if;
  return new;
end
$$;
create trigger operacoes_caixa_imutaveis before update or delete on public.operacoes_caixa
  for each row execute function caixa_interno.imutavel();
create trigger fatos_caixa_imutaveis before update or delete on public.fatos_caixa
  for each row execute function caixa_interno.imutavel();

-- A mesma trava protege numeração, consulta do aceite e SQL direto até commit/rollback.
create function caixa_interno.numerar() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into caixa_interno.contadores(dono,ultimo) values(new.dono,0) on conflict(dono) do nothing;
  update caixa_interno.contadores set ultimo=ultimo+1 where dono=new.dono returning ultimo into new.recepcao;
  return new;
end
$$;
create trigger operacoes_caixa_numerar before insert on public.operacoes_caixa
  for each row execute function caixa_interno.numerar();

create function caixa_interno.grupo_json(o public.operacoes_caixa) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('operacao',jsonb_strip_nulls(jsonb_build_object(
    'id',o.id,'formato',o.formato,'revisao',o.revisao,'tipo',o.tipo,'fatos',o.fatos,
    'alvo',case when o.alvo_id is not null then jsonb_build_object('id',o.alvo_id,'revisao',o.alvo_revisao) end)),
    'fatos',coalesce((select jsonb_agg(f.conteudo order by r.ordem)
      from jsonb_array_elements(o.fatos) with ordinality r(ref,ordem)
      join public.fatos_caixa f on f.dono=o.dono and f.operacao_id=o.id and f.id=(r.ref->>'id')::uuid),'[]'::jsonb))
$$;

create function caixa_interno.conferir_grupo(conta uuid, identificador uuid) returns void
language plpgsql set search_path = '' as $$
declare o public.operacoes_caixa; alvo public.fatos_caixa; estorno public.fatos_caixa;
  quantidade integer; estornos integer;
begin
  select * into strict o from public.operacoes_caixa where dono=conta and id=identificador;
  perform caixa_interno.exigir(
    jsonb_array_length(o.fatos)=(select count(*) from public.fatos_caixa where dono=conta and operacao_id=o.id)
    and not exists(select 1 from jsonb_array_elements(o.fatos) r where not exists(
      select 1 from public.fatos_caixa f where f.dono=conta and f.operacao_id=o.id
        and f.revisao_operacao=o.revisao and f.id=(r->>'id')::uuid and f.revisao=(r->>'revisao')::bigint))
    and (select count(*)=count(distinct r->>'id') from jsonb_array_elements(o.fatos) r), 'caixa_grupo_incompleto');
  perform caixa_interno.exigir(not exists(select 1 from public.fatos_caixa where dono=conta and id=o.id)
    and not exists(select 1 from public.fatos_caixa f join public.operacoes_caixa outra on outra.id=f.id
      where f.dono=conta and f.operacao_id=o.id),'caixa_identidade_reutilizada');
  select count(*),count(*) filter(where tipo='estorno') into quantidade,estornos
    from public.fatos_caixa where dono=conta and operacao_id=o.id;
  perform caixa_interno.exigir(
    (o.tipo='registro' and quantidade=1 and estornos=0)
    or (o.tipo='estorno' and quantidade=1 and estornos=1)
    or (o.tipo='correcao' and quantidade=2 and estornos=1),'caixa_efeitos_invalidos');
  if o.tipo<>'registro' then
    select * into alvo from public.fatos_caixa where dono=conta and id=o.alvo_id and revisao=o.alvo_revisao;
    perform caixa_interno.exigir(found and alvo.tipo<>'estorno' and alvo.operacao_id<>o.id,'caixa_alvo_invalido');
    select * into strict estorno from public.fatos_caixa where dono=conta and operacao_id=o.id and tipo='estorno';
    perform caixa_interno.exigir(estorno.alvo_id=o.alvo_id and estorno.alvo_revisao=o.alvo_revisao,'caixa_alvo_divergente');
  end if;
end
$$;
create function caixa_interno.conferir_apos_escrita() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name='operacoes_caixa' then
    perform caixa_interno.conferir_grupo(new.dono,new.id);
  else
    perform caixa_interno.conferir_grupo(new.dono,new.operacao_id);
  end if;
  return null;
end
$$;
create constraint trigger operacoes_caixa_completas after insert on public.operacoes_caixa
  deferrable initially deferred for each row execute function caixa_interno.conferir_apos_escrita();
create constraint trigger fatos_caixa_completos after insert on public.fatos_caixa
  deferrable initially deferred for each row execute function caixa_interno.conferir_apos_escrita();

create function public.aceitar_grupo_caixa(grupo jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare conta uuid := auth.uid(); op jsonb := grupo->'operacao'; f jsonb;
  o public.operacoes_caixa; identificador uuid; posicao bigint;
begin
  perform caixa_interno.exigir(conta is not null,'caixa_sessao_obrigatoria');
  perform caixa_interno.exigir(jsonb_typeof(grupo)='object'
    and grupo - array['operacao','fatos']='{}'::jsonb and jsonb_typeof(op)='object'
    and op - array['id','formato','revisao','tipo','alvo','fatos']='{}'::jsonb
    and estoque_interno.uuid_valido(op->'id') and estoque_interno.inteiro(op->'revisao',1,9007199254740991)
    and op->'formato'='1'::jsonb and op->>'tipo' in ('registro','estorno','correcao')
    and estoque_interno.refs_validas(op->'fatos') and jsonb_typeof(grupo->'fatos')='array'
    and (not op ? 'alvo' or estoque_interno.refs_validas(jsonb_build_array(op->'alvo'))),'caixa_formato_invalido');
  for f in select value from jsonb_array_elements(grupo->'fatos') loop
    perform caixa_interno.exigir(caixa_interno.fato_valido(f),'caixa_fato_invalido');
  end loop;
  identificador := (op->>'id')::uuid;
  insert into caixa_interno.contadores(dono,ultimo) values(conta,0) on conflict(dono) do nothing;
  perform 1 from caixa_interno.contadores where dono=conta for update;
  select * into o from public.operacoes_caixa where id=identificador;
  if found then
    perform caixa_interno.exigir(o.dono=conta and caixa_interno.grupo_json(o)=grupo,'caixa_conteudo_divergente');
    return o.recepcao::text;
  end if;
  -- Alvo/revisão são conferidos sob a trava; índices/FKs repetem a proteção no SQL direto.
  if op ? 'alvo' then
    perform caixa_interno.exigir(exists(select 1 from public.fatos_caixa where dono=conta
      and id=(op->'alvo'->>'id')::uuid and revisao=(op->'alvo'->>'revisao')::bigint and tipo<>'estorno'), 'caixa_alvo_invalido');
  end if;
  insert into public.operacoes_caixa(id,dono,revisao,formato,tipo,fatos,alvo_id,alvo_revisao)
    values(identificador,conta,(op->>'revisao')::bigint,1,op->>'tipo',op->'fatos',
      (op->'alvo'->>'id')::uuid,(op->'alvo'->>'revisao')::bigint) returning recepcao into posicao;
  for f in select value from jsonb_array_elements(grupo->'fatos') loop
    insert into public.fatos_caixa(id,dono,revisao,operacao_id,revisao_operacao,conteudo)
      values((f->>'id')::uuid,conta,(f->>'revisao')::bigint,identificador,(op->>'revisao')::bigint,f);
  end loop;
  perform caixa_interno.conferir_grupo(conta,identificador);
  select * into strict o from public.operacoes_caixa where id=identificador;
  perform caixa_interno.exigir(caixa_interno.grupo_json(o)=grupo,'caixa_formato_divergente');
  return posicao::text;
end
$$;

-- Uma posição sempre contém o grupo inteiro; a recepção local/cursor pertence à E-33.
create function public.baixar_caixa(apos text default '0', limite integer default 500) returns setof jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform caixa_interno.exigir(auth.uid() is not null,'caixa_sessao_obrigatoria');
  perform caixa_interno.exigir(estoque_interno.inteiro(to_jsonb(apos),0,9223372036854775807,true)
    and limite between 1 and 500,'caixa_cursor_invalido');
  return query select jsonb_build_object('recepcao',o.recepcao::text,'grupo',caixa_interno.grupo_json(o))
    from public.operacoes_caixa o where o.dono=auth.uid() and o.recepcao>apos::bigint order by o.recepcao limit limite;
end
$$;

alter table public.operacoes_caixa enable row level security;
alter table public.fatos_caixa enable row level security;
create policy operacoes_caixa_da_conta on public.operacoes_caixa for select to authenticated using(dono=auth.uid());
create policy fatos_caixa_da_conta on public.fatos_caixa for select to authenticated using(dono=auth.uid());
revoke all on public.operacoes_caixa, public.fatos_caixa from public, anon, authenticated;
grant select on public.operacoes_caixa, public.fatos_caixa to authenticated;
revoke all on all functions in schema caixa_interno from public, anon, authenticated;
revoke all on function public.aceitar_grupo_caixa(jsonb), public.baixar_caixa(text,integer) from public, anon;
grant execute on function public.aceitar_grupo_caixa(jsonb), public.baixar_caixa(text,integer) to authenticated;
