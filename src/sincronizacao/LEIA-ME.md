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

Preenchida em **E-07**.
