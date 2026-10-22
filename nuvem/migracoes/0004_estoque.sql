-- 0004_estoque — Esquema aditivo e garantias de F2 (E-20, D-017/018/041/057/058).
-- Aplicar antes do app F2, preservando F1. O runner aplica somente nos testes nesta etapa.
-- Não editar depois de criada; correções entram na próxima migration (D-041).
-- D-057: os valores ficam nos registros próprios; o manifesto contém referências.
create schema estoque_interno;
revoke all on schema estoque_interno from public, anon, authenticated;

create function estoque_interno.exigir(condicao boolean, regra text) returns void
language plpgsql set search_path = '' as $$
begin
  if condicao is distinct from true then
    raise exception '%', regra using errcode = '23514', constraint = regra;
  end if;
end
$$;

create function estoque_interno.uuid_valido(valor jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(valor) = 'string' and valor #>> '{}' ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
$$;

-- A checagem antecede o cast: bigint sozinho arredondaria um parâmetro SQL numeric.
-- A RPC recebe dinheiro como TEXTO; quantidades continuam números inteiros seguros.
create function estoque_interno.inteiro(valor jsonb, minimo bigint, maximo bigint, em_texto boolean default false) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if valor is null or jsonb_typeof(valor) <> (case when em_texto then 'string' else 'number' end)
    or valor #>> '{}' !~ '^-?[0-9]+$' then return false; end if;
  return (valor #>> '{}')::bigint between minimo and maximo;
exception when numeric_value_out_of_range then return false;
end
$$;

create function estoque_interno.refs_validas(refs jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare ref jsonb;
begin
  if jsonb_typeof(refs) is distinct from 'array' then return false; end if;
  for ref in select value from jsonb_array_elements(refs) loop
    if jsonb_typeof(ref) <> 'object' or ref - array['id','revisao'] <> '{}'::jsonb
      or not estoque_interno.uuid_valido(ref->'id')
      or not estoque_interno.inteiro(ref->'revisao', 1, 9007199254740991) then return false; end if;
  end loop;
  return (select count(*) = count(distinct value) from jsonb_array_elements(refs));
end
$$;

create function estoque_interno.movimento_valido(m jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare e jsonb;
begin
  if jsonb_typeof(m) <> 'object' or not estoque_interno.uuid_valido(m->'id')
    or not estoque_interno.uuid_valido(m->'operacaoId') or not estoque_interno.uuid_valido(m->'produtoId')
    or not estoque_interno.inteiro(m->'revisao',1,9007199254740991)
    or not coalesce(public.dia_valido(m->>'data'), false)
    or not estoque_interno.refs_validas(m->'conhecidos') then return false; end if;
  if m ? 'custoUnitario' and not estoque_interno.inteiro(m->'custoUnitario',0,9223372036854775807,true) then return false; end if;
  case m->>'tipo'
    when 'compra' then
      return m - array['id','revisao','operacaoId','produtoId','data','conhecidos','tipo','quantidade','custoUnitario','ordemCadastro','compraOriginalId'] = '{}'::jsonb
        and estoque_interno.inteiro(m->'quantidade',1,9007199254740991)
        and estoque_interno.inteiro(m->'ordemCadastro',0,9223372036854775807,true)
        and (not m ? 'compraOriginalId' or estoque_interno.uuid_valido(m->'compraOriginalId'));
    when 'entrega', 'retorno' then
      return m - (array['id','revisao','operacaoId','produtoId','data','conhecidos','tipo','quantidade','itemId']
        || case when m->>'tipo' = 'entrega' then array['custoUnitario'] else array[]::text[] end) = '{}'::jsonb
        and estoque_interno.inteiro(m->'quantidade',case when m->>'tipo' = 'entrega' then 0 else 1 end,9007199254740991)
        and estoque_interno.uuid_valido(m->'itemId');
    when 'saida' then
      return m - array['id','revisao','operacaoId','produtoId','data','conhecidos','tipo','quantidade','motivo'] = '{}'::jsonb
        and estoque_interno.inteiro(m->'quantidade',1,9007199254740991)
        and m->>'motivo' in ('perda','quebra','uso-pessoal','brinde');
    when 'anulacao' then
      return m - array['id','revisao','operacaoId','produtoId','data','conhecidos','tipo','alvo'] = '{}'::jsonb
        and estoque_interno.refs_validas(jsonb_build_array(m->'alvo'));
    when 'contagem' then
      if m - array['id','revisao','operacaoId','produtoId','data','conhecidos','tipo','totalContado','motivo','base','resolvidas'] <> '{}'::jsonb
        or not estoque_interno.inteiro(m->'totalContado',0,9007199254740991)
        or coalesce(m->>'motivo','') not in ('estoque-inicial','conferencia')
        or jsonb_typeof(m->'base') is distinct from 'array'
        or not estoque_interno.refs_validas(m->'resolvidas') then return false; end if;
      for e in select value from jsonb_array_elements(m->'base') loop
        if e - array['id','revisao','tipo','quantidade','aplicada','conhecidos'] <> '{}'::jsonb
          or not estoque_interno.refs_validas(jsonb_build_array(jsonb_build_object('id',e->'id','revisao',e->'revisao')))
          or e->>'tipo' not in ('compra','entrega','retorno','saida','contagem','anulacao')
          or not estoque_interno.inteiro(e->'quantidade',-9007199254740991,9007199254740991)
          or jsonb_typeof(e->'aplicada') is distinct from 'boolean'
          or not estoque_interno.refs_validas(e->'conhecidos') then return false; end if;
      end loop;
      return (select coalesce(jsonb_agg(jsonb_build_object('id',value->'id','revisao',value->'revisao')), '[]')
        from jsonb_array_elements(m->'base')) = m->'conhecidos'
        and not exists (select 1 from jsonb_array_elements(m->'resolvidas') r where not exists (
          select 1 from jsonb_array_elements(m->'base') b where b->'id'=r->'id' and b->'revisao'=r->'revisao'
            and b->>'tipo'='contagem' and b->'aplicada'='false'::jsonb));
    else return false;
  end case;
end
$$;

create table public.categorias (
  id uuid primary key,
  dono uuid not null default auth.uid(),
  nome text not null check (btrim(nome) <> ''),
  constraint categorias_id_dono unique (id,dono)
);
create table public.produtos (
  id uuid primary key,
  dono uuid not null default auth.uid(),
  nome text not null check (btrim(nome) <> ''),
  categoria_id uuid not null,
  marca text, codigo_catalogo text, foto_id uuid,
  custo_manual bigint check (custo_manual >= 0),
  preco_venda bigint check (preco_venda >= 0),
  estoque_minimo bigint check (estoque_minimo between 0 and 9007199254740991),
  atualizado_em timestamptz not null,
  recebido_em timestamptz not null default now(),
  constraint produtos_id_dono unique (id,dono),
  constraint produtos_categoria foreign key (categoria_id,dono) references public.categorias(id,dono)
);
create index produtos_por_chegada on public.produtos(dono,recebido_em);
create table estoque_interno.contadores (
  dono uuid primary key,
  ultimo bigint not null check (ultimo >= 0)
);
create table public.operacoes_estoque (
  id uuid primary key,
  dono uuid not null default auth.uid(),
  revisao bigint not null check (revisao between 1 and 9007199254740991),
  formato integer not null check (formato = 1),
  tipo text not null check (tipo in ('venda','entrega','cancelamento','retorno','correcao','movimento')),
  lancamentos jsonb not null check (estoque_interno.refs_validas(lancamentos)),
  movimentos jsonb not null check (estoque_interno.refs_validas(movimentos)),
  dependencias jsonb not null check (estoque_interno.refs_validas(dependencias)),
  alvo_id uuid, alvo_revisao bigint,
  -- Revisões locais anteriores nunca aceitas: evidência imutável, fora da projeção ativa (Q39).
  evidencias jsonb not null default '[]' check (jsonb_typeof(evidencias)='array'),
  encerramento_id uuid,
  recepcao bigint not null,
  constraint operacoes_estoque_id_revisao_dono unique(id,revisao,dono),
  constraint operacoes_estoque_alvo check ((alvo_id is null) = (alvo_revisao is null)),
  constraint operacoes_estoque_recepcao unique(dono,recepcao)
);
create unique index operacoes_estoque_um_alvo on public.operacoes_estoque(dono,alvo_id,alvo_revisao) where alvo_id is not null;

alter table public.lancamentos add column operacao_estoque_id uuid, add column revisao_estoque bigint;
alter table public.lancamentos add constraint lancamentos_operacao_estoque
  foreign key (operacao_estoque_id,revisao_estoque,dono) references public.operacoes_estoque(id,revisao,dono)
  deferrable initially deferred;
alter table public.lancamentos add constraint lancamentos_vinculo_estoque
  check ((operacao_estoque_id is null) = (revisao_estoque is null));
create index lancamentos_por_operacao_estoque on public.lancamentos(operacao_estoque_id);

create table public.movimentos_estoque (
  id uuid primary key,
  dono uuid not null default auth.uid(),
  revisao bigint not null check (revisao between 1 and 9007199254740991),
  operacao_id uuid not null,
  produto_id uuid not null,
  data date not null,
  tipo text not null,
  conhecidos jsonb not null,
  quantidade bigint, custo_unitario bigint, ordem_cadastro bigint, compra_original_id uuid,
  item_id uuid, motivo text, total_contado bigint, base jsonb, resolvidas jsonb,
  alvo_id uuid, alvo_revisao bigint,
  constraint movimentos_estoque_referencia unique(id,revisao,produto_id,dono),
  constraint movimentos_estoque_operacao foreign key (operacao_id) references public.operacoes_estoque(id) deferrable initially deferred,
  constraint movimentos_estoque_produto foreign key (produto_id,dono) references public.produtos(id,dono),
  constraint movimentos_estoque_anulacao foreign key (alvo_id,alvo_revisao,produto_id,dono)
    references public.movimentos_estoque(id,revisao,produto_id,dono) deferrable initially deferred,
  constraint movimentos_estoque_campos check (
    (tipo='compra') = (ordem_cadastro is not null)
    and (compra_original_id is null or tipo='compra')
    and (tipo in ('compra','entrega') or custo_unitario is null)
    and (tipo in ('compra','entrega','retorno','saida')) = (quantidade is not null)
    and (tipo in ('entrega','retorno')) = (item_id is not null)
    and (tipo in ('saida','contagem')) = (motivo is not null)
    and (tipo='contagem') = (total_contado is not null and base is not null and resolvidas is not null)
    and (tipo='contagem' or (total_contado is null and base is null and resolvidas is null))
    and (tipo='anulacao') = (alvo_id is not null and alvo_revisao is not null)
    and (tipo='anulacao' or (alvo_id is null and alvo_revisao is null))
  )
);
create unique index movimentos_estoque_uma_anulacao on public.movimentos_estoque(dono,alvo_id,alvo_revisao) where tipo='anulacao';
create index movimentos_estoque_por_produto on public.movimentos_estoque(dono,produto_id);
create index movimentos_estoque_por_operacao on public.movimentos_estoque(operacao_id);

create table public.encerramentos_estoque (
  id uuid primary key,
  dono uuid not null default auth.uid(),
  data date not null,
  tentativa jsonb not null,
  evidencia jsonb not null,
  aceitos_conhecidos jsonb not null,
  nova_operacao jsonb,
  recepcao bigint not null,
  constraint encerramentos_estoque_id_dono unique(id,dono),
  constraint encerramentos_estoque_recepcao unique(dono,recepcao)
);
alter table public.operacoes_estoque add constraint operacoes_estoque_encerramento
  foreign key(encerramento_id,dono) references public.encerramentos_estoque(id,dono);

create function estoque_interno.movimento_json(m public.movimentos_estoque) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('id',m.id,'revisao',m.revisao,'operacaoId',m.operacao_id,
    'produtoId',m.produto_id,'data',m.data,'tipo',m.tipo,'conhecidos',m.conhecidos,
    'quantidade',m.quantidade,'custoUnitario',m.custo_unitario::text,'ordemCadastro',m.ordem_cadastro::text,
    'compraOriginalId',m.compra_original_id,'itemId',m.item_id,'motivo',m.motivo,
    'totalContado',m.total_contado,'base',m.base,'resolvidas',m.resolvidas,
    'alvo',case when m.alvo_id is not null then jsonb_build_object('id',m.alvo_id,'revisao',m.alvo_revisao) end))
$$;
create function estoque_interno.lancamento_json(l public.lancamentos) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('id',l.id,'clienteId',l.cliente_id,'data',l.data,'tipo',l.tipo,
    'pagamento',l.pagamento,'forma',l.forma,'itens',l.itens,'desconto',l.desconto::text,'parcelas',l.parcelas,
    'valor',l.valor::text,'observacao',l.observacao,'estornaId',l.estorna_id,'motivo',l.motivo))
$$;
create function estoque_interno.grupo_json(o public.operacoes_estoque) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('operacao',jsonb_strip_nulls(jsonb_build_object('id',o.id,'revisao',o.revisao,
    'formato',o.formato,'tipo',o.tipo,'lancamentos',o.lancamentos,'movimentos',o.movimentos,'dependencias',o.dependencias,
    'alvo',case when o.alvo_id is not null then jsonb_build_object('id',o.alvo_id,'revisao',o.alvo_revisao) end)),
    'lancamentos',coalesce((select jsonb_agg(estoque_interno.lancamento_json(l) order by r.ordem)
      from jsonb_array_elements(o.lancamentos) with ordinality r(ref,ordem)
      join public.lancamentos l on l.id=(r.ref->>'id')::uuid and l.dono=o.dono), '[]'),
    'movimentos',coalesce((select jsonb_agg(estoque_interno.movimento_json(m) order by r.ordem)
      from jsonb_array_elements(o.movimentos) with ordinality r(ref,ordem)
      join public.movimentos_estoque m on m.id=(r.ref->>'id')::uuid and m.dono=o.dono), '[]'))
$$;
create function estoque_interno.encerramento_json(e public.encerramentos_estoque) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('id',e.id,'data',e.data,'tentativa',e.tentativa,'evidencia',e.evidencia,
    'aceitosConhecidos',e.aceitos_conhecidos,'novaOperacao',e.nova_operacao))
$$;

create function estoque_interno.ids_grupo(g jsonb) returns setof uuid
language sql immutable set search_path = '' as $$
  select (g->'operacao'->>'id')::uuid
  union all select (l->>'id')::uuid from jsonb_array_elements(g->'lancamentos') l
  union all select (p->>'id')::uuid from jsonb_array_elements(g->'lancamentos') l
    cross join lateral jsonb_array_elements(coalesce(l->'parcelas','[]')) p
  union all select (m->>'id')::uuid from jsonb_array_elements(g->'movimentos') m
$$;

create function estoque_interno.conferir_encerramento(e public.encerramentos_estoque) returns void
language plpgsql set search_path = '' as $$
declare g jsonb := e.evidencia->'grupo'; a jsonb;
begin
  perform estoque_interno.exigir(estoque_interno.uuid_valido(g->'operacao'->'id')
    and estoque_interno.inteiro(g->'operacao'->'revisao',1,9007199254740991)
    and e.tentativa->'id'=g->'operacao'->'id' and e.tentativa->'revisao'=g->'operacao'->'revisao'
    and jsonb_typeof(e.tentativa->'conteudo')='string' and e.evidencia->>'desfecho'='recusada'
    and jsonb_typeof(e.evidencia->'diagnostico')='string' and btrim(e.evidencia->>'diagnostico')<>''
    and jsonb_typeof(e.aceitos_conhecidos)='array', 'estoque_recusa_nao_confirmada');
  perform estoque_interno.exigir(not exists(select 1 from public.operacoes_estoque o where o.dono=e.dono
    and estoque_interno.grupo_json(o)=g),'estoque_tentativa_aceita');
  for a in select value from jsonb_array_elements(e.aceitos_conhecidos) loop
    perform estoque_interno.exigir(exists(select 1 from public.operacoes_estoque o where o.dono=e.dono
      and estoque_interno.grupo_json(o)=a),'estoque_aceite_desconhecido');
  end loop;
  if e.nova_operacao is not null then
    perform estoque_interno.exigir(estoque_interno.uuid_valido(e.nova_operacao->'operacao'->'id')
      and not exists(select 1 from estoque_interno.ids_grupo(e.nova_operacao) n
        join estoque_interno.ids_grupo(g) r on n=r), 'estoque_identidade_reutilizada');
  end if;
  perform estoque_interno.exigir(not exists(select 1 from public.encerramentos_estoque outra
    where outra.dono=e.dono and outra.id<>e.id and outra.evidencia->'grupo'=g),'estoque_tentativa_ja_encerrada');
end
$$;

-- Toda aceitação, inclusive por SQL direto, toma a mesma linha até commit/rollback (Q38/40).
create function estoque_interno.numerar() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into estoque_interno.contadores(dono,ultimo) values(new.dono,0) on conflict(dono) do nothing;
  update estoque_interno.contadores set ultimo=ultimo+1 where dono=new.dono returning ultimo into new.recepcao;
  return new;
end
$$;
create trigger operacoes_estoque_numerar before insert on public.operacoes_estoque for each row execute function estoque_interno.numerar();
create trigger encerramentos_estoque_numerar before insert on public.encerramentos_estoque for each row execute function estoque_interno.numerar();

create function estoque_interno.imutavel() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op='DELETE' or new is distinct from old then
    raise exception 'histórico de estoque imutável (D-057)' using errcode='23514', constraint='estoque_imutavel';
  end if;
  return new;
end
$$;
create trigger categorias_imutaveis before update or delete on public.categorias for each row execute function estoque_interno.imutavel();
create trigger operacoes_estoque_imutaveis before update or delete on public.operacoes_estoque for each row execute function estoque_interno.imutavel();
create trigger movimentos_estoque_imutaveis before update or delete on public.movimentos_estoque for each row execute function estoque_interno.imutavel();
create trigger encerramentos_estoque_imutaveis before update or delete on public.encerramentos_estoque for each row execute function estoque_interno.imutavel();
create trigger produtos_nao_se_apagam before delete on public.produtos for each row execute function public.cliente_nao_se_apaga();
create trigger produtos_ultimo_que_escreve before insert or update on public.produtos for each row execute function public.cliente_ultimo_que_escreve();

create function estoque_interno.proteger_financeiro() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' then
    perform estoque_interno.exigir((new.operacao_estoque_id,new.revisao_estoque,new.id) is not distinct from
      (old.operacao_estoque_id,old.revisao_estoque,old.id),'estoque_vinculo_imutavel');
  end if;
  if new.operacao_estoque_id is null then
    perform estoque_interno.exigir(not exists(select 1 from public.lancamentos l
      where l.dono=new.dono and l.operacao_estoque_id is not null and (l.id=new.id or l.id=new.estorna_id))
      and not exists(select 1 from jsonb_array_elements(coalesce(new.itens,'[]')) i
        where i ?| array['id','produtoId','quantidade','precoUnitario']), 'estoque_grupo_obrigatorio');
  end if;
  return new;
end
$$;
create trigger lancamentos_estoque_proteger before insert or update on public.lancamentos
  for each row execute function estoque_interno.proteger_financeiro();

create function estoque_interno.referencia_existe(conta uuid, ref jsonb) returns boolean
language sql stable set search_path = '' as $$
  select exists(select 1 from public.operacoes_estoque o where o.dono=conta and o.id=(ref->>'id')::uuid and o.revisao=(ref->>'revisao')::bigint)
    or exists(select 1 from public.movimentos_estoque m where m.dono=conta and m.id=(ref->>'id')::uuid and m.revisao=(ref->>'revisao')::bigint)
    or exists(select 1 from public.lancamentos l where l.dono=conta and l.id=(ref->>'id')::uuid and coalesce(l.revisao_estoque,1)=(ref->>'revisao')::bigint)
    or exists(select 1 from public.operacoes_estoque o cross join lateral jsonb_array_elements(o.evidencias) e
      where o.dono=conta and e->'id'=ref->'id' and e->'revisao'=ref->'revisao')
$$;

create function estoque_interno.conferir_grupo(conta uuid, operacao uuid) returns void
language plpgsql set search_path = '' as $$
#variable_conflict use_column
declare o public.operacoes_estoque; l public.lancamentos; m public.movimentos_estoque;
  i jsonb; r jsonb; e jsonb; observado jsonb; anterior public.movimentos_estoque;
begin
  select * into strict o from public.operacoes_estoque where dono=conta and id=operacao;
  perform estoque_interno.exigir(not exists(select 1 from estoque_interno.ids_grupo(estoque_interno.grupo_json(o)) identificador
    where identificador is null or (
      (select count(*) from public.operacoes_estoque x where x.dono=conta and x.id=identificador)
      +(select count(*) from public.movimentos_estoque x where x.dono=conta and x.id=identificador)
      +(select count(*) from public.lancamentos x where x.dono=conta and x.id=identificador)
      +(select count(*) from public.lancamentos x cross join lateral jsonb_array_elements(x.parcelas) p
        where x.dono=conta and p->>'id'=identificador::text))<>1),'estoque_identidade_reutilizada');
  perform estoque_interno.exigir(
    jsonb_array_length(o.lancamentos)=(select count(*) from public.lancamentos where dono=conta and operacao_estoque_id=o.id)
    and jsonb_array_length(o.movimentos)=(select count(*) from public.movimentos_estoque where dono=conta and operacao_id=o.id)
    and not exists(select 1 from jsonb_array_elements(o.lancamentos) r where not exists(select 1 from public.lancamentos l
      where l.dono=conta and l.id=(r->>'id')::uuid and l.operacao_estoque_id=o.id and l.revisao_estoque=(r->>'revisao')::bigint and l.revisao_estoque=o.revisao))
    and not exists(select 1 from jsonb_array_elements(o.movimentos) r where not exists(select 1 from public.movimentos_estoque m
      where m.dono=conta and m.id=(r->>'id')::uuid and m.operacao_id=o.id and m.revisao=(r->>'revisao')::bigint)), 'estoque_grupo_incompleto');

  for e in select value from jsonb_array_elements(o.evidencias) loop
    perform estoque_interno.exigir(estoque_interno.movimento_valido(e),'estoque_evidencia_invalida');
    select * into anterior from public.movimentos_estoque where id=(e->>'id')::uuid and dono=conta;
    perform estoque_interno.exigir(found and anterior.produto_id=(e->>'produtoId')::uuid
      and anterior.operacao_id=(e->>'operacaoId')::uuid and anterior.tipo=e->>'tipo'
      and anterior.revisao>(e->>'revisao')::bigint,'estoque_evidencia_sem_origem');
    perform estoque_interno.exigir(not exists(select 1 from public.operacoes_estoque x
      cross join lateral jsonb_array_elements(x.evidencias) y where x.dono=conta and y->'id'=e->'id'
      and y->'revisao'=e->'revisao' and y<>e),'estoque_evidencia_divergente');
  end loop;
  for r in select value from jsonb_array_elements(o.dependencias) loop
    perform estoque_interno.exigir(estoque_interno.referencia_existe(conta,r)
      and not (r->>'id'=o.id::text and (r->>'revisao')::bigint=o.revisao)
      and not (o.lancamentos @> jsonb_build_array(r) or o.movimentos @> jsonb_build_array(r)), 'estoque_dependencia_ausente');
  end loop;
  if o.alvo_id is not null then
    perform estoque_interno.exigir(exists(select 1 from public.lancamentos l where l.dono=conta and l.id=o.alvo_id
      and coalesce(l.revisao_estoque,1)=o.alvo_revisao and l.operacao_estoque_id is distinct from o.id)
      or exists(select 1 from public.movimentos_estoque m where m.dono=conta and m.id=o.alvo_id
        and m.revisao=o.alvo_revisao and m.operacao_id<>o.id),'estoque_alvo_invalido');
  end if;
  perform estoque_interno.exigir(case o.tipo
    when 'venda' then (select count(*)=1 and bool_and(tipo='venda') from public.lancamentos where operacao_estoque_id=o.id)
      and not exists(select 1 from public.movimentos_estoque where operacao_id=o.id and tipo<>'entrega')
    when 'entrega' then o.lancamentos='[]'::jsonb and o.movimentos<>'[]'::jsonb
      and not exists(select 1 from public.movimentos_estoque where operacao_id=o.id and tipo<>'entrega')
    when 'cancelamento' then (select count(*)=1 and bool_and(tipo='estorno' and estorna_id=o.alvo_id)
      from public.lancamentos where operacao_estoque_id=o.id) and o.alvo_id is not null
      and not exists(select 1 from public.movimentos_estoque where operacao_id=o.id and tipo<>'retorno')
    when 'retorno' then o.lancamentos='[]'::jsonb
      and not exists(select 1 from public.movimentos_estoque where operacao_id=o.id and tipo<>'retorno')
    when 'movimento' then o.lancamentos='[]'::jsonb and o.movimentos<>'[]'::jsonb and o.alvo_id is null
      and not exists(select 1 from public.movimentos_estoque where operacao_id=o.id and tipo not in ('compra','saida','contagem'))
    when 'correcao' then o.alvo_id is not null and ((o.lancamentos='[]'::jsonb and o.movimentos<>'[]'::jsonb
      and exists(select 1 from public.movimentos_estoque a where a.operacao_id=o.id and a.tipo='anulacao'
        and a.alvo_id=o.alvo_id and a.alvo_revisao=o.alvo_revisao)) or (
      (select count(*)=2 and count(*) filter(where tipo='venda')=1 and count(*) filter(where tipo='estorno' and estorna_id=o.alvo_id)=1
        from public.lancamentos where operacao_estoque_id=o.id)))
    else false end,'estoque_tipo_incompativel');

  for l in select * from public.lancamentos where operacao_estoque_id=o.id loop
    if l.tipo='venda' then
      perform estoque_interno.exigir(public.soma_itens(l.itens)>l.desconto,'estoque_venda_gratuita');
      perform estoque_interno.exigir((select count(*)=count(distinct value->>'id') from jsonb_array_elements(l.itens)), 'estoque_item_repetido');
      for i in select value from jsonb_array_elements(l.itens) loop
        perform estoque_interno.exigir(estoque_interno.uuid_valido(i->'id')
          and estoque_interno.inteiro(i->'quantidade',1,9007199254740991)
          and estoque_interno.inteiro(i->'precoUnitario',0,9223372036854775807,true)
          and estoque_interno.inteiro(i->'preco',0,9223372036854775807,true)
          and (i->>'preco')::bigint=(i->>'quantidade')::bigint*(i->>'precoUnitario')::bigint,'estoque_item_invalido');
        if i ? 'produtoId' then
          perform estoque_interno.exigir(estoque_interno.uuid_valido(i->'produtoId') and exists(select 1 from public.produtos p
            where p.dono=conta and p.id=(i->>'produtoId')::uuid),'estoque_item_produto');
        end if;
        perform estoque_interno.exigir(not exists(select 1 from public.lancamentos velha
          cross join lateral jsonb_array_elements(velha.itens) v where velha.dono=conta and velha.tipo='venda'
          and (velha.operacao_estoque_id is null or exists(select 1 from public.operacoes_estoque anterior
            where anterior.id=velha.operacao_estoque_id and anterior.recepcao<o.recepcao))
          and velha.id<>l.id and v->'id'=i->'id' and (o.alvo_id is null or not exists(
            select 1 from public.lancamentos alvo cross join lateral jsonb_array_elements(alvo.itens) a
            where alvo.id=o.alvo_id and alvo.dono=conta and a->'id'=i->'id'))),'estoque_item_reutilizado');
      end loop;
      if o.tipo='correcao' then
        perform estoque_interno.exigir(exists(select 1 from public.lancamentos alvo where alvo.dono=conta and alvo.id=o.alvo_id
          and alvo.tipo='venda' and jsonb_array_length(alvo.itens)=jsonb_array_length(l.itens)
          and not exists(select 1 from jsonb_array_elements(alvo.itens) a where not exists(
            select 1 from jsonb_array_elements(l.itens) novo where novo->'id'=a->'id'))),'estoque_itens_da_correcao');
        perform estoque_interno.exigir(not exists(select 1 from public.movimentos_estoque entrega
          join lateral jsonb_array_elements(l.itens) novo on novo->>'id'=entrega.item_id::text
          where entrega.dono=conta and entrega.tipo='entrega' and entrega.quantidade>0
            and novo->>'produtoId' is distinct from entrega.produto_id::text
            and not exists(select 1 from public.movimentos_estoque a where a.dono=conta and a.alvo_id=entrega.id)), 'estoque_correcao_sem_efeito_fisico');
      end if;
    end if;
  end loop;
  for m in select * from public.movimentos_estoque where operacao_id=o.id loop
    perform estoque_interno.exigir(m.dono=conta and estoque_interno.movimento_valido(estoque_interno.movimento_json(m)), 'estoque_movimento_invalido');
    for r in select value from jsonb_array_elements(m.conhecidos) loop
      perform estoque_interno.exigir(not (r->>'id'=m.id::text and (r->>'revisao')::bigint=m.revisao)
        and exists(select 1 from public.movimentos_estoque x where x.dono=conta and x.produto_id=m.produto_id
          and x.id=(r->>'id')::uuid and (x.revisao=(r->>'revisao')::bigint or exists(
            select 1 from public.operacoes_estoque z cross join lateral jsonb_array_elements(z.evidencias) e
            where z.dono=conta and e->'id'=r->'id' and e->'revisao'=r->'revisao'))),'estoque_causa_invalida');
    end loop;
    if m.tipo in ('entrega','retorno') then
      perform estoque_interno.exigir(exists(select 1 from public.lancamentos l cross join lateral jsonb_array_elements(l.itens) i
        where l.dono=conta and l.tipo='venda' and i->>'id'=m.item_id::text and i->>'produtoId'=m.produto_id::text),'estoque_item_inexistente');
    end if;
    if m.tipo='retorno' then
      perform estoque_interno.exigir(not exists(select 1 from public.lancamentos l cross join lateral jsonb_array_elements(l.itens) i
        where l.dono=conta and l.tipo='venda' and i->>'id'=m.item_id::text
        and not exists(select 1 from public.lancamentos est where est.dono=conta and est.estorna_id=l.id)), 'estoque_retorno_sem_cancelamento');
    end if;
    if m.tipo='anulacao' then
      perform estoque_interno.exigir(exists(select 1 from public.movimentos_estoque a where a.id=m.alvo_id and a.dono=conta
        and a.revisao=m.alvo_revisao and a.produto_id=m.produto_id and a.tipo<>'anulacao'),'estoque_anulacao_invalida');
    end if;
    if m.tipo='entrega' then
      perform estoque_interno.exigir(not exists(select 1 from public.movimentos_estoque a
        join public.movimentos_estoque velha on velha.id=a.alvo_id and velha.dono=conta
        where a.operacao_id=o.id and velha.tipo='entrega' and velha.item_id=m.item_id and velha.produto_id=m.produto_id
          and velha.custo_unitario is distinct from m.custo_unitario),'estoque_custo_historico');
    end if;
    if m.compra_original_id is not null then
      perform estoque_interno.exigir(exists(select 1 from public.movimentos_estoque a where a.dono=conta
        and a.id=m.compra_original_id and a.tipo='compra' and a.ordem_cadastro=m.ordem_cadastro),'estoque_ordem_original');
    end if;
    if m.tipo='contagem' then
      for e in select value from jsonb_array_elements(m.base) loop
        select estoque_interno.movimento_json(x) into observado from public.movimentos_estoque x
          where x.dono=conta and x.id=(e->>'id')::uuid and x.revisao=(e->>'revisao')::bigint and x.produto_id=m.produto_id;
        if not found then
          select x into observado from public.operacoes_estoque z cross join lateral jsonb_array_elements(z.evidencias) x
            where z.dono=conta and x->'id'=e->'id' and x->'revisao'=e->'revisao' and x->>'produtoId'=m.produto_id::text limit 1;
        end if;
        perform estoque_interno.exigir(observado is not null and observado->'tipo'=e->'tipo'
          and observado->'conhecidos'=e->'conhecidos'
          and (e->>'quantidade')::bigint=case observado->>'tipo'
            when 'compra' then (observado->>'quantidade')::bigint when 'retorno' then (observado->>'quantidade')::bigint
            when 'entrega' then -(observado->>'quantidade')::bigint when 'saida' then -(observado->>'quantidade')::bigint
            when 'anulacao' then 0 when 'contagem' then (observado->>'totalContado')::bigint-coalesce((select sum((b->>'quantidade')::bigint)
              from jsonb_array_elements(observado->'base') b where (b->>'aplicada')::boolean),0) end,'estoque_base_divergente');
      end loop;
    end if;
  end loop;
  -- Causalidade usa referências, inclusive fotografias de revisões locais não enviadas.
  perform estoque_interno.exigir(not exists(
    with documentos as (
      select estoque_interno.movimento_json(x) doc from public.movimentos_estoque x where x.dono=conta
      union select e from public.operacoes_estoque x cross join lateral jsonb_array_elements(x.evidencias) e where x.dono=conta
    ) select 1 from documentos d cross join lateral jsonb_array_elements(d.doc->'conhecidos') ref
      where not exists(select 1 from documentos alvo where alvo.doc->'id'=ref->'id'
        and alvo.doc->'revisao'=ref->'revisao' and alvo.doc->'produtoId'=d.doc->'produtoId')
  ),'estoque_causa_invalida');
  perform estoque_interno.exigir(not exists(
    with recursive documentos as (
      select estoque_interno.movimento_json(x) doc from public.movimentos_estoque x where x.dono=conta
      union select e from public.operacoes_estoque x cross join lateral jsonb_array_elements(x.evidencias) e where x.dono=conta
    ), caminhos(doc,visitados,ciclo) as (
      select doc,array[doc->>'id'||'/'||(doc->>'revisao')],false from documentos where doc->>'operacaoId'=o.id::text
      union all select alvo.doc,c.visitados||(alvo.doc->>'id'||'/'||(alvo.doc->>'revisao')),
        (alvo.doc->>'id'||'/'||(alvo.doc->>'revisao'))=any(c.visitados)
        from caminhos c cross join lateral jsonb_array_elements(c.doc->'conhecidos') ref
        join documentos alvo on alvo.doc->'id'=ref->'id' and alvo.doc->'revisao'=ref->'revisao' where not c.ciclo
    ) select 1 from caminhos where ciclo
  ),'estoque_causa_ciclica');
  -- A trava do contador ainda pertence a esta transação ao conferir o limite acumulado (Q40).
  perform estoque_interno.exigir(not exists(select 1 from public.movimentos_estoque m where m.dono=conta
    and m.tipo in ('entrega','retorno') and not exists(select 1 from public.movimentos_estoque a where a.dono=conta and a.alvo_id=m.id)
    group by m.item_id,m.produto_id having sum(case m.tipo when 'entrega' then m.quantidade else -m.quantidade end)<0), 'estoque_excede_retorno');
end
$$;

create function estoque_interno.conferir_grupo_apos_escrita() returns trigger
language plpgsql security definer set search_path = '' as $$
declare operacao uuid;
begin
  if tg_table_name='operacoes_estoque' then operacao := new.id;
  elsif tg_table_name='lancamentos' then operacao := new.operacao_estoque_id;
  else operacao := new.operacao_id; end if;
  perform estoque_interno.conferir_grupo(new.dono,operacao);
  return null;
end
$$;
create constraint trigger operacoes_estoque_completas after insert on public.operacoes_estoque
  deferrable initially deferred for each row execute function estoque_interno.conferir_grupo_apos_escrita();
create constraint trigger movimentos_estoque_completos after insert on public.movimentos_estoque
  deferrable initially deferred for each row execute function estoque_interno.conferir_grupo_apos_escrita();
create constraint trigger lancamentos_estoque_completos after insert on public.lancamentos
  deferrable initially deferred for each row when (new.operacao_estoque_id is not null) execute function estoque_interno.conferir_grupo_apos_escrita();

create function estoque_interno.conferir_encerramento_apos_escrita() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform estoque_interno.conferir_encerramento(new);
  return null;
end
$$;
create constraint trigger encerramentos_estoque_validos after insert on public.encerramentos_estoque
  deferrable initially deferred for each row execute function estoque_interno.conferir_encerramento_apos_escrita();

create function public.gravar_categoria_estoque(cadastro jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare conta uuid := auth.uid(); anterior public.categorias;
begin
  perform estoque_interno.exigir(conta is not null,'estoque_sessao_obrigatoria');
  perform estoque_interno.exigir(estoque_interno.uuid_valido(cadastro->'id') and cadastro - array['id','nome']='{}'::jsonb
    and jsonb_typeof(cadastro->'nome')='string' and btrim(cadastro->>'nome')<>'','estoque_categoria_invalida');
  insert into public.categorias(id,dono,nome) values((cadastro->>'id')::uuid,conta,cadastro->>'nome') on conflict(id) do nothing;
  select * into anterior from public.categorias where id=(cadastro->>'id')::uuid;
  perform estoque_interno.exigir(anterior.dono=conta and anterior.nome=cadastro->>'nome','estoque_categoria_divergente');
  return anterior.id;
end
$$;
create function public.gravar_produto_estoque(cadastro jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare conta uuid := auth.uid(); id_produto uuid;
begin
  perform estoque_interno.exigir(conta is not null,'estoque_sessao_obrigatoria');
  perform estoque_interno.exigir(cadastro - array['id','nome','categoriaId','marca','codigoCatalogo','fotoId','custoManual','precoVenda','estoqueMinimo','atualizadoEm']='{}'::jsonb
    and estoque_interno.uuid_valido(cadastro->'id') and estoque_interno.uuid_valido(cadastro->'categoriaId')
    and jsonb_typeof(cadastro->'nome')='string' and btrim(cadastro->>'nome')<>''
    and jsonb_typeof(cadastro->'atualizadoEm')='string','estoque_produto_invalido');
  if cadastro ? 'fotoId' then perform estoque_interno.exigir(estoque_interno.uuid_valido(cadastro->'fotoId'),'estoque_foto_invalida'); end if;
  if cadastro ? 'custoManual' then perform estoque_interno.exigir(estoque_interno.inteiro(cadastro->'custoManual',0,9223372036854775807,true),'estoque_custo_invalido'); end if;
  if cadastro ? 'precoVenda' then perform estoque_interno.exigir(estoque_interno.inteiro(cadastro->'precoVenda',0,9223372036854775807,true),'estoque_preco_invalido'); end if;
  if cadastro ? 'estoqueMinimo' then perform estoque_interno.exigir(estoque_interno.inteiro(cadastro->'estoqueMinimo',0,9007199254740991),'estoque_minimo_invalido'); end if;
  id_produto := (cadastro->>'id')::uuid;
  perform estoque_interno.exigir(not exists(select 1 from public.produtos where id=id_produto and dono<>conta),'estoque_conta_invalida');
  insert into public.produtos(id,dono,nome,categoria_id,marca,codigo_catalogo,foto_id,custo_manual,preco_venda,estoque_minimo,atualizado_em)
    values(id_produto,conta,cadastro->>'nome',(cadastro->>'categoriaId')::uuid,cadastro->>'marca',cadastro->>'codigoCatalogo',
      (cadastro->>'fotoId')::uuid,(cadastro->>'custoManual')::bigint,(cadastro->>'precoVenda')::bigint,
      (cadastro->>'estoqueMinimo')::bigint,(cadastro->>'atualizadoEm')::timestamptz)
    on conflict(id) do update set nome=excluded.nome,categoria_id=excluded.categoria_id,marca=excluded.marca,
      codigo_catalogo=excluded.codigo_catalogo,foto_id=excluded.foto_id,custo_manual=excluded.custo_manual,
      preco_venda=excluded.preco_venda,estoque_minimo=excluded.estoque_minimo,atualizado_em=excluded.atualizado_em;
  return id_produto;
end
$$;

create function public.aceitar_grupo_estoque(grupo jsonb, evidencias jsonb default '[]', encerramento_id uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare conta uuid := auth.uid(); op jsonb := grupo->'operacao'; o public.operacoes_estoque;
  l jsonb; m jsonb; ref jsonb; identificador uuid; posicao bigint;
begin
  perform estoque_interno.exigir(conta is not null,'estoque_sessao_obrigatoria');
  perform estoque_interno.exigir(grupo - array['operacao','lancamentos','movimentos']='{}'::jsonb
    and op - array['id','revisao','formato','tipo','lancamentos','movimentos','dependencias','alvo']='{}'::jsonb
    and estoque_interno.uuid_valido(op->'id') and estoque_interno.inteiro(op->'revisao',1,9007199254740991)
    and op->'formato'='1'::jsonb and estoque_interno.refs_validas(op->'lancamentos')
    and estoque_interno.refs_validas(op->'movimentos') and estoque_interno.refs_validas(op->'dependencias')
    and jsonb_typeof(grupo->'lancamentos')='array' and jsonb_typeof(grupo->'movimentos')='array'
    and jsonb_typeof(evidencias)='array','estoque_formato_invalido');
  if op ? 'alvo' then perform estoque_interno.exigir(estoque_interno.refs_validas(jsonb_build_array(op->'alvo')),'estoque_alvo_invalido'); end if;
  identificador := (op->>'id')::uuid;
  -- Mesmo a retentativa disputa a linha do contador antes de consultar o aceite anterior.
  insert into estoque_interno.contadores(dono,ultimo) values(conta,0) on conflict(dono) do nothing;
  perform 1 from estoque_interno.contadores where dono=conta for update;
  select * into o from public.operacoes_estoque where id=identificador;
  if found then
    perform estoque_interno.exigir(o.dono=conta and estoque_interno.grupo_json(o)=grupo
      and o.evidencias=evidencias and o.encerramento_id is not distinct from encerramento_id,'estoque_conteudo_divergente');
    return o.recepcao::text;
  end if;
  if encerramento_id is not null then
    perform estoque_interno.exigir(exists(select 1 from public.encerramentos_estoque e where e.dono=conta
      and e.id=encerramento_id and e.nova_operacao->'operacao'->>'id'=identificador::text),'estoque_encerramento_invalido');
    perform estoque_interno.exigir(not exists(select 1 from public.encerramentos_estoque e
      cross join lateral estoque_interno.ids_grupo(e.evidencia->'grupo') antigo
      join estoque_interno.ids_grupo(grupo) novo on antigo=novo
      where e.dono=conta and e.id=encerramento_id),'estoque_identidade_reutilizada');
  end if;
  perform estoque_interno.exigir(not exists(select 1 from public.encerramentos_estoque e where e.dono=conta
    and e.evidencia->'grupo'=grupo),'estoque_tentativa_ja_encerrada');
  insert into public.operacoes_estoque(id,dono,revisao,formato,tipo,lancamentos,movimentos,dependencias,alvo_id,alvo_revisao,evidencias,encerramento_id)
    values(identificador,conta,(op->>'revisao')::bigint,1,op->>'tipo',op->'lancamentos',op->'movimentos',op->'dependencias',
      (op->'alvo'->>'id')::uuid,(op->'alvo'->>'revisao')::bigint,evidencias,encerramento_id) returning recepcao into posicao;
  for l in select value from jsonb_array_elements(grupo->'lancamentos') loop
    perform estoque_interno.exigir(l - array['id','clienteId','data','tipo','pagamento','forma','itens','desconto','parcelas','valor','observacao','estornaId','motivo']='{}'::jsonb,'estoque_lancamento_invalido');
    if l ? 'valor' then perform estoque_interno.exigir(estoque_interno.inteiro(l->'valor',1,9223372036854775807,true),'estoque_valor_invalido'); end if;
    if l ? 'desconto' then perform estoque_interno.exigir(estoque_interno.inteiro(l->'desconto',0,9223372036854775807,true),'estoque_desconto_invalido'); end if;
    for ref in select value from jsonb_array_elements(coalesce(l->'parcelas','[]')) loop
      perform estoque_interno.exigir(estoque_interno.inteiro(ref->'valor',0,9223372036854775807,true),'estoque_parcela_invalida');
    end loop;
    insert into public.lancamentos(id,dono,cliente_id,data,tipo,pagamento,forma,itens,desconto,parcelas,valor,observacao,estorna_id,motivo,operacao_estoque_id,revisao_estoque)
      values((l->>'id')::uuid,conta,(l->>'clienteId')::uuid,(l->>'data')::date,l->>'tipo',l->>'pagamento',l->>'forma',l->'itens',
        (l->>'desconto')::bigint,l->'parcelas',(l->>'valor')::bigint,l->>'observacao',(l->>'estornaId')::uuid,l->>'motivo',identificador,(op->>'revisao')::bigint);
  end loop;
  for m in select value from jsonb_array_elements(grupo->'movimentos') loop
    perform estoque_interno.exigir(estoque_interno.movimento_valido(m) and m->>'operacaoId'=identificador::text,'estoque_movimento_invalido');
    insert into public.movimentos_estoque(id,dono,revisao,operacao_id,produto_id,data,tipo,conhecidos,quantidade,custo_unitario,ordem_cadastro,compra_original_id,
      item_id,motivo,total_contado,base,resolvidas,alvo_id,alvo_revisao)
      values((m->>'id')::uuid,conta,(m->>'revisao')::bigint,identificador,(m->>'produtoId')::uuid,(m->>'data')::date,m->>'tipo',m->'conhecidos',
        (m->>'quantidade')::bigint,(m->>'custoUnitario')::bigint,(m->>'ordemCadastro')::bigint,(m->>'compraOriginalId')::uuid,
        (m->>'itemId')::uuid,m->>'motivo',(m->>'totalContado')::bigint,m->'base',m->'resolvidas',(m->'alvo'->>'id')::uuid,(m->'alvo'->>'revisao')::bigint);
  end loop;
  perform estoque_interno.conferir_grupo(conta,identificador);
  select * into o from public.operacoes_estoque where id=identificador;
  perform estoque_interno.exigir(estoque_interno.grupo_json(o)=grupo,'estoque_formato_divergente');
  return posicao::text;
end
$$;

create function public.gravar_encerramento_estoque(encerramento jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare conta uuid := auth.uid(); e public.encerramentos_estoque; g jsonb := encerramento->'evidencia'->'grupo'; a jsonb;
begin
  perform estoque_interno.exigir(conta is not null,'estoque_sessao_obrigatoria');
  insert into estoque_interno.contadores(dono,ultimo) values(conta,0) on conflict(dono) do nothing;
  perform 1 from estoque_interno.contadores where dono=conta for update;
  select * into e from public.encerramentos_estoque where id=(encerramento->>'id')::uuid;
  if found then
    perform estoque_interno.exigir(e.dono=conta and estoque_interno.encerramento_json(e)=encerramento,'estoque_encerramento_divergente');
    return jsonb_build_object('id',e.id,'recepcao',e.recepcao::text);
  end if;
  perform estoque_interno.exigir(estoque_interno.uuid_valido(encerramento->'id')
    and encerramento->'tentativa'->'id'=g->'operacao'->'id'
    and encerramento->'tentativa'->'revisao'=g->'operacao'->'revisao'
    and jsonb_typeof(encerramento->'tentativa'->'conteudo')='string'
    and encerramento->'evidencia'->>'desfecho'='recusada'
    and btrim(encerramento->'evidencia'->>'diagnostico')<>''
    and jsonb_typeof(encerramento->'aceitosConhecidos')='array','estoque_recusa_nao_confirmada');
  perform estoque_interno.exigir(not exists(select 1 from public.operacoes_estoque o where o.dono=conta
    and estoque_interno.grupo_json(o)=g),'estoque_tentativa_aceita');
  for a in select value from jsonb_array_elements(encerramento->'aceitosConhecidos') loop
    perform estoque_interno.exigir(exists(select 1 from public.operacoes_estoque o where o.dono=conta
      and estoque_interno.grupo_json(o)=a),'estoque_aceite_desconhecido');
  end loop;
  select * into e from public.encerramentos_estoque where dono=conta and evidencia->'grupo'=g;
  if found then return jsonb_build_object('id',e.id,'recepcao',e.recepcao::text); end if;
  insert into public.encerramentos_estoque(id,dono,data,tentativa,evidencia,aceitos_conhecidos,nova_operacao)
    values((encerramento->>'id')::uuid,conta,(encerramento->>'data')::date,encerramento->'tentativa',
      encerramento->'evidencia',encerramento->'aceitosConhecidos',encerramento->'novaOperacao') returning * into e;
  perform estoque_interno.conferir_encerramento(e);
  perform estoque_interno.exigir(estoque_interno.encerramento_json(e)=encerramento,'estoque_encerramento_invalido');
  return jsonb_build_object('id',e.id,'recepcao',e.recepcao::text);
end
$$;

-- Uma página contém registros completos. O cursor é TEXTO, inclusive acima de 2^53 (D-022).
create function public.baixar_estoque(apos text default '0', limite integer default 500) returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform estoque_interno.exigir(auth.uid() is not null,'estoque_sessao_obrigatoria');
  perform estoque_interno.exigir(apos ~ '^[0-9]+$' and limite between 1 and 500,'estoque_pagina_invalida');
  return query select x.registro from (
    select o.recepcao,jsonb_build_object('recepcao',o.recepcao::text,'tipo','operacao','grupo',estoque_interno.grupo_json(o),
      'evidencias',o.evidencias,'encerramentoId',o.encerramento_id) registro from public.operacoes_estoque o where o.dono=auth.uid() and o.recepcao>apos::bigint
    union all select e.recepcao,jsonb_build_object('recepcao',e.recepcao::text,'tipo','encerramento','encerramento',estoque_interno.encerramento_json(e))
      from public.encerramentos_estoque e where e.dono=auth.uid() and e.recepcao>apos::bigint
  ) x order by x.recepcao limit limite;
end
$$;

-- F2 só escreve pelas RPCs: não há uma permissão de tabela que permita aceitar meio grupo.
do $$
declare tabela text;
begin
  foreach tabela in array array['categorias','produtos','operacoes_estoque','movimentos_estoque','encerramentos_estoque'] loop
    execute format('alter table public.%I enable row level security',tabela);
    execute format('alter table public.%I force row level security',tabela);
    execute format('revoke all on public.%I from public, anon, authenticated',tabela);
    execute format('grant select on public.%I to authenticated',tabela);
    execute format('create policy estoque_ler_propria_conta on public.%I for select to authenticated using (dono=auth.uid())',tabela);
  end loop;
end
$$;
revoke all on all functions in schema estoque_interno from public, anon, authenticated;
revoke all on function public.gravar_categoria_estoque(jsonb), public.gravar_produto_estoque(jsonb),
  public.aceitar_grupo_estoque(jsonb,jsonb,uuid), public.gravar_encerramento_estoque(jsonb), public.baixar_estoque(text,integer) from public, anon;
grant execute on function public.gravar_categoria_estoque(jsonb), public.gravar_produto_estoque(jsonb),
  public.aceitar_grupo_estoque(jsonb,jsonb,uuid), public.gravar_encerramento_estoque(jsonb), public.baixar_estoque(text,integer) to authenticated;
