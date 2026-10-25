-- E-28B/D-074/075: propriedade opcional, sem backfill e dependente apenas de F2.
alter table public.produtos add column classificacao text
  constraint produtos_classificacao check (classificacao in ('feminino','masculino','unissex','nao-se-aplica'));

create or replace function public.gravar_produto_estoque(cadastro jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare conta uuid := auth.uid(); id_produto uuid;
begin
  perform estoque_interno.exigir(conta is not null,'estoque_sessao_obrigatoria');
  perform estoque_interno.exigir(cadastro - array['id','nome','categoriaId','marca','classificacao','codigoCatalogo','fotoId','custoManual','precoVenda','estoqueMinimo','atualizadoEm']='{}'::jsonb
    and estoque_interno.uuid_valido(cadastro->'id') and estoque_interno.uuid_valido(cadastro->'categoriaId')
    and jsonb_typeof(cadastro->'nome')='string' and btrim(cadastro->>'nome')<>''
    and jsonb_typeof(cadastro->'atualizadoEm')='string','estoque_produto_invalido');
  if cadastro ? 'classificacao' then
    perform estoque_interno.exigir(cadastro->'classificacao'='null'::jsonb or
      (jsonb_typeof(cadastro->'classificacao')='string' and cadastro->>'classificacao' in
        ('feminino','masculino','unissex','nao-se-aplica')),'estoque_classificacao_invalida');
  end if;
  if cadastro ? 'fotoId' then perform estoque_interno.exigir(estoque_interno.uuid_valido(cadastro->'fotoId'),'estoque_foto_invalida'); end if;
  if cadastro ? 'custoManual' then perform estoque_interno.exigir(estoque_interno.inteiro(cadastro->'custoManual',0,9223372036854775807,true),'estoque_custo_invalido'); end if;
  if cadastro ? 'precoVenda' then perform estoque_interno.exigir(estoque_interno.inteiro(cadastro->'precoVenda',0,9223372036854775807,true),'estoque_preco_invalido'); end if;
  if cadastro ? 'estoqueMinimo' then perform estoque_interno.exigir(estoque_interno.inteiro(cadastro->'estoqueMinimo',0,9007199254740991),'estoque_minimo_invalido'); end if;
  id_produto := (cadastro->>'id')::uuid;
  perform estoque_interno.exigir(not exists(select 1 from public.produtos where id=id_produto and dono<>conta),'estoque_conta_invalida');
  insert into public.produtos(id,dono,nome,categoria_id,marca,classificacao,codigo_catalogo,foto_id,custo_manual,preco_venda,estoque_minimo,atualizado_em)
    values(id_produto,conta,cadastro->>'nome',(cadastro->>'categoriaId')::uuid,cadastro->>'marca',cadastro->>'classificacao',cadastro->>'codigoCatalogo',
      (cadastro->>'fotoId')::uuid,(cadastro->>'custoManual')::bigint,(cadastro->>'precoVenda')::bigint,
      (cadastro->>'estoqueMinimo')::bigint,(cadastro->>'atualizadoEm')::timestamptz)
    on conflict(id) do update set nome=excluded.nome,categoria_id=excluded.categoria_id,marca=excluded.marca,
      -- D-075: a preservação lê a linha sob a mesma trava da escrita/LWW, nunca em GET solto.
      classificacao=case when cadastro ? 'classificacao' then excluded.classificacao else public.produtos.classificacao end,
      codigo_catalogo=excluded.codigo_catalogo,foto_id=excluded.foto_id,custo_manual=excluded.custo_manual,
      preco_venda=excluded.preco_venda,estoque_minimo=excluded.estoque_minimo,atualizado_em=excluded.atualizado_em;
  return id_produto;
end
$$;
