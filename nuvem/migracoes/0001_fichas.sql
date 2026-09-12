-- 0001_fichas — O esquema da nuvem para F1: clientes e lançamentos (E-06, D-041).
--
-- Espelha a base local (`src/dados/banco.ts`) tabela por tabela: a linha é o tipo do domínio
-- (`src/dominio/ficha.ts`), com parcelas e itens em `jsonb` dentro do lançamento (D-041, item 1).
-- O que muda aqui em relação ao aparelho é o que só o banco pode garantir (RI-09):
--
--   - as invariantes financeiras valem por constraint, não por código do app: valor positivo,
--     desconto dentro da soma, soma das parcelas igual ao total (D-039), um estorno por alvo;
--   - lançamento é imutável (RI-03, D-010): não se apaga, e só se "atualiza" com o mesmo
--     conteúdo — o reenvio idempotente de RI-05 passa, qualquer diferença é erro (D-041, item 2);
--   - o isolamento por conta é política de linha (RNF-07): `dono` é carimbado pelo banco
--     (`auth.uid()`), o app nunca o envia, e ninguém lê ou grava fora da própria conta;
--   - o id nasce no dispositivo (RI-04, D-029): não há `default` — insert sem id é recusado.
--
-- O que NÃO está aqui, de propósito (D-041): saldo ≥ 0 — é invariante da ficha inteira, e com
-- dois aparelhos a nuvem recebe a união dos lançamentos em ordem arbitrária (D-010); recusar um
-- recebimento que chegou antes da venda travaria item legítimo na fila. O saldo é derivado no
-- aparelho (D-039).
--
-- Dinheiro é `bigint` de centavos (D-022). Dentro do `jsonb`, `valor` e `preco` são inteiros não
-- negativos, aceitos como número JSON ou como texto de dígitos (`->>` dá o texto dos dois); `39.9`
-- e `-1` são recusados pela expressão regular antes de qualquer cast.
--
-- Reverter: `0001_fichas.reverter.sql`. Nunca edite esta migration depois de aplicada — acrescente
-- a próxima (`nuvem/LEIA-ME.md`).

-- ---------------------------------------------------------------------------------------------
-- 0. Limpeza do spike de E-00: a tabela foi criada à mão no editor SQL com política aberta para
--    `anon` — qualquer um com a chave pública do bundle escrevia nela. Sai junto com a política.
-- ---------------------------------------------------------------------------------------------

drop table if exists public.spike_sondas;

-- ---------------------------------------------------------------------------------------------
-- 1. Funções sobre o jsonb. Todas `immutable`, para poderem entrar em `check`.
-- ---------------------------------------------------------------------------------------------

-- Um dia `AAAA-MM-DD` que existe no calendário. O domínio só confere o formato (`ficha.ts`,
-- `DIA`); aqui o `::date` recusa 30 de fevereiro — mais estrito, de propósito. ISO puro é
-- inequívoco em qualquer `DateStyle`, o que mantém a função honesta como `immutable`.
create or replace function public.dia_valido(texto text) returns boolean
language plpgsql immutable strict as $$
begin
  if texto !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;
  perform texto::date;
  return true;
exception when others then
  return false;
end
$$;

-- Itens de uma venda (RF-03, D-011): lista não vazia de { descricao: texto não vazio,
-- preco: inteiro ≥ 0 }. Sem produto e sem quantidade em F1.
create or replace function public.itens_validos(itens jsonb) returns boolean
language sql immutable strict as $$
  select case
    when jsonb_typeof(itens) <> 'array' then false
    when jsonb_array_length(itens) = 0 then false
    else coalesce((
      select bool_and(
        jsonb_typeof(item) = 'object'
        and jsonb_typeof(item -> 'descricao') = 'string'
        and (item ->> 'descricao') <> ''
        and coalesce(item ->> 'preco', '') ~ '^[0-9]+$'
      )
      from jsonb_array_elements(itens) as item
    ), false)
  end
$$;

-- Parcelas de um débito (RF-05): lista não vazia de { id: uuid, vencimento: dia válido,
-- valor: inteiro ≥ 0 }, sem id repetido na linha. A parcela tem id próprio porque a renegociação
-- (RN-08) precisa dizer "esta continua igual" — e o id vem do dispositivo (D-029).
create or replace function public.parcelas_validas(parcelas jsonb) returns boolean
language sql immutable strict as $$
  select case
    when jsonb_typeof(parcelas) <> 'array' then false
    when jsonb_array_length(parcelas) = 0 then false
    else coalesce((
      select bool_and(
          jsonb_typeof(parcela) = 'object'
          and coalesce(parcela ->> 'id', '')
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and public.dia_valido(coalesce(parcela ->> 'vencimento', ''))
          and coalesce(parcela ->> 'valor', '') ~ '^[0-9]+$'
        )
        and count(distinct parcela ->> 'id') = count(*)
      from jsonb_array_elements(parcelas) as parcela
    ), false)
  end
$$;

-- Soma dos preços dos itens, em centavos. Para lista inválida devolve `null` — "a soma não
-- existe" —, e é de propósito: os `check` de soma passam em branco e só `lancamentos_sem_itens`
-- acusa, em vez de um `desconto_invalido` enganoso calculado sobre um preço `-1`.
create or replace function public.soma_itens(itens jsonb) returns bigint
language sql immutable strict as $$
  select case
    when public.itens_validos(itens) then
      (select sum((item ->> 'preco')::bigint) from jsonb_array_elements(itens) as item)
    else null
  end
$$;

-- Soma dos valores das parcelas, em centavos. Mesma regra: lista inválida, soma `null`.
create or replace function public.soma_parcelas(parcelas jsonb) returns bigint
language sql immutable strict as $$
  select case
    when public.parcelas_validas(parcelas) then
      (select sum((parcela ->> 'valor')::bigint) from jsonb_array_elements(parcelas) as parcela)
    else null
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Clientes (RF-01). Só o nome é obrigatório; o resto fica como ela digitou.
-- ---------------------------------------------------------------------------------------------

create table public.clientes (
  -- Gerado no dispositivo (UUIDv7, D-029, RI-04). Sem `default`: insert sem id é recusado.
  id uuid primary key,
  -- A conta dona da linha (RNF-07). O banco carimba com `auth.uid()`; o app nunca envia.
  dono uuid not null default auth.uid(),
  nome text not null constraint clientes_nome_obrigatorio check (nome <> ''),
  telefone text,
  apelido text,
  observacao text,
  criado_em timestamptz not null default now(),
  -- Alvo da FK composta de `lancamentos`: um lançamento só aponta para cliente da mesma conta.
  constraint clientes_id_e_dono unique (id, dono)
);

-- ---------------------------------------------------------------------------------------------
-- 3. Lançamentos: uma tabela, cinco tipos (D-039). Cada tipo usa um subconjunto das colunas, e
--    `lancamentos_forma_por_tipo` diz exatamente qual — o que sobra tem de ser nulo.
-- ---------------------------------------------------------------------------------------------

create table public.lancamentos (
  id uuid primary key,
  dono uuid not null default auth.uid(),
  cliente_id uuid not null,
  -- A data do fato, não a do lançamento (RN-09). `date` recusa 30 de fevereiro.
  data date not null,
  tipo text not null,
  -- venda: 'fiado' | 'avista'
  pagamento text,
  -- venda à vista e recebimento: 'pix' | 'dinheiro' | 'outro'
  forma text,
  -- venda: [{ descricao, preco }]
  itens jsonb,
  -- venda: desconto no total, em centavos (RF-03)
  desconto bigint,
  -- venda fiado e saldo anterior: [{ id, vencimento, valor }]
  parcelas jsonb,
  -- recebimento e desconto de quitação, em centavos
  valor bigint,
  -- recebimento: texto livre
  observacao text,
  -- estorno: o alvo (RN-07)
  estorna_id uuid,
  -- estorno: texto livre
  motivo text,
  criado_em timestamptz not null default now(),

  -- O lançamento é de um cliente da MESMA conta (RI-09, D-040). Composta para não depender de
  -- gatilho: a FK ignora RLS, então sem o `dono` uma conta poderia apontar para cliente de outra.
  constraint lancamentos_cliente foreign key (cliente_id, dono) references public.clientes (id, dono),

  -- Alvo da FK do estorno: mesma conta E mesma ficha.
  constraint lancamentos_id_cliente_e_dono unique (id, cliente_id, dono),
  constraint lancamentos_estorno_alvo
    foreign key (estorna_id, cliente_id, dono) references public.lancamentos (id, cliente_id, dono),

  constraint lancamentos_tipo_conhecido
    check (tipo in ('venda', 'saldo-anterior', 'recebimento', 'desconto-quitacao', 'estorno')),
  constraint lancamentos_pagamento_conhecido check (pagamento is null or pagamento in ('fiado', 'avista')),
  constraint lancamentos_forma_conhecida check (forma is null or forma in ('pix', 'dinheiro', 'outro')),

  -- Quais colunas cada tipo preenche, e quais têm de ficar nulas. Espelha os tipos de `ficha.ts`.
  -- Tipo ou pagamento desconhecido dá `null` aqui (o `case` sem `else`), e o `check` passa em
  -- branco de propósito: o Postgres avalia os `check` em ordem alfabética de nome, e quem tem de
  -- acusar é `tipo_conhecido` / `pagamento_conhecido` — o nome certo para E-07 diagnosticar.
  constraint lancamentos_forma_por_tipo check (
    case tipo
      when 'venda' then
        pagamento is not null and itens is not null and desconto is not null
        and valor is null and observacao is null and estorna_id is null and motivo is null
        and case pagamento
          when 'fiado' then parcelas is not null and forma is null
          when 'avista' then parcelas is null and forma is not null
        end
      when 'saldo-anterior' then
        parcelas is not null
        and pagamento is null and forma is null and itens is null and desconto is null
        and valor is null and observacao is null and estorna_id is null and motivo is null
      when 'recebimento' then
        valor is not null and forma is not null
        and pagamento is null and itens is null and desconto is null and parcelas is null
        and estorna_id is null and motivo is null
      when 'desconto-quitacao' then
        valor is not null
        and pagamento is null and forma is null and itens is null and desconto is null
        and parcelas is null and observacao is null and estorna_id is null and motivo is null
      when 'estorno' then
        estorna_id is not null
        and pagamento is null and forma is null and itens is null and desconto is null
        and parcelas is null and valor is null and observacao is null
    end
  ),

  -- As invariantes financeiras, por linha (RI-09). Os nomes são o motivo em código, para E-07
  -- saber o que a nuvem recusou sem ler a mensagem.
  constraint lancamentos_sem_itens check (itens is null or public.itens_validos(itens)),
  constraint lancamentos_sem_parcelas check (parcelas is null or public.parcelas_validas(parcelas)),
  constraint lancamentos_desconto_invalido check (
    desconto is null or (desconto >= 0 and desconto <= public.soma_itens(itens))
  ),
  -- Venda fiado: soma das parcelas = soma dos itens − desconto (RF-05, D-012, D-039 → E-06).
  constraint lancamentos_parcelas_nao_fecham check (
    tipo <> 'venda' or pagamento <> 'fiado'
    or public.soma_parcelas(parcelas) = public.soma_itens(itens) - desconto
  ),
  -- Recebimento e desconto de quitação são positivos (RF-06); a quitação cabe em R$ 0,10 (RN-15, D-031).
  constraint lancamentos_valor_invalido check (valor is null or valor > 0),
  constraint lancamentos_acima_do_limite_de_quitacao check (tipo <> 'desconto-quitacao' or valor <= 10)
);

-- Um estorno por alvo (D-039: "já estornado" é recusa). Índice parcial: só as linhas de estorno.
create unique index lancamentos_um_estorno_por_alvo on public.lancamentos (estorna_id) where tipo = 'estorno';

-- A ficha: todos os lançamentos de um cliente, dentro de uma conta.
create index lancamentos_por_ficha on public.lancamentos (dono, cliente_id);

-- ---------------------------------------------------------------------------------------------
-- 4. Gatilhos: o que constraint não expressa.
-- ---------------------------------------------------------------------------------------------

-- Estorno não se estorna (D-039): o alvo tem de ser um lançamento que não é estorno. A FK já
-- garante que existe, na mesma ficha e na mesma conta; aqui só o tipo do alvo.
create or replace function public.estorno_nao_se_estorna() returns trigger
language plpgsql as $$
begin
  if new.tipo = 'estorno' and exists (
    select 1 from public.lancamentos where id = new.estorna_id and tipo = 'estorno'
  ) then
    raise exception 'estorno não se estorna: o desfazer é lançar de novo (D-039)'
      using errcode = 'integrity_constraint_violation',
            constraint = 'lancamentos_alvo_e_estorno',
            table = 'lancamentos';
  end if;
  return new;
end
$$;

create trigger lancamentos_alvo_e_estorno
  before insert on public.lancamentos
  for each row execute function public.estorno_nao_se_estorna();

-- Lançamento é imutável (RI-03, D-010). DELETE nunca; UPDATE só quando nada muda — é o reenvio
-- idempotente de RI-05 (`insert … on conflict do update` com o mesmo conteúdo). Qualquer
-- diferença é erro, para a fila de E-07 marcar "com problema" em vez de sumir com a correção em
-- silêncio (D-041, item 2). `criado_em` fica fora da comparação: é carimbo do servidor.
-- Vale para qualquer papel, inclusive `postgres` — RI-09 é no banco, não no cliente.
create or replace function public.lancamento_imutavel() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'lançamento não se apaga: correção é estorno (RI-03)'
      using errcode = 'integrity_constraint_violation',
            constraint = 'lancamentos_imutavel',
            table = 'lancamentos';
  end if;
  if (new.dono, new.cliente_id, new.data, new.tipo, new.pagamento, new.forma, new.itens,
      new.desconto, new.parcelas, new.valor, new.observacao, new.estorna_id, new.motivo)
     is distinct from
     (old.dono, old.cliente_id, old.data, old.tipo, old.pagamento, old.forma, old.itens,
      old.desconto, old.parcelas, old.valor, old.observacao, old.estorna_id, old.motivo)
  then
    raise exception 'lançamento já existe na nuvem com outro conteúdo: correção é estorno (RI-03, D-013)'
      using errcode = 'integrity_constraint_violation',
            constraint = 'lancamentos_imutavel',
            table = 'lancamentos';
  end if;
  return new;
end
$$;

create trigger lancamentos_imutavel
  before update or delete on public.lancamentos
  for each row execute function public.lancamento_imutavel();

-- Cliente não se apaga: o repositório não tem `apagar` (E-05), e a nuvem espelha. Alterar pode
-- (cadastro resolve por último-que-escreve, D-010).
create or replace function public.cliente_nao_se_apaga() returns trigger
language plpgsql as $$
begin
  raise exception 'cliente não se apaga (D-040, D-041)'
    using errcode = 'integrity_constraint_violation',
          constraint = 'clientes_nao_se_apaga',
          table = 'clientes';
end
$$;

create trigger clientes_nao_se_apaga
  before delete on public.clientes
  for each row execute function public.cliente_nao_se_apaga();

-- ---------------------------------------------------------------------------------------------
-- 5. Isolamento por conta (RNF-07): política de linha, na camada do banco. Nenhuma consulta do
--    app é o que garante o isolamento. `force` aplica a política até ao dono da tabela; o papel
--    `postgres` do Supabase ignora RLS por atributo próprio, e o app nunca usa esse papel.
-- ---------------------------------------------------------------------------------------------

alter table public.clientes enable row level security;
alter table public.clientes force row level security;
alter table public.lancamentos enable row level security;
alter table public.lancamentos force row level security;

-- `anon` não tem política nenhuma e nem privilégio: sem sessão, nada. Explícito, não por omissão.
revoke all on public.clientes, public.lancamentos from anon;
grant select, insert, update on public.clientes, public.lancamentos to authenticated;

create policy clientes_ler_da_propria_conta on public.clientes
  for select to authenticated using (dono = auth.uid());
create policy clientes_criar_na_propria_conta on public.clientes
  for insert to authenticated with check (dono = auth.uid());
create policy clientes_alterar_da_propria_conta on public.clientes
  for update to authenticated using (dono = auth.uid()) with check (dono = auth.uid());
-- Sem política de delete: ninguém apaga — e o gatilho recusa até quem ignora RLS.

create policy lancamentos_ler_da_propria_conta on public.lancamentos
  for select to authenticated using (dono = auth.uid());
create policy lancamentos_criar_na_propria_conta on public.lancamentos
  for insert to authenticated with check (dono = auth.uid());
-- Update existe só para o `on conflict do update` do reenvio idempotente; o gatilho recusa mudança.
create policy lancamentos_reenviar_da_propria_conta on public.lancamentos
  for update to authenticated using (dono = auth.uid()) with check (dono = auth.uid());
