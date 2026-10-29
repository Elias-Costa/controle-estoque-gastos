-- D-077: contato fora do código público, consultado somente para relatar com autenticação.
-- O mantenedor configura o número no servidor; esta migration não contém contato nem seed.
create table public.contato_suporte (
  chave text primary key check (chave = 'mantenedor'),
  telefone text not null check (telefone ~ '^55[0-9]{10,11}$')
);
alter table public.contato_suporte enable row level security;
revoke all on table public.contato_suporte from public, anon, authenticated;

create function public.obter_contato_suporte() returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Autenticação necessária' using errcode = '42501';
  end if;
  return (select telefone from public.contato_suporte where chave = 'mantenedor');
end $$;
revoke all on function public.obter_contato_suporte() from public, anon, authenticated;
grant execute on function public.obter_contato_suporte() to authenticated;
