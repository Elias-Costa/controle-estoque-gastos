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

Preenchida em **E-03** (dinheiro) e **E-04** (a ficha).
