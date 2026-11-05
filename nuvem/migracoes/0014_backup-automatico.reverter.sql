-- Somente ensaio vazio. Não é recuperação de produção nem apaga cópia/configuração existente.
do $$ begin
  if exists(select 1 from backup_interno.capturas) or exists(select 1 from backup_interno.destinos)
    or exists(select 1 from backup_interno.protecoes) then
    raise exception 'backup_existente_impede_reversao' using errcode='23514';
  end if;
end $$;

drop function public.capturar_backup_servidor(uuid,uuid,text,timestamptz),public.ler_captura_backup(uuid,uuid,text,integer,integer),
  public.registrar_upload_backup(uuid,uuid,text,text,text,text,text,text[],text[]),public.consultar_upload_backup(uuid,uuid),
  public.confirmar_backup(uuid,uuid,text,text,text),public.planejar_rotacao_backup(uuid),public.concluir_rotacao_backup(uuid,uuid,text),
  public.cancelar_captura_backup(uuid,uuid),public.proxima_captura_backup(uuid),public.reservar_pasta_backup(uuid,text,text),
  public.obter_autorizacao_backup(),public.atualizar_renovacao_backup(uuid,text,text);

-- Restaura apenas as funções ampliadas; ACLs e os dados/bucket da 0005 permanecem.
create or replace function public.autorizar_coleta_fotos(limite integer default 20) returns jsonb
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); resultado jsonb;
begin
  perform estoque_interno.exigir(limite between 1 and 100,'foto_coleta_limite_invalido');
  update fotos_interno.copias c set estado='coleta' where c.dono=conta and c.estado='disponivel'
    and not exists(select 1 from fotos_interno.protecoes p where p.dono=conta and p.copia_id=c.id and not p.liberada)
    and not exists(select 1 from public.produtos p join fotos_interno.fotos f on f.id=p.foto_id and f.dono=p.dono
      where p.dono=conta and f.copia_atual=c.id);
  select coalesce(jsonb_agg(item), '[]') into resultado from
    (select jsonb_build_object('copiaId',id,'caminho',caminho) item from fotos_interno.copias
      where dono=conta and estado='coleta' order by id limit autorizar_coleta_fotos.limite) tarefas;
  return resultado;
end $$;

create or replace function public.permitir_objeto_foto(caminho text, acao text) returns boolean
language plpgsql security definer set search_path='' as $$
declare conta uuid := fotos_interno.coordenar(); c fotos_interno.copias;
begin
  select * into c from fotos_interno.copias where dono=conta and copias.caminho=permitir_objeto_foto.caminho;
  if not found then return false; end if;
  if acao='inserir' then return c.estado='pendente'; end if;
  if acao='ler' then return c.estado<>'removida'; end if;
  if acao='apagar' then return c.estado='coleta'
    and not exists(select 1 from fotos_interno.protecoes p where p.dono=conta and p.copia_id=c.id and not p.liberada); end if;
  return false;
end $$;

drop function backup_interno.fontes(uuid),backup_interno.completar_fotos(uuid,jsonb),backup_interno.dinheiro_textual(jsonb);
drop table backup_interno.protecoes,backup_interno.destinos,backup_interno.capturas;
drop schema backup_interno;
