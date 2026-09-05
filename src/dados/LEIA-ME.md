# `src/dados`

A base local no aparelho — IndexedDB via Dexie (`D-020`) — e os repositórios que o domínio consome
**por interface**. O domínio não conhece o banco; é esta camada que sabe traduzir entre um e outro.

Todo registro nasce aqui com id gerado no dispositivo, UUIDv7, antes de qualquer rede (`D-029`,
RI-04, RN-14). É o que torna possível criar uma venda offline já referenciando seus itens e parcelas.

Dois pontos que não são detalhe:

- **`BigInt` não é chave válida em IndexedDB.** O campo monetário pode ser guardado, não indexado.
  Fica fora de todo índice por decisão, não por esquecimento (`D-022`).
- **O esquema é versionado, com migração.** O app vai evoluir no aparelho dela sem reinstalação.

Preenchida em **E-05**.
