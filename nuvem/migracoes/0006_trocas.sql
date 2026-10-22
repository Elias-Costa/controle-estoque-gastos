-- D-059: extensão aditiva. Nenhum dado existente é reescrito; publicar somente depois desta migration.
alter table public.operacoes_estoque drop constraint operacoes_estoque_tipo_check;
alter table public.operacoes_estoque add constraint operacoes_estoque_tipo_check
  check (tipo in ('venda','entrega','cancelamento','retorno','correcao','movimento','troca'));

create function estoque_interno.conferir_troca(conta uuid, operacao uuid) returns void
language plpgsql set search_path = '' as $$
#variable_conflict use_column
declare o public.operacoes_estoque; antiga public.lancamentos; nova public.lancamentos;
  i jsonb; n jsonb; p jsonb; indice bigint; retirada bigint; total_retirado bigint := 0;
  bruto_mantido numeric := 0; bruto_antigo numeric; desconto_esperado bigint; total_novo bigint;
  comum bigint; recebido numeric; anterior numeric; custo_esperado bigint; m public.movimentos_estoque;
begin
  select * into strict o from public.operacoes_estoque where dono=conta and id=operacao;
  select * into strict antiga from public.lancamentos where dono=conta and id=o.alvo_id;
  select * into nova from public.lancamentos where dono=conta and operacao_estoque_id=o.id and tipo='venda';
  perform estoque_interno.exigir(antiga.tipo='venda' and o.revisao=1 and o.evidencias='[]'::jsonb,
    'estoque_troca_alvo');
  perform estoque_interno.exigir(not exists(select 1 from public.lancamentos e where e.dono=conta
    and e.estorna_id=antiga.id and e.operacao_estoque_id is distinct from o.id),'estoque_troca_alvo');
  -- D-059 conserva a guarda de parcela paga; a alocação segue vencimento/data/id/posição de F1.
  if antiga.pagamento='fiado' then
    select coalesce(sum(l.valor),0) into recebido from public.lancamentos l
      where l.dono=conta and l.cliente_id=antiga.cliente_id and l.tipo in ('recebimento','desconto-quitacao')
      and l.operacao_estoque_id is distinct from o.id
      and not exists(select 1 from public.lancamentos e where e.dono=conta and e.estorna_id=l.id
        and e.operacao_estoque_id is distinct from o.id);
    for p,indice in select value,ordinality from jsonb_array_elements(antiga.parcelas) with ordinality loop
      select coalesce(sum((parcela->>'valor')::numeric),0) into anterior
        from public.lancamentos l cross join lateral jsonb_array_elements(l.parcelas) with ordinality as pp(parcela,posicao)
        where l.dono=conta and l.cliente_id=antiga.cliente_id and l.operacao_estoque_id is distinct from o.id
        and (l.tipo='saldo-anterior' or l.tipo='venda' and l.pagamento='fiado')
        and not exists(select 1 from public.lancamentos e where e.dono=conta and e.estorna_id=l.id
          and e.operacao_estoque_id is distinct from o.id)
        and (parcela->>'vencimento',l.data,l.id,pp.posicao)<(p->>'vencimento',antiga.data,antiga.id,indice);
      perform estoque_interno.exigir((p->>'valor')::bigint=0 or recebido<=anterior,'estoque_troca_parcela_paga');
    end loop;
  end if;
  if nova.id is not null then
    perform estoque_interno.exigir(nova.cliente_id=antiga.cliente_id and nova.data=antiga.data
      and nova.pagamento=antiga.pagamento and nova.forma is not distinct from antiga.forma,'estoque_troca_financeiro');
  end if;
  for i in select value from jsonb_array_elements(antiga.itens) loop
    n := null;
    select value into n from jsonb_array_elements(coalesce(nova.itens,'[]')) where value->'id'=i->'id';
    retirada := (i->>'quantidade')::bigint-coalesce((n->>'quantidade')::bigint,0);
    perform estoque_interno.exigir(retirada between 0 and (i->>'quantidade')::bigint,'estoque_troca_quantidade');
    if n is not null then
      perform estoque_interno.exigir(n->'produtoId' is not distinct from i->'produtoId'
        and n->'precoUnitario'=i->'precoUnitario' and n->'descricao'=i->'descricao','estoque_troca_item_mantido');
      bruto_mantido := bruto_mantido+(n->>'preco')::numeric;
    end if;
    total_retirado := total_retirado+retirada;
    if i ? 'produtoId' then
      perform estoque_interno.exigir(retirada=coalesce((select sum(m.quantidade) from public.movimentos_estoque m
        where m.dono=conta and m.operacao_id=o.id and m.tipo='retorno' and m.item_id=(i->>'id')::uuid
        and m.produto_id=(i->>'produtoId')::uuid),0),'estoque_troca_retorno');
    end if;
  end loop;
  perform estoque_interno.exigir(total_retirado>0,'estoque_troca_sem_devolucao');
  bruto_antigo := public.soma_itens(antiga.itens);
  desconto_esperado := floor(antiga.desconto::numeric*bruto_mantido/bruto_antigo)::bigint;
  if nova.id is not null then
    perform estoque_interno.exigir(nova.desconto=desconto_esperado,'estoque_troca_desconto');
    total_novo := public.soma_itens(nova.itens)-nova.desconto;
    if nova.pagamento='fiado' then
      perform estoque_interno.exigir(jsonb_array_length(nova.parcelas)=jsonb_array_length(antiga.parcelas),'estoque_troca_parcelas');
      comum := ((total_novo/jsonb_array_length(nova.parcelas))/5)*5;
      for p,indice in select value,ordinality from jsonb_array_elements(nova.parcelas) with ordinality loop
        perform estoque_interno.exigir(p->'vencimento'=antiga.parcelas->(indice::integer-1)->'vencimento'
          and (p->>'valor')::bigint=case when indice=1 then total_novo-comum*(jsonb_array_length(nova.parcelas)-1) else comum end,
          'estoque_troca_parcelas');
      end loop;
    end if;
  end if;
  for m in select * from public.movimentos_estoque where dono=conta and operacao_id=o.id loop
    if m.tipo='retorno' then
      perform estoque_interno.exigir(exists(select 1 from jsonb_array_elements(antiga.itens) i
        where i->>'id'=m.item_id::text and i->>'produtoId'=m.produto_id::text),'estoque_troca_retorno');
    elsif m.tipo='entrega' then
      perform estoque_interno.exigir(not exists(select 1 from jsonb_array_elements(antiga.itens) i
        where i->>'id'=m.item_id::text),'estoque_troca_baixa_repetida');
      perform estoque_interno.exigir(exists(select 1 from jsonb_array_elements(nova.itens) i
        where i->>'id'=m.item_id::text and i->>'produtoId'=m.produto_id::text
          and (i->>'quantidade')::bigint >= (select sum(x.quantidade) from public.movimentos_estoque x
            where x.dono=conta and x.operacao_id=o.id and x.item_id=m.item_id and x.tipo='entrega')),'estoque_troca_entrega');
      select case when exists(select 1 from public.movimentos_estoque c where c.dono=conta and c.produto_id=m.produto_id and c.tipo='compra'
        and not exists(select 1 from public.movimentos_estoque a where a.dono=conta and a.alvo_id=c.id)) then
        (select c.custo_unitario from public.movimentos_estoque c where c.dono=conta and c.produto_id=m.produto_id and c.tipo='compra'
          and not exists(select 1 from public.movimentos_estoque a where a.dono=conta and a.alvo_id=c.id)
          order by c.data desc,c.ordem_cadastro desc,coalesce(c.compra_original_id,c.id) desc limit 1)
        else p.custo_manual end into custo_esperado from public.produtos p where p.dono=conta and p.id=m.produto_id;
      perform estoque_interno.exigir(m.custo_unitario is not distinct from custo_esperado,'estoque_troca_custo');
    end if;
  end loop;
end
$$;
revoke all on function estoque_interno.conferir_troca(uuid,uuid) from public,anon,authenticated;

create or replace function estoque_interno.conferir_grupo(conta uuid, operacao uuid) returns void
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
    when 'troca' then o.alvo_id is not null
      and (select count(*) between 1 and 2 and count(*) filter(where tipo='estorno' and estorna_id=o.alvo_id)=1
        and count(*) filter(where tipo='venda')=count(*)-1 from public.lancamentos where operacao_estoque_id=o.id)
      and not exists(select 1 from public.movimentos_estoque where operacao_id=o.id and tipo not in ('entrega','retorno'))
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
    if m.tipo='retorno' and o.tipo<>'troca' then
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
  if o.tipo='troca' then perform estoque_interno.conferir_troca(conta,operacao); end if;
  -- A trava do contador ainda pertence a esta transação ao conferir o limite acumulado (Q40).
  perform estoque_interno.exigir(not exists(select 1 from public.movimentos_estoque m where m.dono=conta
    and m.tipo in ('entrega','retorno') and not exists(select 1 from public.movimentos_estoque a where a.dono=conta and a.alvo_id=m.id)
    group by m.item_id,m.produto_id having sum(case m.tipo when 'entrega' then m.quantidade else -m.quantidade end)<0), 'estoque_excede_retorno');
end
$$;
