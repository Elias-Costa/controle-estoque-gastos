-- D-041/085: não apagar nem tornar inacessível uma autorização definitiva já configurada.
do $$ begin
  if exists(select 1 from vault.secrets where name='fichinhas-backup-google-producao-v1') then
    raise exception 'backup_autorizacao_producao_existente';
  end if;
end $$;
drop function public.obter_autorizacao_backup_producao(), public.atualizar_renovacao_backup_producao(uuid,text,text);
