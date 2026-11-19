-- D-085: conexão escolhida no app; gerações mantêm os arquivos anteriores separados.
create table backup_interno.clientes_web (
  ambiente text primary key check(ambiente in ('local','homologacao','producao')),
  dono uuid not null unique references auth.users(id),
  destino text not null,
  retorno text not null,
  segredo_id uuid not null references vault.secrets(id)
);
create table backup_interno.conexoes_google (
  id uuid primary key,
  dono uuid not null references auth.users(id),
  ambiente text not null references backup_interno.clientes_web(ambiente),
  email text not null check(length(email) between 3 and 320),
  google_id text not null,
  segredo_id uuid not null references vault.secrets(id),
  criada_em timestamptz not null default clock_timestamp(),
  ativa boolean not null default true
);
create unique index backup_google_ativa on backup_interno.conexoes_google(dono) where ativa;
create table backup_interno.tentativas_google (
  estado_hash text primary key check(estado_hash ~ '^[a-f0-9]{64}$'),
  dono uuid not null references auth.users(id),
  ambiente text not null references backup_interno.clientes_web(ambiente),
  verificador text,
  anterior uuid,
  ate timestamptz not null default clock_timestamp()+interval '5 minutes',
  usada boolean not null default false
);
alter table backup_interno.clientes_web enable row level security;
alter table backup_interno.conexoes_google enable row level security;
alter table backup_interno.tentativas_google enable row level security;
revoke all on backup_interno.clientes_web,backup_interno.conexoes_google,backup_interno.tentativas_google from public,anon,authenticated,service_role;

-- Zero identifica o catálogo Desktop preexistente, que não é removido ou reatribuído.
alter table backup_interno.capturas add column geracao uuid not null default '00000000-0000-0000-0000-000000000000';
alter table backup_interno.destinos add column geracao uuid not null default '00000000-0000-0000-0000-000000000000';
alter table backup_interno.preparos add column geracao uuid not null default '00000000-0000-0000-0000-000000000000';
alter table backup_interno.lotes_reutilizaveis add column geracao uuid not null default '00000000-0000-0000-0000-000000000000';
alter table backup_interno.objetos_preparo add column geracao uuid not null default '00000000-0000-0000-0000-000000000000';
drop index backup_interno.backup_servidor_diario;
drop index backup_interno.backup_aparelho_diario;
create unique index backup_servidor_diario on backup_interno.capturas(dono,geracao,dia) where origem='servidor';
create unique index backup_aparelho_diario on backup_interno.capturas(dono,geracao,aparelho_id,dia) where origem='aparelho';
alter table backup_interno.destinos drop constraint destinos_pkey, add primary key(dono,geracao);
alter table backup_interno.preparos drop constraint preparos_pkey, add primary key(dono,geracao);
alter table backup_interno.lotes_reutilizaveis drop constraint lotes_reutilizaveis_pkey, add primary key(dono,geracao);

create function backup_interno.geracao_atual(conta uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare ativa uuid; contexto uuid := nullif(current_setting('fichinhas.backup_geracao',true),'')::uuid;
begin
  -- Trocar a conexão espera as transações antigas; chamadas HTTP posteriores são recusadas.
  perform pg_advisory_xact_lock_shared(hashtextextended(conta::text,85));
  select id into ativa from backup_interno.conexoes_google where dono=conta and conexoes_google.ativa;
  perform estoque_interno.exigir(contexto is not distinct from ativa,'backup_conexao_alterada');
  return coalesce(ativa,'00000000-0000-0000-0000-000000000000'::uuid);
end $$;

create function backup_interno.marcar_geracao() returns trigger
language plpgsql set search_path='' as $$
begin
  new.geracao := backup_interno.geracao_atual(new.dono);
  return new;
end $$;
create trigger backup_captura_geracao before insert on backup_interno.capturas for each row execute function backup_interno.marcar_geracao();
create trigger backup_destino_geracao before insert on backup_interno.destinos for each row execute function backup_interno.marcar_geracao();
create trigger backup_preparo_geracao before insert on backup_interno.preparos for each row execute function backup_interno.marcar_geracao();
create trigger backup_lotes_geracao before insert on backup_interno.lotes_reutilizaveis for each row execute function backup_interno.marcar_geracao();
create trigger backup_objetos_geracao before insert on backup_interno.objetos_preparo for each row execute function backup_interno.marcar_geracao();

-- DEFINICOES_VINCULADAS: versões explícitas das RPCs anteriores, com filtro por geração.
