-- Não reverter a estrutura depois de configurar qualquer cliente/conexão real.
do $$ begin
  if exists(select 1 from backup_interno.clientes_web) or exists(select 1 from backup_interno.conexoes_google)
    or exists(select 1 from backup_interno.tentativas_google) then
    raise exception 'Conexão Google existente: preservar estrutura e autorizações.';
  end if;
end $$;
drop trigger backup_captura_geracao on backup_interno.capturas;
drop trigger backup_destino_geracao on backup_interno.destinos;
drop trigger backup_preparo_geracao on backup_interno.preparos;
drop trigger backup_lotes_geracao on backup_interno.lotes_reutilizaveis;
drop trigger backup_objetos_geracao on backup_interno.objetos_preparo;
drop function backup_interno.marcar_geracao(),backup_interno.geracao_atual(uuid);
drop index backup_interno.backup_servidor_diario;
drop index backup_interno.backup_aparelho_diario;
alter table backup_interno.destinos drop constraint destinos_pkey,drop column geracao,add primary key(dono);
alter table backup_interno.preparos drop constraint preparos_pkey,drop column geracao,add primary key(dono);
alter table backup_interno.lotes_reutilizaveis drop constraint lotes_reutilizaveis_pkey,drop column geracao,add primary key(dono);
alter table backup_interno.capturas drop column geracao;
alter table backup_interno.objetos_preparo drop column geracao;
create unique index backup_servidor_diario on backup_interno.capturas(dono,dia) where origem='servidor';
create unique index backup_aparelho_diario on backup_interno.capturas(dono,aparelho_id,dia) where origem='aparelho';
drop table backup_interno.tentativas_google,backup_interno.conexoes_google,backup_interno.clientes_web;
