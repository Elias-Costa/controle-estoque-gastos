do $$ begin
  if exists (select 1 from public.prazos_encalhe) then
    raise exception 'A reversão descartaria prazos de encalhe já salvos';
  end if;
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

drop function backup_interno.fontes(uuid);
alter function backup_interno.fontes_ate_v10(uuid) rename to fontes;
drop function public.salvar_prazo_encalhe(uuid,numeric,timestamptz);
drop table public.prazos_encalhe;
drop function public.prazo_encalhe_ultimo_que_escreve();
