# Fichinhas

Aplicativo de controle de fiado e estoque para revenda de cosméticos. Substitui o caderno de anotações: organiza clientes, vendas, parcelas, recebimentos, produtos e caixa, e funciona no celular mesmo sem internet.

É um aplicativo web instalável (PWA): pode ser adicionado à tela de início do iPhone ou do Android e usado também no computador.

## Funcionalidades

**Fiado**

- **Clientes e fichas:** cadastro e atualização de dados, saldo e histórico de cada cliente, desativação e reativação de fichas.
- **Vendas:** à vista ou fiado, com produto do estoque ou item avulso, preço editável e desconto opcional.
- **Parcelamento:** de 1 a 6 parcelas, com valores e vencimentos ajustáveis.
- **Recebimentos:** pagamentos totais ou parciais, abatidos automaticamente das parcelas em aberto, da mais antiga para a mais recente.
- **Saldo anterior:** inclusão das dívidas que já existiam no caderno, com opção de parcelamento.
- **Correções e estornos:** anotações ainda não enviadas podem ser corrigidas; lançamentos já enviados são corrigidos por estorno, sem apagar o histórico.
- **Cobrança pelo WhatsApp:** lista de quem deve, ordenada por atraso, e mensagens de cobrança e recibo montadas a partir de quatro modelos editáveis. O envio é sempre feito pela própria pessoa, no WhatsApp.

**Estoque**

- **Produtos:** cadastro com foto, marca, categoria, preço de custo e de venda e estoque mínimo.
- **Movimentação:** entrada item a item, baixa automática na entrega, controle do que foi vendido e ainda está "a entregar", trocas, devoluções e ajustes com motivo.
- **Reposição:** lista dos produtos que chegaram ao estoque mínimo.
- **Divulgação:** PDF dos produtos disponíveis, com filtros por categoria, marca e sexo e com o nome e o logo da loja, para compartilhar pelo WhatsApp.

**Gestão**

- **Caixa:** despesas e receitas avulsas, marcadas como do negócio ou pessoais, e o caixa do mês.
- **Resumo:** valor a receber (vencido e a vencer), lucro apurável do mês, vendas por período e produtos com estoque baixo ou encalhados, com prazo de encalhe ajustável.
- **Lembretes:** parcelas vencendo ou atrasadas, produtos no mínimo e resumo do caixa do mês, na tela inicial e por notificação quando o aparelho permite.
- **Cópia das anotações:** arquivo ZIP com fichas, estoque, caixa, fotos, modelos de mensagem e histórico, além de consultas em CSV, que recupera tudo numa instalação vazia da mesma conta. Também há cópia automática diária no Google Drive conectado pelo app. O arquivo contém nomes, telefones e valores e não tem senha própria: deve ser guardado em local privado.

## Uso sem conexão

Vendas, recebimentos e demais anotações são gravados primeiro no aparelho, sem depender da internet, e enviados à nuvem quando há conexão e acesso à conta. Cada anotação nasce com identificador próprio e chave de idempotência, então reenviar não duplica nada.

Se uma anotação for recusada no envio, o aviso explica o motivo. Quando falta a descrição de um item vendido, o app permite completá-la sem alterar valores, datas ou parcelas; nos demais casos, oferece relatar o problema pelo WhatsApp.

## Princípios do projeto

- **Dinheiro em centavos inteiros**, nunca em ponto flutuante.
- **Histórico financeiro imutável:** nenhum lançamento é apagado; correção é estorno.
- **Escrita local primeiro:** nenhuma anotação depende da rede para ser concluída.
- **Regras financeiras garantidas também no banco**, por gatilhos e políticas de acesso (RLS), e não só no app.
- **Domínio isolado:** `src/dominio` não importa nada externo, e o lint impõe essa fronteira.
- **Vocabulário do negócio no código:** `Ficha`, `Fiado`, `Recebimento`, `Parcela`, `Estorno`.

## Stack

| Camada | Tecnologias |
|---|---|
| Interface | React 19, TypeScript 6 e Tailwind CSS 4 |
| Armazenamento no aparelho | Dexie sobre IndexedDB |
| Nuvem | Supabase: PostgreSQL, autenticação, Storage e funções Edge |
| Aplicativo instalável | vite-plugin-pwa com Workbox |
| Integrações | Web Push (lembretes) e Google Drive (cópia automática) |
| Documentos | jsPDF (divulgação) e zip.js (cópia em arquivo) |
| Build | Vite 8 |
| Runtime e pacotes | Bun |
| Qualidade e testes | oxlint, Bun Test e Playwright |

## Como rodar

Pré-requisitos: [Bun](https://bun.sh) (testado com a versão 1.4) e, apenas para os testes com Supabase local, Docker.

```bash
bun install
bun run dev
```

Sem variáveis de ambiente, o app funciona inteiro no aparelho, sem nuvem: as anotações ficam guardadas localmente, aguardando envio. Para conectá-lo a um projeto Supabase, crie um `.env.local` (ignorado pelo git) com:

| Variável | Uso |
|---|---|
| `VITE_SUPABASE_URL` | URL do projeto, embutida no build |
| `VITE_SUPABASE_ANON_KEY` | Chave pública (anon), embutida no build |
| `SUPABASE_DB_URL` | Conexão Postgres usada por `bun run migrar` |

Build de produção e pré-visualização:

```bash
bun run build
bun run preview
```

O comportamento sem conexão deve ser conferido no build (`preview`), nunca no servidor de desenvolvimento.

## Testes

```bash
bun run check
```

Roda typecheck, oxlint e os testes unitários. É o portão de qualquer mudança.

**Integração e navegador**, contra um Supabase local em Docker, só com dados fictícios e sem `.env`:

```bash
bun run local:iniciar
bun run test:integracao:local
bun run test:navegador:local
bun run local:parar
```

Os comandos validam que o destino é local, aplicam as migrations pendentes e criam uma conta fictícia nova a cada rodada. A integração prova as garantias do banco (imutabilidade, RLS, gatilhos) e o transporte real de sincronização e fotos. `local:parar` conserva os dados fictícios.

**Interface**, sem Docker e sem credenciais:

```bash
bunx playwright install chromium
bun run test:interface
```

Constrói o app sem nuvem e verifica no Chromium contraste, alvos de toque, foco, texto ampliado e ações fixas, com dados fictícios em contextos isolados. Usa a porta 4176. A instalação do Chromium só é necessária uma vez. Não substitui as suítes de integração nem o teste em aparelho real.

**Homologação:** `test:integracao:homologacao` e `test:navegador:homologacao` rodam contra um projeto Supabase separado, identificado em `nuvem/destinos-de-teste.ts`. As credenciais ficam em `.env.homologacao.local`: as três variáveis acima (com `SUPABASE_DB_URL` pelo Session pooler, com TLS) mais `SUPABASE_TESTE_EMAIL` e `SUPABASE_TESTE_SENHA`. Sem destino confirmado, os comandos recusam a conexão.

## Ambientes e publicação

- **Local → homologação → produção.** As suítes de teste rodam só em local e homologação. A produção guarda dados reais e não recebe testes, resets nem reversão de migrations.
- **Migrations** ficam em `nuvem/migracoes/`, sempre em pares `NNNN_nome.sql` e `NNNN_nome.reverter.sql`. Migration aplicada não se edita: a correção entra na seguinte. `bun run migrar` aplica somente as pendentes, em ordem, preservando os dados; `bun run migrar:reverter` atua apenas no ambiente local.
- **Funções Edge** (`enviar-lembretes` e `enviar-backup`) e seus segredos são preparados por comandos próprios de cada ambiente (`lembretes:*` e `backup:*`, no `package.json`). Em produção, cada comando exige o projeto explícito (`--projeto=<id>`) e confere API e banco antes de conectar. O passo a passo fica na documentação operacional, que não é publicada.
- **Branches:** `developer` para desenvolvimento e `main` para publicação. O `bun run build` gera o site estático publicado a partir da `main`.

## Estrutura do repositório

| Pasta | Conteúdo |
|---|---|
| `src/dominio` | Regras do negócio (dinheiro, parcelas, saldos, estoque), sem dependências externas |
| `src/dados` | Base local (Dexie) e operações atômicas |
| `src/sincronizacao` | Fila de envio, conta e transporte para o Supabase |
| `src/interface` | Telas e componentes React |
| `src/plataforma` | Recursos do navegador: arquivos, fotos, PDF, notificações e service worker |
| `nuvem` | Migrations, runner, funções Edge e backup |
| `supabase` | Configuração do Supabase local |
| `ferramentas` | Scripts de ambiente de teste, empacotamento e ícones |
| `testes` | Testes de unidade, integração, navegador e interface |
| `public` | Ícones, telas de abertura e avisos de licença |

## Licença

Código sob a licença MIT ([LICENSE](LICENSE)). Os avisos das bibliotecas e fontes distribuídas com o app ficam em [`public/licencas/`](public/licencas/): zip.js (BSD-3-Clause), jsPDF (MIT) e Noto Sans (SIL Open Font License 1.1).
