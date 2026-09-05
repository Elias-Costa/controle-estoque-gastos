# `src/interface`

As telas dela. React, com Tailwind e componentes próprios (`D-023`).

**Esta é a camada onde o projeto morre ou vive.** EL-08 — lançar no app ser mais lento que anotar no
papel — é a falha mais provável do projeto e a única que nenhum teste automatizado detecta. Nenhuma
tela é dada por pronta sem responder: isto é mais rápido que a caneta dela?

Regras que valem aqui e não são negociáveis por tela:

- Alvo de toque mínimo de 44×44 pt e tipografia grande **por padrão** (RNF-03), não por lembrança.
- Vocabulário dela: "fiado", "ficha", "recebi", "deve". Nunca "registro", "entidade", "sincronizar"
  (RI-07).
- Nenhuma decisão é pedida a ela que o sistema consiga tomar sozinho (RI-08).
- Nenhuma tela espera rede para renderizar (RNF-04).

`number` é legítimo aqui, na borda de formatação — e é por isso que a guarda de lint de EL-03 fica no
domínio e não solta pelo projeto.

Preenchida a partir de **E-02** (protótipo validado com a usuária) e **E-09**.
