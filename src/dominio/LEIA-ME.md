# `src/dominio`

As regras do negócio dela, como código puro: cliente, venda, item, parcela, recebimento, estorno,
dinheiro. O vocabulário é o dela, em português (`AGENTS.md` §4) — `Ficha`, `Fiado`, `Recebimento`,
`Parcela`, `Estorno`.

**Pode importar:** apenas caminhos relativos, ou seja, apenas o próprio domínio.

**Não pode importar:** React, Dexie, Supabase, nada de `node_modules`. Isso não é convenção — o lint
reprova (`.oxlintrc.json`, `no-restricted-imports`), e reprova por lista de permissão: uma
dependência nova nasce barrada sem ninguém precisar lembrar de proibi-la.

**Dinheiro aqui é `bigint` de centavos** (`D-022`, RI-01, RN-10). `parseFloat`, `parseInt`,
`Number`, `Math`, `.toFixed()` e companhia são reprovados pelo lint nesta pasta, cada um com a
mensagem citando a decisão. A guarda forte é o compilador — `bigint` não mistura com `number` —;
o lint é a segunda linha, na borda de formatação.

Esta camada é testável sem navegador. É o que permite que E-03 e E-04 rodem em `bun test`.

## `dinheiro.ts` (E-03)

| Exporta | O que faz | Regra |
|---|---|---|
| `Centavos` | `bigint` de centavos — apelido, não invólucro | `D-022` |
| `somar(lista)` | soma de lista, vazia dá `0n` | RN-01 (E-04) |
| `multiplicar(valor, vezes)` | preço × quantidade, exato | `D-022` |
| `repartir(total, vezes)` | parcelas em múltiplos de 5 centavos, a primeira carrega a diferença, soma = total | `D-012`, `D-030` |
| `lerDinheiro(texto)` | o que ela digita → centavos, ou `null` se não é um valor | `D-034` + emenda |
| `emReais(centavos)` | `"R$ 1.234,56"`, sem `Intl` | RNF-03 |

**Dinheiro é `bigint`; contagem é `number`.** Número de parcelas e quantidade entram como
`number`, e o compilador recusa `preco + quantidade` — dinheiro e contagem não se misturam por
construção. A única conversão é `BigInt(vezes)`, dentro do módulo, validada.

**Soma, subtração e comparação de dois valores são os operadores nativos** (`+`, `-`, `<`, `===`).
Não há `somarDois`, `subtrair` nem `comparar`: foi pelos operadores que `D-022` escolheu `bigint`.

Testes: `testes/dinheiro.test.ts` (RT-01). Os quatro casos de `D-030`, 999.999,99, uma propriedade
exaustiva (0..10.000 centavos × 1..12 parcelas) e uma tabela de leitura, um teste por linha.

Preenchida em **E-03** (dinheiro) e **E-04** (a ficha) — as duas feitas.

## `ficha.ts` e `lancamentos.ts` (E-04)

A ficha em dois arquivos: **o que ela mostra** (`ficha.ts`) e **o que ela lança** (`lancamentos.ts`).
A regra que atravessa os dois é `D-039`: **nada é guardado, tudo é derivado**. Não há campo de
saldo, não há marca de "parcela paga", não há "este recebimento abateu aquela parcela". Saldo e
parcelas nascem da mesma soma, então não têm como divergir (EL-02).

**`ficha.ts` — leitura**

| Exporta | O que faz | Regra |
|---|---|---|
| `Lancamento` = `Venda` \| `SaldoAnterior` \| `Recebimento` \| `DescontoQuitacao` \| `Estorno` | os tipos, todos `readonly` — lançamento não muda, se corrige por estorno ou substituição | RI-03, `D-013` |
| `Ficha` | `readonly Lancamento[]` de uma cliente; é tudo que existe | RN-01 |
| `saldo(ficha)` | débitos vigentes − recebimentos e descontos vigentes | RN-01 |
| `parcelas(ficha)` | as parcelas por vencimento, com `pago`/`restante` derivados do total recebido escorrendo pela lista | RN-02, `D-006` |
| `proximaParcela`, `situacaoDaParcela(p, hoje)` | a próxima a cobrar; paga / vencida / a vencer | RF-02 |
| `historico(ficha)` | ordem cronológica inversa, estorno como linha própria, alvo marcado | RF-02, RF-08 |
| `validar(ficha)` | **todas** as invariantes num lugar só; toda operação passa por aqui | — |
| `Resultado<T>`, `Motivo` | `ok` com valor, ou `motivo` em código; a tela põe as palavras | RI-07 |
| `LIMITE_QUITACAO` | `10n` — até onde "considerar pago" alcança | RN-15, `D-031` |

**`lancamentos.ts` — escrita**

| Exporta | O que faz | Regra |
|---|---|---|
| `novoCliente`, `novaVendaFiado`, `novaVendaAVista`, `novoSaldoAnterior` | construtores; `id` e `data` entram de fora | RF-01, RF-03, RN-04, RF-07 |
| `registrarRecebimento(ficha, e)` → `{ recebimento, troco }` | limita ao saldo; o troco é informação da tela, não lançamento | RN-03, `D-016` |
| `calcularTroco(saldo, valor)` | a mesma conta, para a tela mostrar o troco antes de confirmar | `D-016` |
| `podeConsiderarPago`, `considerarPago` | o resíduo de até R$ 0,10 vira desconto de quitação | RN-15, `D-031` |
| `estornar(ficha, e)` | lançamento inverso; recusa alvo inexistente, estorno de estorno, alvo já estornado e **ficha que ficaria negativa** | RN-07, `D-039` |
| `caminhoDeCorrecao(sincronizado)` | `'corrigir'` antes de sincronizar, `'estornar'` depois — nunca os dois | `D-013` |
| `corrigir(ficha, substituto, { sincronizado })` | substituição pelo mesmo id, só antes de sincronizar; parcela paga não muda | `D-013`, RN-08 |
| `renegociarParcelas(ficha, id, parcelas, { sincronizado })` | `corrigir` restrito às parcelas: soma = total, paga intocada | RN-08, `D-012` |

**Três coisas que quem vai escrever E-05, E-10 e E-11 precisa saber:**

- **O domínio não conhece a fila.** "Já sincronizou?" entra como argumento (`{ sincronizado }`),
  porque a fila é de E-07 e a regra é de `D-013`. Quem chama `corrigir` pergunta à fila antes.
- **Estornar um débito já pago é recusado** (`ficha-ficaria-negativa`, `D-039`). Estorna-se o
  recebimento antes. Para renegociar uma venda **já sincronizada**: lança a venda nova, depois
  estorna a velha — os recebimentos escorrem para a nova pela ordem de vencimento.
- **Corrigir "cliente errado" atravessa duas fichas.** O domínio é por ficha: `validar` na origem
  sem o lançamento, `validar` no destino com ele. É E-05 quem faz os dois lados.

Testes: `testes/ficha.test.ts` (RT-02, RT-04 com a prova de EL-02 — 200 fichas × 60 operações
ao acaso, saldo conferido contra duas somas independentes a cada passo) e
`testes/lancamentos.test.ts` (RT-03, RT-05, RN-15, `D-013`, RN-08). Verificados por mutação:
sete mutações, sete acusadas.
