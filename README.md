# Controle de Estoque e Fiado

Sistema de controle de **fiado**, estoque e gastos para uma revendedora autônoma de cosméticos (Avon, O Boticário, Natura). PWA offline-first, instalável na tela de início do celular.

O problema que ele resolve não é "controlar estoque": é **substituir um caderno de fichinhas de papel**, onde cada cliente tem uma página e a dona vai descontando os valores conforme o dinheiro chega. Quem vende fiado sem maquininha faz no caderno o parcelamento que o cartão faria — e paga por isso com contas que não fecham, páginas rasuradas e nenhuma noção de quanto tem a receber.

## O que o sistema faz

**Fichas e fiado** — cadastro de clientes, vendas à vista ou fiado, parcelas com datas combinadas, e recebimentos que abatem automaticamente a parcela em aberto mais antiga. O saldo de cada cliente é sempre derivado da soma dos lançamentos, nunca um campo guardado. Correção é estorno: nada de histórico financeiro é apagado.

**Cobrança** — lista de devedores ordenada por atraso, e mensagem de cobrança ou recibo montada pronta para o WhatsApp. O app escreve o texto; quem envia é ela.

**Estoque** — produtos com foto, entrada item a item com preço de custo, baixa automática na venda e aviso de estoque no mínimo.

**Gastos** — despesas do negócio e pessoais, separadas, para que o lucro real apareça em vez de se confundir com faturamento.

**Painel** — total a receber na rua com faixas de atraso, lucro do mês, vendas por período e o que está encalhado.

## Estado

**Em desenvolvimento. A fundação do repositório está pronta; as telas ainda não existem.**

A arquitetura foi provada no aparelho real antes de o sistema ser escrito — no iPhone, não no desktop:

- `bigint` atravessa o IndexedDB do Safari sem perda de precisão
- O armazenamento persistente é concedido com o PWA instalado na tela de início
- **O dado sobrevive a reiniciar o aparelho**
- A escrita funciona em modo avião, sem tocar na rede
- O reenvio da fila é idempotente: o mesmo item enviado duas vezes não vira duas linhas

O que existe hoje é a fundação: as fronteiras entre as camadas, a garantia de que dinheiro nunca vira
ponto flutuante, o mecanismo que leva uma versão nova ao aparelho, o domínio da ficha, a base local
com a fila de envio, o esquema na nuvem com as invariantes financeiras e o isolamento por conta
valendo no próprio banco, a sincronização entre aparelhos, e a prova de offline em navegador real
(`bun run test:navegador`): venda com a rede desligada que sobrevive a recarregar, reenvio que não
duplica, dois aparelhos que convergem sem sumiço, base apagada que volta da nuvem — verde no
Chromium de desktop em 2026-09-12.

Há também um **protótipo navegável** em `prototipo/` — as telas de ficha, venda fiado e recebimento,
clicáveis, com dados inventados e sem persistência nenhuma. Ele não é o aplicativo e não vira o
aplicativo: existe para cronometrar, com a usuária, se lançar no app é mais rápido que anotar no
papel. Se não for, o sistema não serve — e essa medição ainda não aconteceu.

## Arquitetura

**Offline-first, e isso é a decisão central.** Toda escrita vai primeiro para o banco local no aparelho e só depois sobe para a nuvem, por uma fila de envio. O app não tem caminho de escrita que dependa de rede — o momento em que o sinal falha é exatamente o momento em que ela está com a cliente na frente, e uma tela de erro ali é o que faz voltar para o caderno.

Três consequências disso atravessam o código inteiro:

- **Os ids nascem no dispositivo** (UUIDv7), antes de qualquer rede. O mesmo id é a chave de idempotência do envio, o que torna o reenvio seguro por construção.
- **Lançamento financeiro é imutável.** Venda e recebimento nunca são editados, só estornados. Além de auditoria, isso elimina a classe de conflito que importaria entre dois aparelhos: registros que só nascem não têm o que conflitar.
- **Dinheiro é `bigint` de centavos.** Nunca ponto flutuante, em lugar nenhum — inclusive nos totais do painel. Dividir uma venda em parcelas não é divisão, é repartição: as partes precisam somar exatamente o total, e a sobra em centavos é distribuída explicitamente.

As invariantes financeiras valem **no banco** (constraints e políticas de linha), não apenas no código do aplicativo — e há uma suíte que tenta violar cada uma direto no Postgres, contornando o app, e espera a recusa.

As camadas são separadas por pasta, e a fronteira do domínio é aplicada por lint — não por combinado:

```
src/dominio/          regras do negócio, puras. Só importa caminhos relativos
src/dados/            base local (Dexie), repositório e as operações que a tela chama
src/sincronizacao/    fila de operações e envio
src/interface/        as telas
src/plataforma/       service worker, carimbo de versão e pedido de persistência
nuvem/                o esquema do Supabase: migrations versionadas e reversíveis, e o runner que as aplica
```

## Stack

| Camada | Escolha |
|---|---|
| Interface | React + Vite + TypeScript, como SPA estática |
| Base local | Dexie (IndexedDB) |
| Nuvem | Supabase — Postgres, autenticação e Row Level Security. Migrations em `nuvem/migracoes/`, cada uma com o seu `.reverter.sql`, aplicadas por um runner próprio sobre `Bun.sql` |
| Runtime e pacotes | Bun — e `bun test` para os testes de unidade, com `fake-indexeddb` como dublê da base local (prova a lógica de `src/dados`, não o WebKit); a suíte de integração fala com o Postgres real por `Bun.sql`, o cliente embutido |
| PWA | `vite-plugin-pwa` |

Não há renderização no servidor: o app é instalado e funciona offline, então o artefato é estático.

## Rodando localmente

Requisito: [Bun](https://bun.sh).

```bash
bun install
```

```bash
bun run dev
```

Para o app **sincronizar com a nuvem** é preciso um `.env.local` na raiz com `VITE_SUPABASE_URL` e a chave `anon` em `VITE_SUPABASE_ANON_KEY`. Sem eles o app roda inteiro no aparelho, não toca a rede e o indicador fica em "para enviar" — é o comportamento esperado, não um defeito. Com eles, a fila só sobe quando há sessão; até E-13 (login) a sessão vem de um usuário de teste (ver `nuvem/LEIA-ME.md`).

**Para mexer no esquema da nuvem** (`bun run migrar`, `bun run test:integracao`) é preciso mais uma variável no mesmo `.env.local`: `SUPABASE_DB_URL`, a conexão direta ao Postgres — no painel do Supabase, **Connect → Session pooler** (porta 5432), com o password do banco. É segredo e nunca entra no repositório; o runner e a suíte não o imprimem. Detalhes em `nuvem/LEIA-ME.md`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | Servidor de desenvolvimento |
| `bun run dev:lan` | Idem, com HTTPS e exposto na rede local — para abrir no celular |
| `bun run build` | Build de produção |
| `bun run preview:lan` | Serve o build de produção com HTTPS na rede local |
| `bun run test` | Testes de unidade, com o runner do Bun |
| `bun run check` | Typecheck + lint + testes. É o portão de qualquer mudança |
| `bun run test:integracao` | As suítes contra o projeto real. `nuvem.test.ts` tenta violar cada invariante direto no Postgres (precisa de `SUPABASE_DB_URL`; não deixa rastro). `sincronizacao.test.ts` sobe e baixa linhas pelo `supabase-js` com um usuário de teste (`SUPABASE_TESTE_EMAIL`/`SUPABASE_TESTE_SENHA`); **deixa linhas no banco**, sob o usuário de teste — limpeza em `nuvem/LEIA-ME.md` |
| `bun run test:navegador` | A prova de offline (RT-07 a RT-10) no Chromium do Playwright, contra o build de laboratório. Precisa do mesmo usuário de teste; sem ele, pula. Uma vez: `bunx playwright install chromium`. Também deixa linhas no banco |
| `bun run build:laboratorio` | O build de produção mais `window.laboratorio`, em `dist-laboratorio/` — só para os testes de navegador. `dist/` nunca o contém |
| `bun run preview:laboratorio:lan` | Serve `dist-laboratorio/` com HTTPS na rede local, na 4174 — para o roteiro à mão no Android (`testes/navegador/LEIA-ME.md`) |
| `bun run migrar` | Aplica no Supabase as migrations de `nuvem/migracoes/` que ainda não foram aplicadas |
| `bun run migrar:reverter` | Reverte a última migration aplicada, pelo seu `.reverter.sql` |
| `bun run icones` | Gera de `public/favicon.svg` os PNG do ícone (`public/icones/`) e as imagens de abertura do iPhone (`public/abertura/`), pelo Chromium do Playwright (`ferramentas/LEIA-ME.md`). Rodar quando o ícone mudar; os PNG entram no git |
| `bun run prototipo` | Protótipo das telas em `prototipo/`, na porta 5174 (HTTP, sem service worker) |

## Testando no celular

O service worker, a instalação na tela de início e a câmera exigem HTTPS — e `localhost` não vale pela rede.

```bash
bun run dev:lan
```

O Vite imprime o endereço da sua máquina na rede (`https://192.168.x.x:5173`). No celular, **no mesmo Wi-Fi**, abra esse endereço, aceite o aviso de certificado auto-assinado e use *Compartilhar → Adicionar à Tela de Início*.

Dois tropeços comuns:

- **Windows classifica o Wi-Fi doméstico como rede Pública** e bloqueia a entrada. Libere a porta com `New-NetFirewallRule -DisplayName "Vite" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow` num PowerShell como Administrador.
- **O service worker de desenvolvimento quase não faz cache.** Para testar comportamento offline de verdade, use `bun run build` seguido de `bun run preview:lan` — contra o servidor de desenvolvimento o teste falha por motivo errado.

## Publicar

O app é publicado no **Vercel**, sem domínio próprio, com deploy automático a cada push em `main` — todo commit chega ao aparelho dela na abertura seguinte (`D-026`, `D-032`, `D-043`). É uma SPA estática de uma rota: o preset Vite do Vercel basta, sem `vercel.json`.

Uma vez, no painel do Vercel:

1. *Add New → Project*, importar este repositório do GitHub.
2. **Nome do projeto: `controle-fiado`.** O nome vira a origem (`https://controle-fiado.vercel.app`) e **a origem é a identidade do IndexedDB no aparelho dela: escolhido uma vez, nunca muda.** Se o subdomínio estiver tomado, escolha outro *antes* de instalar no aparelho e registre em `docs/decisions.md` (`D-043`).
3. Framework preset *Vite*; build `bun run build`; output `dist`.
4. *Environment Variables*: `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`, os mesmos de `.env.local`. (Sem eles o build sai sem nuvem: o app funciona só no aparelho e o indicador fica em "para enviar".)
5. *Deploy*. Depois, cada push em `main` publica sozinho; build quebrado não publica e o anterior fica no ar.

No iPhone dela: abrir o endereço no Safari e *Compartilhar → Adicionar à Tela de Início* (o próprio app mostra esse caminho no pé da tela inicial enquanto não está instalado). **Instalar cedo, mesmo sem entrar** (`D-036`): o app instalado é o laboratório de "uma semana sem abrir" (RT-13) e da troca de versão (`D-032`). O carimbo `versão dd/mm, hh:mm` no rodapé diz qual build está no aparelho.

**A conta dela** (E-13, `D-005`, `D-048`), uma vez, no painel do Supabase:

1. *Authentication → Users → Add user*, com auto-confirm, **num e-mail que você acessa** — recuperar senha é caminho seu, não dela.
2. *Authentication → Sessions*: **Time-box user sessions** e **Inactivity timeout** em *never* — conferir no painel; o agente não viu o valor. Com prazo ali a sessão cai sozinha: o app não perde a base, mas para de enviar até alguém entrar de novo.
3. No aparelho dela, com o app aberto: a tela inicial mostra **"Entrar ›"** sob o indicador enquanto não há sessão guardada. Tocar, digitar e-mail e senha, "Entrar". A linha some, a fila sobe, e na prática ela não vê essa tela de novo. Não há "Sair".

## Licença

[MIT](LICENSE) — use, modifique e redistribua à vontade, mantendo o aviso de copyright.

O sistema foi construído para uma revendedora específica, mas o problema é comum a qualquer pessoa que venda fiado e anote em caderno. Se servir para a sua, fique à vontade.

## Privacidade

Este repositório contém **apenas código**. Nenhum dado de cliente, nenhum arquivo de configuração com credenciais e nenhuma captura de tela com nomes, telefones ou valores reais entra aqui — a base guarda informação financeira de dezenas de pessoas que não consentiram com publicação nenhuma.
