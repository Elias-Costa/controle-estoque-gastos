-- D-089: uma escolha por conta, sem preencher a preferência ausente.
create table public.prazos_encalhe (
  dono uuid primary key default auth.uid(),
  id uuid not null check (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  dias numeric not null constraint prazo_encalhe_dias check (dias between 0 and 9007199254740991 and dias = trunc(dias)),
  atualizado_em timestamptz not null check (isfinite(atualizado_em))
);
alter table public.prazos_encalhe enable row level security;
create policy prazo_encalhe_da_conta on public.prazos_encalhe for all to authenticated
  using (dono = (select auth.uid())) with check (dono = (select auth.uid()));
revoke all on public.prazos_encalhe from public, anon, authenticated;
grant select on public.prazos_encalhe to authenticated;
grant insert (id, dias, atualizado_em), update (id, dias, atualizado_em) on public.prazos_encalhe to authenticated;

-- O gatilho conserva a regra de D-072 também nas escritas diretas.
create function public.prazo_encalhe_ultimo_que_escreve() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.atualizado_em < old.atualizado_em or new is not distinct from old then return null; end if;
  return new;
end $$;
create trigger prazo_encalhe_ultimo_que_escreve before update on public.prazos_encalhe
  for each row execute function public.prazo_encalhe_ultimo_que_escreve();
revoke all on function public.prazo_encalhe_ultimo_que_escreve() from public, anon, authenticated;

-- O cliente não envia o dono. Resolver a disputa na mesma escrita evita duas criações concorrentes.
create function public.salvar_prazo_encalhe(escolha_id uuid, dias numeric, carimbo timestamptz) returns void
language sql security invoker set search_path = '' as $$
  insert into public.prazos_encalhe (id, dias, atualizado_em) values (escolha_id, dias, carimbo)
  on conflict (dono) do update
    set id = excluded.id, dias = excluded.dias, atualizado_em = excluded.atualizado_em
$$;
revoke all on function public.salvar_prazo_encalhe(uuid,numeric,timestamptz) from public, anon, authenticated;
grant execute on function public.salvar_prazo_encalhe(uuid,numeric,timestamptz) to authenticated;

-- A fonte adicional usa a mesma visão MVCC. Capturas antigas permanecem imutáveis.
alter function backup_interno.fontes(uuid) rename to fontes_ate_v10;
create function backup_interno.fontes(conta uuid) returns jsonb
language sql stable set search_path = '' as $$
  select backup_interno.fontes_ate_v10(conta) || jsonb_build_object('encalhes', coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'dias', p.dias, 'atualizado_em', p.atualizado_em))
    from public.prazos_encalhe p where p.dono = conta
  ), '[]'))
$$;
revoke all on function backup_interno.fontes(uuid) from public, anon, authenticated;

create or replace function public.ler_captura_backup(conta uuid, captura uuid, tabela text, inicio integer default 0, limite integer default 250) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c backup_interno.capturas; fonte jsonb; linhas jsonb;
begin
  perform backup_interno.geracao_atual(conta);
  perform estoque_interno.exigir(tabela in ('clientes','lancamentos','categorias','produtos','estoque','caixa','modelos','identidades','fotos','encalhes')
    and inicio>=0 and limite between 1 and 250,'backup_pagina_invalida');
  select * into c from backup_interno.capturas b where b.id=captura and b.dono=conta and b.geracao=backup_interno.geracao_atual(conta) and b.estado in ('capturada','enviando');
  perform estoque_interno.exigir(found and c.documento is not null,'backup_captura_indisponivel');
  fonte := c.documento->tabela;
  if fonte is null and tabela = 'encalhes' then fonte := '[]'; end if;
  select coalesce(jsonb_agg(value order by ord),'[]') into linhas from
    (select value,ord from jsonb_array_elements(fonte) with ordinality e(value,ord) order by ord limit ler_captura_backup.limite offset inicio) x;
  return jsonb_build_object('linhas',linhas,'total',jsonb_array_length(fonte));
end $$;
