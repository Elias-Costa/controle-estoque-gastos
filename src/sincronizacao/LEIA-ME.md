# `src/sincronizacao`

A fila de operações subindo para a nuvem e o que o outro aparelho escreveu descendo (`D-003`,
sincronização artesanal; `D-010`, conflito; `D-042`, o modelo). Preenchida em **E-07**.

**A regra que atravessa tudo aqui:** nenhuma escrita depende de rede para concluir (RI-02). A
escrita vai para a base local, entra na fila, e a rede acontece depois — ao lado, nunca na frente.
Falha de envio não perde o dado, não trava a tela e não vira tela de erro (EL-06).

| Arquivo | O que é | Regra |
|---|---|---|
| `borda.ts` | Linha do domínio ↔ linha do Postgres: `camelCase`↔`snake_case`, `bigint`↔texto de dígitos, `null`↔ausente, carimbos em ISO UTC. Linha malformada **lança** | `D-022`, `D-041` |
| `nuvem.ts` | Interface `Nuvem` e a implementação sobre `supabase-js`; **classifica a falha** (`rede` / `sessao` / `recusa`) por classe de SQLSTATE; download paginado com `::text` no dinheiro | `D-042` |
| `sincronizacao.ts` | O motor: ciclo enviar → baixar, retentativa, cursor, estado do indicador. Relógio, timer, janela e documento injetáveis | `D-010`, `D-042` |
| `instancia.ts` | O motor do app sobre `banco` e `nuvemDoApp`; inscreve `acordar()` em `aoEnfileirar`. Testes nunca importam | — |

**Como um item sobe.** Uma gravação em `src/dados` põe um item na fila e avisa `aoEnfileirar`; o
motor acorda, lê a fila em `++ordem` (o cliente antes do lançamento que o cita), pula o que está
"com problema", lê a linha **como estiver agora** (a fila é ponteiro), traduz na borda e sobe por
`upsert` no id — o reenvio idempotente de RI-05, `D-029`. Sucesso remove o item **só se a `versao`
for a que subiu**: uma correção feita durante o envio fica para a vez seguinte.

**O que cada falha faz** (`D-042`; a frase é *só o que o banco recusou de verdade é definitivo, o
resto é tenta de novo*):

- **`rede`** (`code` vazio — é como o `supabase-js` engole a falha de `fetch`, verificado com host
  inalcançável; HTML de gateway; `08*`/`53*`/`57*`): para o ciclo, nada é marcado, retentativa com
  espera crescente — 5 s dobrando até 5 min, zerada por escrita local, `online`, aba visível ou
  sessão. **`navigator.onLine` não é consultado**: no iOS ele mente (`AGENTS.md` §2.1); a prova de
  rede é a resposta.
- **`sessao`** (`42501`, `PGRST3xx`): para o ciclo e espera `onAuthStateChange`. Sem sessão o
  motor **nem tenta**. Nada vira "com problema" por sessão (`D-005`).
- **`recusa`** (`22*`, `23*`, `42*`): `23503` (o pai ainda não chegou do outro aparelho) pula e
  retenta; qualquer outra é **definitiva** — o item ganha `problema` (SQLSTATE, constraint,
  mensagem, instante), fica parado, não prende os demais, e só volta a tentar se a linha for
  regravada. `lancamentos_imutavel` (reenvio com conteúdo diferente, `D-041`) e
  `lancamentos_um_estorno_por_alvo` são os casos concretos; a saída é estorno, em E-10.

**Como o que o outro aparelho escreveu desce.** Depois de enviar, o motor pede a cada tabela o
que chegou desde o cursor guardado (`recebido_em` em clientes, `criado_em` em lançamentos —
carimbos do **servidor**, tabela `sincronizacao`, Dexie v2) menos um minuto de margem, em páginas
de 500. **Lançamento é união** (`D-010`): entra se não existir, e nunca por cima de uma linha com
item na fila. **Cadastro é último-que-escreve pelo relógio do aparelho** (`D-042`): entra só se o
`atualizadoEm` da nuvem for mais novo que o local — o mesmo `>=` do gatilho na nuvem. Nada que
desce enfileira. Cursor ausente (base zerada) = tudo desce: é o mecanismo de RT-10.

**O estado** (`estado()`, `assinar()`) alimenta o indicador de RF-25 (`src/interface`): `pendentes`,
`comProblema`, `enviando`, `sessao`, `ultimaFalha`, `ultimoSucessoEm`. Mesma referência enquanto
nada muda, para `useSyncExternalStore`. "Já subiu?" (`D-013`) não mora aqui: é
`repositorio.sincronizado(id)`.

**Antes de E-13 não há login no app.** O motor só faz algo com `supabase.auth.getSession()`
preenchida; E-08 entra com o usuário de teste (`nuvem/LEIA-ME.md`).

**Testes:** `testes/borda.test.ts`, `testes/sincronizacao.test.ts` (motor sobre `fake-indexeddb` e
uma `NuvemDeMentira` com as regras do banco — é onde RT-08 do lado da fila mora),
`testes/integracao/sincronizacao.test.ts` (transporte real, deixa linhas no banco). Nada disso é
afirmação sobre o WebKit.
