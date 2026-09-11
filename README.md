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
ponto flutuante e o mecanismo que leva uma versão nova ao aparelho.

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

As invariantes financeiras valem **no banco** (constraints e políticas de linha), não apenas no código do aplicativo.

As camadas são separadas por pasta, e a fronteira do domínio é aplicada por lint — não por combinado:

```
src/dominio/          regras do negócio, puras. Só importa caminhos relativos
src/dados/            base local (Dexie), repositório e as operações que a tela chama
src/sincronizacao/    fila de operações e envio
src/interface/        as telas
src/plataforma/       service worker, carimbo de versão e pedido de persistência
```

## Stack

| Camada | Escolha |
|---|---|
| Interface | React + Vite + TypeScript, como SPA estática |
| Base local | Dexie (IndexedDB) |
| Nuvem | Supabase — Postgres, autenticação e Row Level Security |
| Runtime e pacotes | Bun — e `bun test` para os testes de unidade, com `fake-indexeddb` como dublê da base local (prova a lógica de `src/dados`, não o WebKit) |
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

Não é preciso configurar nada além disso **hoje**: a sincronização com o Supabase ainda não está ligada, e até lá o app não toca a rede. Quando estiver, será um `.env.local` na raiz com `VITE_SUPABASE_URL` e a chave `anon` em `VITE_SUPABASE_ANON_KEY`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | Servidor de desenvolvimento |
| `bun run dev:lan` | Idem, com HTTPS e exposto na rede local — para abrir no celular |
| `bun run build` | Build de produção |
| `bun run preview:lan` | Serve o build de produção com HTTPS na rede local |
| `bun run test` | Testes de unidade, com o runner do Bun |
| `bun run check` | Typecheck + lint + testes. É o portão de qualquer mudança |
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

## Licença

[MIT](LICENSE) — use, modifique e redistribua à vontade, mantendo o aviso de copyright.

O sistema foi construído para uma revendedora específica, mas o problema é comum a qualquer pessoa que venda fiado e anote em caderno. Se servir para a sua, fique à vontade.

## Privacidade

Este repositório contém **apenas código**. Nenhum dado de cliente, nenhum arquivo de configuração com credenciais e nenhuma captura de tela com nomes, telefones ou valores reais entra aqui — a base guarda informação financeira de dezenas de pessoas que não consentiram com publicação nenhuma.
