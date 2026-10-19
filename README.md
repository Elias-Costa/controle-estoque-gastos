# Controle de Estoque e Fiado

**Fichinhas** é um aplicativo de controle de fiado para revenda de cosméticos. Organiza clientes, vendas, parcelas e recebimentos em fichas digitais, com consulta ao saldo e ao histórico de cada cliente.

## Funcionalidades

- **Clientes e fichas:** cadastro e atualização de dados, consulta de saldos, histórico de movimentações e desativação ou reativação de fichas.
- **Vendas:** registro de vendas à vista ou fiado, com descrição dos itens, preços editáveis e desconto opcional.
- **Parcelamento:** divisão em até seis parcelas, com valores e datas de vencimento ajustáveis.
- **Recebimentos:** registro de pagamentos totais ou parciais, com abatimento automático das parcelas em aberto, da mais antiga para a mais recente.
- **Cobrança:** consulta de clientes com saldo pendente, priorização por atraso e mensagens de cobrança ou recibo preparadas para envio manual pelo WhatsApp.
- **Saldo anterior:** inclusão de dívidas existentes, com opção de parcelamento, para transferir registros do caderno.
- **Correções e estornos:** correção de registros pendentes e estorno de lançamentos já sincronizados, com preservação do histórico financeiro.

## Uso sem conexão

Vendas e recebimentos podem ser registrados sem acesso à internet. As operações ficam no aparelho e são sincronizadas quando a conexão e o acesso à conta estão disponíveis. O aplicativo pode ser instalado na tela de início do celular e utilizado também no computador.

## Stack utilizada

| Camada | Tecnologias |
|---|---|
| Interface | React 19 e TypeScript 6 |
| Estilos | Tailwind CSS 4 |
| Armazenamento local | Dexie sobre IndexedDB |
| Banco de dados e autenticação | Supabase com PostgreSQL |
| Aplicativo instalável (PWA) | vite-plugin-pwa |
| Build | Vite 8 |
| Runtime e gerenciamento de pacotes | Bun |
| Qualidade e testes | oxlint, Bun Test e Playwright |

## Estado atual

Em uso real, com a gestão de fichas e fiado disponível. Controle de estoque, registro de gastos e indicadores do negócio estão previstos para as próximas fases.

## Verificação

Com Bun e Docker disponíveis, `bun run local:iniciar` prepara o Supabase local. Rodar
`bun run check`, `bun run test:integracao:local` e `bun run test:navegador:local`;
`bun run local:parar` conserva os dados fictícios. O Storage local faz parte dos testes de foto.
Cada rodada de integração/navegador usa uma conta fictícia nova e preserva as anteriores.

Homologação usa os comandos `test:integracao:homologacao` e `test:navegador:homologacao`,
com o projeto confirmado em `nuvem/destinos-de-teste.ts`. O mantenedor configura
`.env.homologacao.local` com `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`
(Session pooler, TLS), `SUPABASE_TESTE_EMAIL` e `SUPABASE_TESTE_SENHA`. Produção não recebe
suítes nem resets. `TESTE_NOME` é um filtro opcional de integração para diagnóstico;
removê-lo para executar o portão completo. A migration de fotos precede a publicação do app.
