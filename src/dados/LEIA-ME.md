# `src/dados`

A base local no aparelho — IndexedDB via Dexie (`D-020`) — e os repositórios que o app consome
**por interface**. O domínio não conhece o banco; é esta camada que sabe traduzir entre um e outro.
Preenchida em **E-05**; o modelo está em `D-040`.

Todo registro nasce aqui com id gerado no dispositivo, UUIDv7, antes de qualquer rede (`D-029`,
RI-04, RN-14). É o que torna possível criar uma venda offline já referenciando suas parcelas, e é a
chave de idempotência da sincronização (RI-05).

| Arquivo | O que é | Regra |
|---|---|---|
| `identidade.ts` | `uuidv7()` — o único gerador de id do app; `FORMATO_UUIDV7` para validar | `D-029` |
| `banco.ts` | `BancoLocal` (Dexie): `clientes`, `lancamentos`, `fila`, `sincronizacao`; `ESQUEMA_V1` e `ESQUEMA_V2`; o protocolo de migração no topo | `D-020`, `D-022`, `D-040`, `D-042` |
| `instancia.ts` | `banco` e `repositorio` — as instâncias do app; `aoEnfileirar(fn)`, o único fio para a sincronização. Os testes nunca a importam | `D-040` |
| `repositorio.ts` | `Repositorio` (interface: `listarClientes`, `lerCliente`, `lerFicha`, `gravarCliente`, `gravarLancamento`, `sincronizado`) e `criarRepositorioLocal(banco, agora?, aoEnfileirar?)` | RI-02, RI-03, `D-013` |
| `operacoes.ts` | as dez operações que a tela chama: gera id → lê a ficha → domínio → grava com fila | `D-029`, `D-013`, `D-040` |

**Como uma escrita acontece.** A tela chama uma operação (`receber`, `lancarVendaFiado`…). A
operação gera o id, lê a ficha pelo repositório, chama o domínio (`src/dominio/lancamentos.ts`),
e grava o que foi aceito. `gravarLancamento` e `gravarCliente` fazem `put` na tabela **e** põem um
item na fila **na mesma transação** — uma linha sem item na fila nunca subiria, e existir só neste
aparelho é EL-05 pela porta dos fundos. Recusa do domínio passa intacta, com o `motivo`, e nada é
gravado. A rede não aparece nesta pasta (RI-02).

**A linha é o tipo do domínio, sem mapeamento.** `Cliente` e `Lancamento` como `ficha.ts` os
define, parcelas e itens dentro, `bigint` como está. Sem campo de saldo (`D-039`), sem
`sincronizado` (a fila é a fonte, `D-013`). **Uma exceção, de E-07:** a linha do cliente é
`ClienteLocal = Cliente & { atualizadoEm }` — o carimbo do último-que-escreve, relógio do
aparelho, gravado por `gravarCliente` a cada gravação (`D-042`). Não é índice, não é migração,
e quem lê a ficha vê um `Cliente`.

**A fila é ponteiro, não cópia** (`D-040`): `{ ordem, tabela, registroId, criadoEm, versao?, problema? }`.
O que sobe é a linha como estiver na hora do envio; correção no lugar reescreve a linha e a fila já
aponta para ela. **No máximo um item pendente por registro.** A ordem é `++ordem` (autoincremento
local), porque UUIDv7 e `Date.now()` empatam no mesmo milissegundo e a fila precisa de FIFO —
cliente antes do lançamento que o cita. Desde E-07 (`D-042`): regravar uma linha que já está na
fila sobe a `versao` (para um envio em andamento não remover o item achando que subiu a versão
certa) e limpa o `problema` (se ela mexeu, tenta de novo). "Já subiu?" (para `D-013`) é
`repositorio.sincronizado(id)`: nenhum item na fila, nem pendente nem com problema.

**A tabela `sincronizacao`** (v2) guarda o cursor de download por tabela — o maior carimbo do
servidor já visto. É a primeira migração real do protocolo: só uma tabela nova, nenhum `upgrade`.

**Toda gravação avisa `aoEnfileirar`** (em `instancia.ts`), e é assim que a sincronização acorda
sem esta pasta a conhecer. A dependência é `sincronizacao → dados`, nunca o inverso.

Três pontos que não são detalhe:

- **`BigInt` não é chave válida em IndexedDB.** O campo monetário pode ser guardado, não indexado.
  Fica fora de todo índice por decisão, não por esquecimento (`D-022`) — e `testes/banco.test.ts`
  guarda uma **lista de permissão de índices**, porque o IndexedDB de mentira dos testes aceita
  `bigint` como chave e não acusaria.
- **O esquema é versionado, com migração.** Nunca edite uma versão publicada; acrescente a
  próxima com `.upgrade()`. O teste guarda uma cópia literal da v1 e da v2 e fica vermelho se
  `banco.ts` divergir. A base é aberta em `main.tsx`, na abertura, para a migração rodar ali.
- **Nome do banco: `controle-fiado`, escolhido uma vez.** Mudar é começar do zero no aparelho dela.

**Testes:** `testes/identidade.test.ts`, `banco.test.ts`, `repositorio.test.ts`, `operacoes.test.ts`,
sobre `fake-indexeddb` injetado no construtor (uma base por teste). É dublê de unidade da lógica
desta pasta — **não** prova EL-01/EL-05 (isso é navegador real, E-08, `D-033`).
