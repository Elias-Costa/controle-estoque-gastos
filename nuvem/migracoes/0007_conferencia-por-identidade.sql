-- E-28/Q47A: cada aceite já traz seu id. Buscar a linha antes de reconstruir o grupo
-- evita varrer todo o histórico para cada aceite; conteúdo e dono continuam obrigatórios.
create function estoque_interno.grupo_aceito(conta uuid, grupo jsonb) returns boolean
language sql stable set search_path = '' as $$
  select exists(select 1 from public.operacoes_estoque o where o.dono=conta
    and o.id=case when estoque_interno.uuid_valido(grupo->'operacao'->'id')
      then (grupo->'operacao'->>'id')::uuid end
    and estoque_interno.grupo_json(o)=grupo)
$$;

create or replace function estoque_interno.conferir_encerramento(e public.encerramentos_estoque) returns void
language plpgsql set search_path = '' as $$
declare g jsonb := e.evidencia->'grupo'; a jsonb;
begin
  perform estoque_interno.exigir(estoque_interno.uuid_valido(g->'operacao'->'id')
    and estoque_interno.inteiro(g->'operacao'->'revisao',1,9007199254740991)
    and e.tentativa->'id'=g->'operacao'->'id' and e.tentativa->'revisao'=g->'operacao'->'revisao'
    and jsonb_typeof(e.tentativa->'conteudo')='string' and e.evidencia->>'desfecho'='recusada'
    and jsonb_typeof(e.evidencia->'diagnostico')='string' and btrim(e.evidencia->>'diagnostico')<>''
    and jsonb_typeof(e.aceitos_conhecidos)='array', 'estoque_recusa_nao_confirmada');
  perform estoque_interno.exigir(not estoque_interno.grupo_aceito(e.dono,g),'estoque_tentativa_aceita');
  for a in select value from jsonb_array_elements(e.aceitos_conhecidos) loop
    perform estoque_interno.exigir(estoque_interno.grupo_aceito(e.dono,a),'estoque_aceite_desconhecido');
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

create or replace function public.gravar_encerramento_estoque(encerramento jsonb) returns jsonb
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
  perform estoque_interno.exigir(not estoque_interno.grupo_aceito(conta,g),'estoque_tentativa_aceita');
  for a in select value from jsonb_array_elements(encerramento->'aceitosConhecidos') loop
    perform estoque_interno.exigir(estoque_interno.grupo_aceito(conta,a),'estoque_aceite_desconhecido');
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
