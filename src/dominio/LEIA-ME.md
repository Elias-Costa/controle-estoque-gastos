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

Preenchida em **E-03** (dinheiro — feito) e **E-04** (a ficha).
