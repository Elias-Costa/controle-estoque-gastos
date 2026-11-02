-- D-079: reversão somente sem configuração/inscrições/rodadas/observações; nunca recuperação.
do $$
begin
  if exists(select 1 from lembretes_interno.configuracao)
    or exists(select 1 from lembretes_interno.inscricoes)
    or exists(select 1 from lembretes_interno.observacoes)
    or exists(select 1 from lembretes_interno.rodadas)
    or exists(select 1 from lembretes_interno.envios) then
    raise exception 'lembretes_possuem_dados' using errcode='23514';
  end if;
end
$$;
drop function public.concluir_envio_lembretes(uuid,date,uuid,bigint,integer,text,timestamptz);
drop function public.preparar_rodada_lembretes(uuid,text,jsonb,boolean,timestamptz,jsonb);
drop function public.fotografia_lembretes(uuid);
drop function public.listar_contas_lembretes();
drop function public.registrar_inscricao_lembretes(jsonb);
drop function public.obter_configuracao_lembretes();
drop function lembretes_interno.fontes(uuid);
drop table lembretes_interno.envios;
drop table lembretes_interno.rodadas;
drop table lembretes_interno.observacoes;
drop table lembretes_interno.inscricoes;
drop table lembretes_interno.configuracao;
drop function lembretes_interno.inscricao_valida(jsonb);
drop schema lembretes_interno;
