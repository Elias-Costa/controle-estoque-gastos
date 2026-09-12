# `nuvem`

O esquema do Supabase (`D-021`) e o runner que o leva até lá. **Não é código do app**: nada em
`src/` importa desta pasta, e o navegador nunca lê um `.sql`. É a metade da arquitetura que mora
no servidor — as garantias que só o banco pode dar (RI-09) e o isolamento por conta (RNF-07).
Preenchida em **E-06**; o modelo está em `D-041`.

| Caminho | O que é |
|---|---|
| `migracoes/0001_fichas.sql` | `clientes` e `lancamentos`, com as invariantes, os gatilhos e as políticas de linha |
| `migracoes/0001_fichas.reverter.sql` | desfaz a 0001 inteira, na ordem inversa |
| `migracoes/0002_ultimo-que-escreve.sql` | `atualizado_em` (relógio do aparelho) e `recebido_em` (servidor) em `clientes`, o gatilho de último-que-escreve e os índices do download (E-07, `D-042`) |
| `migracoes/0002_ultimo-que-escreve.reverter.sql` | desfaz a 0002 |
| `migrar.ts` | o runner: `bun run migrar` aplica o que falta; `bun run migrar:reverter` volta uma |
| `../testes/integracao/nuvem.test.ts` | a prova: tenta violar cada invariante direto no banco e espera a recusa; desde E-07, também o gatilho da 0002 |
| `../testes/integracao/sincronizacao.test.ts` | o transporte real (E-07): `supabase-js` → PostgREST com um usuário de teste. **Deixa linhas no banco** — ver abaixo |

## Como o esquema é

**Espelha a base local** (`src/dados/banco.ts`): a linha é o tipo do domínio, parcelas e itens em
`jsonb` dentro do lançamento (`D-041`, item 1), colunas em `snake_case`. O que a nuvem tem a mais é
o que só ela pode garantir:

- **Por linha, por constraint:** valor positivo; desconto entre zero e a soma dos itens; soma das
  parcelas igual ao total da venda fiado (`D-039`); quitação de até R$ 0,10 (RN-15); cada tipo com as
  suas colunas e só elas; item e parcela com a forma certa (`itens_validos`, `parcelas_validas`).
- **Imutabilidade (RI-03, `D-010`):** lançamento não se apaga, e só se "atualiza" com o mesmo
  conteúdo — é o reenvio idempotente de RI-05 passando; qualquer diferença é erro
  `lancamentos_imutavel` (`D-041`, item 2). Cliente não se apaga; pode ser alterado (`D-010`).
- **Um estorno por alvo**, e estorno não se estorna (`D-039`).
- **Isolamento por conta (RNF-07):** `dono` é carimbado pelo banco com `auth.uid()` — o app não
  envia — e as políticas de linha só deixam cada conta ver e gravar o que é dela. `anon` não tem
  privilégio nenhum. As FKs são **compostas com o dono**: um lançamento só aponta para cliente e
  alvo da mesma conta e da mesma ficha.
- **Id sem `default`** (RI-04): insert sem id é recusado.

**O que não está aqui, de propósito:** saldo ≥ 0 (`D-016`). É invariante da ficha inteira, e com
dois aparelhos a nuvem recebe a união em ordem arbitrária (`D-010`) — o saldo é derivado no
aparelho (`D-039`).

**Dinheiro** é `bigint` de centavos nas colunas (`D-022`). Dentro do `jsonb`, `valor` e `preco` são
inteiros não negativos, aceitos como número JSON ou texto de dígitos; `39.9` é recusado. Na volta,
o app pede as colunas `bigint` com `::text` — o PostgREST as serializaria como número JSON.

**Último-que-escreve de cadastro (`0002`, `D-010`, `D-042`):** `clientes.atualizado_em` é o
relógio do **aparelho**, enviado pelo app; o gatilho `clientes_ultimo_que_escreve` descarta em
silêncio um update com carimbo mais antigo que o guardado (o `upsert` responde sucesso, a linha não
muda) e carimba `recebido_em` com `now()` do **servidor** em todo insert e update aceito.
`recebido_em` (e `criado_em`, em lançamentos) é o cursor do download. Lançamento não tem
`atualizado_em`: é imutável.

## Como rodar

Precisa de `SUPABASE_DB_URL` em `.env.local`: Supabase → **Connect** → **Session pooler** (porta
5432, não o transaction pooler — `set local` e prepared statements não passam por ele), com o
password do banco. É segredo: nunca vai para o git, e nem o runner nem a suíte o imprimem.

```bash
bun run migrar
```

```bash
bun run test:integracao
```

`migrar` cria `public.migracoes` se faltar, aplica cada arquivo pendente numa transação e registra
o nome. `migrar:reverter` roda o `.reverter.sql` da última registrada, na mesma transação em que
apaga o registro. A suíte só roda com `INTEGRACAO=1` (o script já passa) e carrega `.env.local`
pelo nome — **`bun test` sozinho não o carrega**.

**Para a suíte do transporte real** (`sincronizacao.test.ts`) é preciso, além disso, um **usuário
de teste** (`D-042`, item 4): no painel, Authentication → Users → Add user (com auto-confirm), e em
`.env.local` as chaves `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (as mesmas do app),
`SUPABASE_TESTE_EMAIL` e `SUPABASE_TESTE_SENHA`. Sem elas a suíte pula e diz por quê.

**Essa suíte deixa linhas no banco, e é por decisão** (`D-042`): lançamento é imutável e ninguém
apaga (RI-03), então as linhas de teste ficam — sob o `dono` do usuário de teste, invisíveis à conta
dela pela RLS. Cada rodada usa ids novos. **Limpeza, antes de E-15:** `bun run migrar:reverter`
duas vezes (0002, depois 0001 — apaga as tabelas inteiras) e `bun run migrar`. É o mesmo reset que
E-06 fez uma vez antes de haver dado. E-08 vai deixar mais linhas pelo mesmo motivo.

## Como acrescentar uma migration

1. **Nunca edite uma migration já aplicada.** Ela existe no banco dela; editar o arquivo não
   muda nada lá e faz o repositório mentir sobre o que foi rodado.
2. Crie `migracoes/NNNN_nome.sql` **e** `migracoes/NNNN_nome.reverter.sql` — o runner recusa uma
   sem o par. O nome é `[a-z0-9-]`, sem ponto.
3. Rode `bun run migrar` e depois `bun run test:integracao`. Acrescente à suíte o teste que tenta
   violar o que a migration garante.
4. Se algo saiu errado, `bun run migrar:reverter` — e conserte o arquivo antes de aplicar de novo.

## O que a suíte prova, e como

Cada teste abre uma transação, faz o que precisa e **termina desfazendo-a**; cada tentativa de
violação vai num `savepoint`, para a transação seguir viva depois do erro. Nada fica no banco — o
que importa, porque a imutabilidade impede o próprio teste de apagar o que criou, e porque este é
o banco **dela**. As contas de teste são dois `sub` em `request.jwt.claims` com `set local role
authenticated` (`auth.uid()` lê o claim, não consulta `auth.users`); `anon` idem. O papel
`postgres` da conexão **ignora RLS** (`rolbypassrls`, verificado) e serve para provar que os
gatilhos valem para qualquer papel.

**Verificação por mutação, sem tocar o banco:** `MUTACAO="<ddl>" bun run test:integracao` aplica o
DDL no início de cada transação de teste e o desfaz com ela. Cinco mutações em E-06 (gatilho de
imutabilidade; check de soma; política de leitura aberta; FK sem o dono; índice de um estorno por
alvo) derrubaram 2, 1, 1, 1 e 1 testes.

**O que ela não prova:** que o dado volta ao aparelho de ponta a ponta (RT-10, E-08), e nada sobre
o WebKit. Que a fila sobe é `testes/sincronizacao.test.ts` (lógica) e
`testes/integracao/sincronizacao.test.ts` (transporte real), desde E-07. E um detalhe que E-07 precisa saber: para o papel do app, `delete` sem
política é um "0 linhas" **silencioso** — a linha nem chega ao gatilho. O erro só aparece para quem
ignora RLS.
