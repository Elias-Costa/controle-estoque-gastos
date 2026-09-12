-- 0002_ultimo-que-escreve — O carimbo do último-que-escreve de cadastro e o cursor de download (E-07, D-042).
--
-- D-010 decidiu que cadastro (cliente) resolve conflito por último-que-escreve, por registro, e
-- D-041 deixou o carimbo para esta migration. D-042 fechou: **o carimbo é o relógio do aparelho**.
-- O app grava `atualizado_em` no momento em que ela mexeu e envia; aqui, um gatilho descarta a
-- versão mais antiga em silêncio — o `upsert` responde sucesso e a linha fica como estava. "Último
-- que escreveu" é o último que EDITOU, mesmo que a edição tenha chegado depois: o iPhone que mexeu
-- offline às 10h perde para o computador que mexeu às 10h05 online.
--
-- Um segundo carimbo, `recebido_em`, é do SERVIDOR: o instante em que a linha chegou ou mudou aqui.
-- É o cursor do download ("me dê o que chegou desde a última vez"). Não pode ser o relógio do
-- aparelho: um aparelho atrasado gravaria uma linha "no passado" do cursor do outro, que nunca a
-- puxaria. Para `lancamentos` o cursor é `criado_em`, que já existe e nunca muda (a linha é imutável).
--
-- Os dois índices servem ao download por cursor dentro da conta (RLS filtra por `dono`).
--
-- Reverter: `0002_ultimo-que-escreve.reverter.sql`. Nunca edite esta migration depois de aplicada.

alter table public.clientes
  -- Relógio do aparelho, enviado pelo app (D-042, item 1). O `default` é só para linha inserida sem
  -- ele (a suíte de E-06 faz isso); o app sempre envia.
  add column atualizado_em timestamptz not null default now(),
  -- Relógio do servidor: cursor do download. O gatilho abaixo o mantém; o app nunca o envia.
  add column recebido_em timestamptz not null default now();

-- Último-que-escreve por registro (D-010, D-042): em update, a versão mais antiga é descartada —
-- `return null` cancela a escrita sem erro, e o reenvio idempotente de RI-05 (mesmo carimbo) passa.
-- Em insert e em update aceito, `recebido_em` é carimbado agora, pelo servidor.
create or replace function public.cliente_ultimo_que_escreve() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.atualizado_em < old.atualizado_em then
    return null;
  end if;
  new.recebido_em := now();
  return new;
end
$$;

create trigger clientes_ultimo_que_escreve
  before insert or update on public.clientes
  for each row execute function public.cliente_ultimo_que_escreve();

create index clientes_por_chegada on public.clientes (dono, recebido_em);
create index lancamentos_por_chegada on public.lancamentos (dono, criado_em);
