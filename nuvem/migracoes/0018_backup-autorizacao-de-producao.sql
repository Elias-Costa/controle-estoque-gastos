-- D-085: cofre definitivo separado. Nenhuma autorização de teste é copiada ou substituída.
create function public.obter_autorizacao_backup_producao() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare documento jsonb;
begin
  select decrypted_secret::jsonb into documento from vault.decrypted_secrets
    where name='fichinhas-backup-google-producao-v1';
  if documento is null then return null; end if;
  perform estoque_interno.exigir(coalesce(documento->>'ambiente'='producao' and
    documento->>'destino'='https://awmesexptpalzonbucwc.supabase.co' and
    documento#>>'{cliente,projetoId}'='fichinhas-backup',false),'backup_autorizacao_divergente');
  return documento;
end $$;

create function public.atualizar_renovacao_backup_producao(conta uuid, anterior text, renovacao text) returns void
language plpgsql security definer set search_path='' as $$
declare segredo uuid; documento jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('fichinhas-backup-google-producao-v1',2));
  select id,decrypted_secret::jsonb into segredo,documento from vault.decrypted_secrets
    where name='fichinhas-backup-google-producao-v1';
  perform estoque_interno.exigir(coalesce(segredo is not null and documento->>'ambiente'='producao' and
    documento->>'destino'='https://awmesexptpalzonbucwc.supabase.co' and
    documento#>>'{cliente,projetoId}'='fichinhas-backup' and documento->>'contaId'=conta::text and
    (documento->>'renovacao'=anterior or documento->>'renovacao'=renovacao) and
    length(renovacao) between 1 and 4096,false),'backup_autorizacao_divergente');
  perform vault.update_secret(segredo,jsonb_set(documento,'{renovacao}',to_jsonb(renovacao))::text);
end $$;

revoke all on function public.obter_autorizacao_backup_producao(),
  public.atualizar_renovacao_backup_producao(uuid,text,text) from public,anon,authenticated;
grant execute on function public.obter_autorizacao_backup_producao(),
  public.atualizar_renovacao_backup_producao(uuid,text,text) to service_role;
