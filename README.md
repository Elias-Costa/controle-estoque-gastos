# Controle de Estoque e Fiado

Sistema de controle de **fiado**, estoque e gastos para quem revende cosméticos por conta própria (Avon, O Boticário, Natura). PWA offline-first, instalável na tela de início do celular.

O problema que ele resolve não é "controlar estoque": é **substituir um caderno de fichinhas de papel**, onde cada cliente tem uma página e os valores vão sendo descontados conforme o dinheiro chega. Quem vende fiado sem maquininha faz no caderno o parcelamento que o cartão faria — e paga por isso com contas que não fecham, páginas rasuradas e nenhuma noção de quanto tem a receber.

## O que o sistema faz

**Hoje (fase 1):**

**Fichas e fiado** — cadastro de clientes, vendas à vista ou fiado, parcelas com datas combinadas e valores editáveis, e recebimentos que abatem automaticamente a parcela em aberto mais antiga. O saldo de cada cliente é sempre derivado da soma dos lançamentos, nunca um campo guardado. Correção é estorno: nada de histórico financeiro é apagado.

**Cobrança** — lista de quem está devendo, em atraso primeiro, e mensagem de cobrança ou recibo montada pronta para o WhatsApp. O app escreve o texto; quem envia é a pessoa.

**Migração do caderno** — o saldo que um cliente já devia entra em uma linha (à vista ou em parcelas), e a última data digitada fica lembrada para a próxima ficha — sem tela própria para isso.

**Previsto, nas fases seguintes:**

**Estoque** — produtos com foto, entrada item a item com preço de custo, baixa automática na venda e aviso de estoque no mínimo.

**Gastos** — despesas do negócio e pessoais, separadas, para que o lucro real apareça em vez de se confundir com faturamento.

**Painel** — total a receber na rua com faixas de atraso, lucro do mês, vendas por período e o que está encalhado.

## Estado

**Fase 1 pronta em código.** Existem as telas de lista, ficha, cadastro, venda, recebimento, devedores e login; o domínio da ficha com dinheiro em `bigint`; a base local com a fila de envio; o esquema na nuvem com as invariantes financeiras e o isolamento por conta valendo no próprio banco; a sincronização entre aparelhos; a instalação (ícone, nome, imagens de abertura); e o mecanismo que leva uma versão nova ao aparelho na abertura seguinte.

O que está provado por teste:

- **Num iPhone real, antes de o sistema ser escrito:** `bigint` atravessa o IndexedDB do Safari sem perda; o armazenamento persistente é concedido com o PWA instalado; o dado sobrevive a reiniciar o aparelho; a escrita funciona em modo avião; o reenvio da fila é idempotente.
- **No Chromium, contra o build de produção** (`bun run test:navegador`): venda com a rede desligada que sobrevive a recarregar, reenvio que não duplica, dois aparelhos que convergem sem sumiço, base apagada que volta da nuvem, login que nunca bloqueia.
- **Direto no Postgres** (`bun run test:integracao`): cada invariante do esquema violada contornando o app, e recusada; o transporte real de ponta a ponta.
- **Unidade** (`bun run check`): aritmética em centavos, abatimento, saldo derivado sob centenas de fichas aleatórias, estorno, a leitura do que se digita no campo de dinheiro.

**O app já está em uso real e ela largou o caderno**, conforme relato do mantenedor em 2026-10-04. A duração desse uso e os testes offline de F1 no iPhone ainda precisam ser registrados. As telas partiram de um protótipo cronometrado (`prototipo/`, que continua no repositório como instrumento, não como código do app).

## Arquitetura

**Offline-first, e isso é a decisão central.** Toda escrita vai primeiro para o banco local no aparelho e só depois sobe para a nuvem, por uma fila de envio. O app não tem caminho de escrita que dependa de rede — o momento em que o sinal falha é exatamente o momento em que se está com o cliente na frente, e uma tela de erro ali é o que faz voltar para o caderno.

Três consequências disso atravessam o código inteiro:

- **Os ids nascem no dispositivo** (UUIDv7), antes de qualquer rede. O mesmo id é a chave de idempotência do envio, o que torna o reenvio seguro por construção.
- **Lançamento financeiro é imutável.** Venda e recebimento nunca são editados, só estornados (ou corrigidos no lugar enquanto ainda não subiram). Além de auditoria, isso elimina a classe de conflito que importaria entre dois aparelhos: registros que só nascem não têm o que conflitar.
- **Dinheiro é `bigint` de centavos.** Nunca ponto flutuante, em lugar nenhum — inclusive nos totais do painel. Dividir uma venda em parcelas não é divisão, é repartição: as partes precisam somar exatamente o total, e a sobra em centavos é distribuída explicitamente.

As invariantes financeiras valem **no banco** (constraints e políticas de linha), não apenas no código do aplicativo — e há uma suíte que tenta violar cada uma direto no Postgres, contornando o app, e espera a recusa.

As camadas são separadas por pasta, e a fronteira do domínio é aplicada por lint — não por combinado:

```
src/dominio/          regras do negócio, puras. Só importa caminhos relativos
src/dados/            base local (Dexie), repositório e as operações que a tela chama
src/sincronizacao/    fila de operações, envio, e a conta na nuvem
src/interface/        as telas, e as funções puras que decidem o que cada uma mostra
src/plataforma/       service worker, carimbo de versão, pedido de persistência, instalação
nuvem/                o esquema do Supabase: migrations versionadas e reversíveis, e o runner que as aplica
ferramentas/          geração dos PNG e comandos que preparam os ambientes de teste
supabase/             configuração dos serviços locais em Docker; migrations continuam em nuvem/
testes/               unidade (bun test), integração (Postgres real) e navegador (Playwright)
```

## Stack

| Camada | Escolha |
|---|---|
| Interface | React 19 + Vite + TypeScript, Tailwind v4 com componentes próprios, como SPA estática |
| Base local | Dexie (IndexedDB) |
| Nuvem | Supabase — Postgres, autenticação e Row Level Security. Migrations em `nuvem/migracoes/`, cada uma com o seu `.reverter.sql`, aplicadas por um runner próprio sobre `Bun.sql` |
| Runtime e pacotes | Bun — e `bun test` para os testes de unidade, com `fake-indexeddb` como dublê da base local (prova a lógica de `src/dados`, não o WebKit); a suíte de integração fala com o Postgres real por `Bun.sql`, o cliente embutido; a de navegador é Playwright sobre o Chromium |
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

Para o app **sincronizar com a nuvem** é preciso um `.env.local` na raiz com `VITE_SUPABASE_URL` e a chave `anon` em `VITE_SUPABASE_ANON_KEY`. Sem eles o app roda inteiro no aparelho, não toca a rede e o indicador fica em "para enviar" — é o comportamento esperado, não um defeito. Com eles, a fila só sobe depois de entrar: a tela inicial mostra "Entrar ›" enquanto não há sessão guardada no aparelho, e o usuário é criado no painel do Supabase (ver *Publicar*).

**Para aplicar migrations de produção** (`bun run migrar`) é preciso mais uma variável no mesmo `.env.local`: `SUPABASE_DB_URL` — no painel do Supabase, **Connect → Session pooler** (porta 5432), com o password do banco. É segredo e nunca entra no repositório; o runner não o imprime. Aplicação em produção é uma ação distinta, após validar localmente e em homologação.

**Os ambientes são local → homologação → produção.** Os atalhos `test:integracao` e `test:navegador` usam o Supabase **local**. Precisam de Docker funcionando; a CLI, fixada como dependência de desenvolvimento, sobe os serviços locais. O comando obtém as chaves locais em memória, cria uma conta fictícia e aplica as migrations pelo runner existente, sem arquivo de credenciais e sem reset.

```bash
bun run local:iniciar
bun run test:integracao:local
bun run test:navegador:local
bun run local:parar
```

`local:parar` preserva os dados fictícios. A primeira inicialização baixa as imagens Docker e prepara uma rede com preferência de vínculo a `127.0.0.1`. Nesta máquina, o Docker Desktop ainda anunciou as portas em `0.0.0.0`; o isolamento das portas da rede não está comprovado. Use o ambiente em rede confiável e pare os serviços ao terminar. As suítes acessam somente loopback e deixam linhas nesse ambiente; as provas direto no Postgres desfazem suas transações. Uma vez, instale o navegador com `bunx playwright install chromium`.

**Homologação:** criar outro projeto Supabase e confirmar seu identificador público antes de preencher `PROJETO_DE_HOMOLOGACAO` em `nuvem/destinos-de-teste.ts` (começa `null`, bloqueado). O mantenedor configura `.env.homologacao.local` com `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_DB_URL` (session pooler, porta 5432), `SUPABASE_TESTE_EMAIL` e `SUPABASE_TESTE_SENHA`. Criar uma conta fictícia em Authentication → Users → Add user, com auto-confirm. Os comandos `test:integracao:homologacao` e `test:navegador:homologacao` carregam somente esse arquivo e conferem se API e Postgres pertencem ao projeto confirmado. A homologação ainda aguarda criação e confirmação.

**A base de produção está em uso e seus dados reais não podem ser perdidos.** Confirme o destino separado antes de executar as suítes. Reset, limpeza por reversão de migrations e exclusão para testes são proibidos na produção; mudanças de esquema precisam preservar os dados existentes. Trabalhar na branch `developer` não muda o destino Supabase configurado.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run check` | Typecheck + lint + testes de unidade. É o portão de qualquer mudança |
| `bun run build` | Build de produção em `dist/` |
| `bun run preview` | Serve `dist/` na 4173, sem HTTPS — para olhar o build no desktop |
| `bun run build:local` | O build de produção **sem nuvem**, em `dist-local/`: as duas variáveis do Supabase entram vazias, o `supabase-js` some do bundle e nada do que se fizer nele pode subir. É o ambiente para cadastrar cliente fictício e lançar à vontade. `grep -l supabase.co dist-local/assets/*.js` devolve nada |
| `bun run preview:local` | Serve `dist-local/` na 4175, sem HTTPS — base própria no navegador, separada da do build real |
| `bun run preview:local:lan` | O mesmo, com HTTPS na rede local — para o celular |
| `bun run local:iniciar` / `local:parar` | Sobe ou para os serviços locais em Docker; não vincula projeto na nuvem nem apaga os dados fictícios |
| `bun run test:integracao` / `test:integracao:local` | Prepara o destino local e aplica migrations pendentes. Prova as invariantes direto no Postgres e o transporte real por Auth/PostgREST. Produção não recebe testes |
| `bun run test:navegador` / `test:navegador:local` | Prepara local, confere tipos, constrói o laboratório e prova offline, sincronização, restauração e login no Chromium. Não reutiliza servidor aberto de outra sessão |
| `bun run test:integracao:homologacao` / `test:navegador:homologacao` | As mesmas suítes no projeto hospedado de homologação confirmado, com configuração própria |
| `bun run build:laboratorio` | Prepara o Supabase local e constrói o app mais `window.laboratorio`, em `dist-laboratorio/`, ligado à API local. `dist/` nunca contém esse laboratório |
| `bun run preview:laboratorio` | Serve `dist-laboratorio/` na 4174, sem HTTPS — é o que o Playwright sobe sozinho |
| `bun run preview:laboratorio:lan` | O mesmo, com HTTPS na rede local — para dirigir o laboratório pelo console remoto de um celular |
| `bun run migrar` | Aplica no Supabase as migrations de `nuvem/migracoes/` que ainda não foram aplicadas; sem pendente, diz "nada a aplicar" |
| `bun run migrar:local` / `migrar:homologacao` | Aplica pendentes somente no destino de teste validado |
| `bun run migrar:reverter` / `migrar:local:reverter` | Reverte a última migration **local**, pelo seu `.reverter.sql`. O modo de reversão do runner exige destino de teste; produção é proibida |
| `bun run icones` | Gera de `public/favicon.svg` os PNG do ícone (`public/icones/`) e as imagens de abertura do iPhone (`public/abertura/`), pelo Chromium do Playwright. Determinístico: rodar sem mudar o SVG não altera nenhum PNG. Os PNG entram no git |
| `bun run dev` | Servidor de desenvolvimento na 5173 |
| `bun run dev:lan` | Idem, com HTTPS e exposto na rede local — para abrir no celular |
| `bun run preview:lan` | Serve o build de produção com HTTPS na rede local, na 5173 |
| `bun run prototipo` | O protótipo das telas em `prototipo/`, na porta 5174 (HTTP, sem service worker) |

`bun run typecheck`, `bun run lint` e `bun run test` existem soltos; `check` é os três em sequência.

## Testando com dado fictício

O app é offline-first: tudo o que se cadastra fica no IndexedDB do navegador, **por origem** (`localhost:4173`, `localhost:4175` e `https://192.168.x.x:5173` são três bases distintas), e só sobe depois de entrar numa conta. Para testar sem risco nenhum de tocar a nuvem, use o build sem nuvem:

```bash
bun run build:local
```

```bash
bun run preview:local
```

Abre `http://localhost:4175`, sem a linha "Entrar ›" e sem nenhuma requisição de rede — cadastre, venda, receba, desative, desfaça. O indicador fica em "N para enviar" para sempre: não há para onde enviar, e é o esperado. Para zerar a base fictícia: DevTools → *Application* → *Storage* → *Clear site data* (no celular, Chrome → configurações do site → limpar). No Chrome do computador, F12 → ícone de celular (Ctrl+Shift+M) → 375 de largura mostra as telas no tamanho do iPhone; a aba *Network* → *Offline* simula sem rede (em `localhost` o service worker funciona sem HTTPS). Para o celular, `bun run preview:local:lan` e o caminho da seção seguinte, na porta 4175.

Para provar a sincronização, use as suítes com Supabase local ou de homologação descritas acima. O build comum (`bun run build`) usa o projeto de `.env.local`; se for produção, reserve-o à operação real. Ausência de sessão não é isolamento de ambiente.

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

O app é uma SPA estática de uma rota: qualquer host de arquivos estáticos serve. No **Vercel**, o preset Vite basta, sem `vercel.json`: importar o repositório, build `bun run build`, output `dist`, e `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` nas variáveis do projeto. Cada push em `main` publica; build quebrado não publica e o anterior fica no ar.

**O desenvolvimento ocorre em `developer`; `main` é a branch de publicação** (mantenedor, 2026-10-04). O mantenedor faz os commits e a promoção das alterações para `main` depois da revisão e das validações pertinentes.

**O nome do projeto vira a origem, e a origem é a identidade do IndexedDB no aparelho.** Escolhido uma vez, nunca muda: trocar o domínio depois de instalado é começar do zero no celular.

**Versão nova entra na abertura seguinte**, nunca no meio de uma sessão — o service worker novo fica em espera e assume quando o app é aberto de novo. O carimbo `versão dd/mm, hh:mm` no rodapé da tela inicial diz qual build está no aparelho.

**Migration antes do deploy.** Quando uma versão traz migration nova em `nuvem/migracoes/`, rode `bun run migrar` contra o projeto **antes** do push que publica: o app envia as colunas que conhece em toda gravação, e sem a coluna no banco todo envio dessa tabela falha até a migration entrar. A base no aparelho não perde nada, mas a fila não sobe enquanto isso.

**Conta**, no painel do Supabase: *Authentication → Users → Add user* com auto-confirm. Em *Authentication → Sessions*, **Time-box user sessions** e **Inactivity timeout** em *never* — com prazo ali a sessão cai sozinha e o app para de enviar até alguém entrar de novo (a base local nunca é apagada por sessão). No aparelho, a tela inicial mostra "Entrar ›" enquanto não há sessão guardada; depois de entrar, a linha some e a fila sobe. Não há "Sair" nem "esqueci a senha" no app — recuperar acesso é caminho de quem administra o projeto, no painel.

No iPhone: abrir o endereço no Safari e *Compartilhar → Adicionar à Tela de Início* (o próprio app mostra esse caminho no pé da tela inicial enquanto não está instalado). No Android, o Chrome oferece a instalação pelo menu.

## Licença

[MIT](LICENSE) — use, modifique e redistribua à vontade, mantendo o aviso de copyright.

O sistema foi construído para uma revenda específica, mas o problema é comum a qualquer pessoa que venda fiado e anote em caderno. Se servir para a sua, fique à vontade.

## Privacidade

Este repositório contém **apenas código**. Nenhum dado de cliente, nenhum arquivo de configuração com credenciais e nenhuma captura de tela com nomes, telefones ou valores reais entra aqui — a base guarda informação financeira de dezenas de pessoas que não consentiram com publicação nenhuma.
