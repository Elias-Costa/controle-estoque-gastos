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

Em uso real, com a gestão de fichas e fiado disponível. O controle de estoque está implementado
em desenvolvimento e aguarda a validação de uso e a entrega. Gastos e indicadores do negócio
continuam previstos para as próximas fases.

## Verificação

Com Bun e Docker disponíveis, `bun run local:iniciar` prepara o Supabase local. Rodar
`bun run check`, `bun run test:integracao:local` e `bun run test:navegador:local`;
`bun run local:parar` conserva os dados fictícios. O Storage local faz parte dos testes de foto.
Cada rodada de integração/navegador usa uma conta fictícia nova e preserva as anteriores.

`bun run test:interface` constrói o app sem nuvem e verifica contraste dos campos, alvos,
foco, texto ampliado e ações fixas no Chromium, com dados fictícios em contextos isolados.
Não precisa de Docker nem de credenciais. Usa a porta 4176 e não substitui as suítes de
integração/sincronização ou a validação em aparelho real. Requer o Chromium do Playwright
(`bunx playwright install chromium`, uma vez).

Homologação usa os comandos `test:integracao:homologacao` e `test:navegador:homologacao`,
com o projeto confirmado em `nuvem/destinos-de-teste.ts`. O mantenedor configura
`.env.homologacao.local` com `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`
(Session pooler, TLS), `SUPABASE_TESTE_EMAIL` e `SUPABASE_TESTE_SENHA`. Produção não recebe
suítes nem resets. `TESTE_NOME` é um filtro opcional de integração para diagnóstico;
removê-lo para executar o portão completo. Antes da publicação de estoque, o mantenedor roda
`bun run migrar` em produção: o runner aplica somente pendentes, em ordem, de `0004_estoque`
até `0007_conferencia-por-identidade`, preservando os dados de F1. Só depois promove para
`main`, que publica pelo deploy existente. Não reverter migrations nem limpar dados para
atualizar o app; conferir carimbo, fichas e envios pendentes na abertura seguinte.

## Android pelo Wi-Fi nos testes

O preview LAN pode usar um certificado local cuja autoridade foi instalada manualmente no
Android. Defina `CERTIFICADO_HTTPS_LOCAL` e `CHAVE_HTTPS_LOCAL` com caminhos absolutos para
o certificado de servidor e sua chave; `preview:laboratorio:lan` e `preview:local:lan` usam
o par em HTTPS. Os arquivos devem ficar fora do repositório e da pasta `public`.
Sem o par, LAN conserva o certificado autoassinado anterior, sem comprovação de confiança
no aparelho. As variáveis locais não são consumidas quando `LAN` está desligado.

Para enviar somente o certificado público da autoridade ao telefone:

```powershell
bun --no-env-file run ferramentas/servir-certificado-local.ts '<caminho-absoluto-do-rootCA.pem>' '<IPv4-do-PC>'
```

O comando informa uma URL HTTP na porta 4176 e o SHA-256 público; a única rota de download
é `/fichinhas-teste.crt`. No Android, instalar como certificado de CA, depois abrir o app
em `https://<IPv4-do-PC>:4174`, usando build e conta de homologação. A 4175 é reservada ao
build sem nuvem. PC e Android devem estar no mesmo Wi-Fi, com as portas liberadas apenas
na rede local. Encerrar o servidor de certificado após o download. Não compartilhar chaves
privadas; não trocar IP, HTTPS ou porta durante uma prova de retenção local.
