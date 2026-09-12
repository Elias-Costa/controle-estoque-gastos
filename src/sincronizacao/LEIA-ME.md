# `src/sincronizacao`

A fila de operações e o envio para a nuvem (`D-003`, sincronização artesanal).

**A regra que atravessa tudo aqui:** nenhuma escrita depende de rede para concluir (RI-02). A
escrita vai para a base local, entra na fila, e a rede acontece depois. Falha de envio não perde o
dado e não trava a tela.

O reenvio é idempotente pela chave estável que é o próprio id do registro (`D-029`, RI-05) — enviar
duas vezes é um `upsert` sobre a mesma linha. É isso que fecha EL-04, e E-00 já provou no aparelho:
3 itens reenviados 2× produziram `3 linhas / 3 ids distintos`.

**`navigator.onLine` mente no iOS.** E-00 observou, ao sair do modo avião, `onLine === true` com a
primeira sincronização morrendo em `TypeError: Load failed`, e a mesma operação funcionando 10 s
depois. `onLine` serve para adiar tentativa, nunca para concluir que a rede funciona — só a resposta
do servidor prova isso. Retentativa com espera crescente é obrigatória, não refinamento.

**O que E-06 deixou na nuvem, e E-07 precisa saber** (`nuvem/LEIA-ME.md`, `D-041`):

- **A borda mapeia duas coisas:** `camelCase` ↔ `snake_case` (`clienteId` → `cliente_id`,
  `estornaId` → `estorna_id`) e `bigint` ↔ texto de centavos (`D-022`). Dentro de `itens` e
  `parcelas` o banco aceita número JSON ou texto de dígitos; texto é o que não passa por `number`
  em lugar nenhum. Datas são `AAAA-MM-DD` nos dois sentidos.
- **`dono` nunca é enviado.** O banco carimba com `auth.uid()`; enviar outro valor é recusa da
  política (`42501`). Sem sessão, tudo é `42501` — é o estado "com problema" de RF-25, não retentativa.
- **O reenvio é `insert … on conflict (id) do update`** com as colunas do domínio. Conteúdo idêntico
  passa (RI-05). **Conteúdo diferente para um lançamento que já existe é erro `lancamentos_imutavel`**
  (`23000`), não sobrescrita: a fila marca o item "com problema" e a correção vira estorno
  (`D-013`, `D-041` item 2). Cliente pode mudar (`D-010`, último-que-escreve).
- **O nome da constraint é o motivo em código** (`lancamentos_valor_invalido`,
  `lancamentos_parcelas_nao_fecham`, `lancamentos_cliente`…): vem em `constraint` no erro do
  Postgres e em `details`/`message` no PostgREST. É o diagnóstico; a tela põe as palavras.
- **A FK exige o cliente antes do lançamento** e o alvo antes do estorno — a ordem da fila
  (`++ordem`, `D-040`) já garante isso dentro de um aparelho.
- **Não há `atualizado_em`:** o LWW de `D-010` para cadastros é decisão de E-07, e a coluna entra
  por migration `0002` (`nuvem/LEIA-ME.md`, "Como acrescentar uma migration").
- **Saldo ≥ 0 não é verificado na nuvem** (`D-041`): a união de dois aparelhos pode chegar fora de
  ordem, e nenhum item legítimo pode ficar preso por isso.

Preenchida em **E-07**.
