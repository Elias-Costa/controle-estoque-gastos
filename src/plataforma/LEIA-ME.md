# `src/plataforma`

O invólucro do app: service worker, carimbo de build, instalação. Não é domínio, não é dado, não é
sincronização de dados e não é tela — por isso tem pasta própria.

**Como uma versão nova chega ao aparelho dela** (`D-032`) mora aqui, e é o caminho pelo qual ela
recebe correções. Uma correção que não chega é indistinguível de um defeito que não foi corrigido.
A decisão é atualizar **na próxima abertura**: a sessão em andamento nunca é recarregada.

O **carimbo de build** é critério de aceite de RF-23, não conveniência. Sem ele, "testei e deu X" é
afirmação sobre versão desconhecida — foi o que custou uma rodada inteira de teste em 2026-09-05.
