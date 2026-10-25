-- E-36, D-069/072: quatro textos por conta; nenhuma alteração financeira ou de estoque.
create function public.modelo_whatsapp_valido(texto text, recibo boolean) returns boolean
language sql immutable set search_path = '' as $$
  select texto is not null and regexp_replace(texto, '[[:space:]]', '', 'g') <> '' and
    regexp_replace(texto, case when recibo then '\{(nome|valor|saldo)\}'
      else '\{(nome|valor|vencimento)\}' end, '', 'g') !~ '[{}]'
$$;

create function public.modelos_whatsapp_validos(modelos jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(modelos) <> 'object' then false else
    (select count(*) = 4 from jsonb_object_keys(modelos)) and
    not exists (select 1 from jsonb_each(modelos) e where
      e.key not in ('cobranca-vencida','cobranca-a-vencer','recibo-com-saldo','recibo-quitado') or
      jsonb_typeof(e.value) <> 'string' or
      not public.modelo_whatsapp_valido(e.value #>> '{}', e.key like 'recibo-%')) end
$$;

create table public.modelos_whatsapp (
  dono uuid not null default auth.uid(),
  chave text not null check (chave = 'whatsapp'),
  id uuid not null check (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  modelos jsonb not null constraint modelos_whatsapp_textos check (public.modelos_whatsapp_validos(modelos)),
  atualizado_em timestamptz not null,
  recebido_em timestamptz not null default now(),
  primary key (dono, chave),
  unique (dono, id)
);
alter table public.modelos_whatsapp enable row level security;
create policy modelos_whatsapp_da_conta on public.modelos_whatsapp
  for all to authenticated using (dono = auth.uid()) with check (dono = auth.uid());
revoke all on public.modelos_whatsapp from anon, authenticated;
grant select on public.modelos_whatsapp to authenticated;
grant insert (chave, id, modelos, atualizado_em), update (id, modelos, atualizado_em) on public.modelos_whatsapp to authenticated;

create function public.modelos_whatsapp_ultimo_que_escreve() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.dono <> old.dono or new.chave <> old.chave then
      raise exception 'Identidade da preferência imutável' using errcode = '23514';
    end if;
    if new.atualizado_em < old.atualizado_em then return null; end if;
  end if;
  new.recebido_em := now();
  return new;
end
$$;
create trigger modelos_whatsapp_ultimo_que_escreve before insert or update on public.modelos_whatsapp
  for each row execute function public.modelos_whatsapp_ultimo_que_escreve();
revoke all on function public.modelo_whatsapp_valido(text, boolean), public.modelos_whatsapp_validos(jsonb),
  public.modelos_whatsapp_ultimo_que_escreve() from public;
grant execute on function public.modelo_whatsapp_valido(text, boolean), public.modelos_whatsapp_validos(jsonb) to authenticated;
