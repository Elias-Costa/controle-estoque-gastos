-- D-076: identificação privada, inteira, inclusive os bytes da logo; independente de F3.
create function public.logo_loja_valida(logo text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare dados bytea; largura bigint; altura bigint;
begin
  if logo is null then return true; end if;
  if length(logo) > 273090 or logo !~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$' then return false; end if;
  dados := decode(substring(logo from 23), 'base64');
  if octet_length(dados) < 33 or octet_length(dados) > 204800 or
    encode(substring(dados from 1 for 8), 'hex') <> '89504e470d0a1a0a' or
    encode(substring(dados from 13 for 4), 'hex') <> '49484452' then return false; end if;
  largura := get_byte(dados,16)::bigint*16777216 + get_byte(dados,17)*65536 + get_byte(dados,18)*256 + get_byte(dados,19);
  altura := get_byte(dados,20)::bigint*16777216 + get_byte(dados,21)*65536 + get_byte(dados,22)*256 + get_byte(dados,23);
  return largura between 1 and 512 and altura between 1 and 512;
exception when others then return false;
end $$;

create function public.identidade_loja_valida(identidade jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(identidade) is distinct from 'object' then false else
    identidade ?& array['nome','descricao'] and
    not exists (select 1 from jsonb_object_keys(identidade) k where k not in ('nome','descricao','logo')) and
    jsonb_typeof(identidade->'nome') = 'string' and btrim(identidade->>'nome') <> '' and
    btrim(identidade->>'nome') = identidade->>'nome' and jsonb_typeof(identidade->'descricao') = 'string' and
    (not identidade ? 'logo' or (jsonb_typeof(identidade->'logo') = 'string' and public.logo_loja_valida(identidade->>'logo')))
  end
$$;

create table public.identidades_loja (
  dono uuid not null default auth.uid(),
  chave text not null check (chave = 'loja'),
  id uuid not null check (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  identidade jsonb not null constraint identidade_loja_conteudo check (public.identidade_loja_valida(identidade)),
  atualizado_em timestamptz not null check (isfinite(atualizado_em)),
  recebido_em timestamptz not null default now(),
  primary key (dono, chave), unique (dono, id)
);
alter table public.identidades_loja enable row level security;
create policy identidade_loja_da_conta on public.identidades_loja for all to authenticated
  using (dono = auth.uid()) with check (dono = auth.uid());
revoke all on public.identidades_loja from anon, authenticated;
grant select on public.identidades_loja to authenticated;
grant insert (chave, id, identidade, atualizado_em), update (id, identidade, atualizado_em) on public.identidades_loja to authenticated;

create function public.identidade_loja_ultimo_que_escreve() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.dono <> old.dono or new.chave <> old.chave then
      raise exception 'Conta da identificação imutável' using errcode = '23514';
    end if;
    if new.atualizado_em < old.atualizado_em then return null; end if;
  end if;
  new.recebido_em := now();
  return new;
end $$;
create trigger identidade_loja_ultimo_que_escreve before insert or update on public.identidades_loja
  for each row execute function public.identidade_loja_ultimo_que_escreve();
revoke all on function public.logo_loja_valida(text), public.identidade_loja_valida(jsonb),
  public.identidade_loja_ultimo_que_escreve() from public;
grant execute on function public.logo_loja_valida(text), public.identidade_loja_valida(jsonb) to authenticated;
