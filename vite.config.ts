import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Configuração de build do aplicativo.
 *
 * `LAN=1` liga HTTPS auto-assinado e expõe o servidor na rede local, que é o que
 * permite abrir o app no iPhone. Service worker, câmera e instalação na tela de início
 * exigem contexto seguro, e `localhost` só é exceção no próprio aparelho — pela rede,
 * sem HTTPS, nenhum teste em dispositivo real roda.
 */
export default defineConfig(() => ({
  /**
   * Carimbo do build, exibido discretamente na tela (RF-23, D-032).
   *
   * Existe porque em 2026-09-05 gastamos uma rodada inteira de teste no iPhone sem
   * perceber que o aparelho ainda rodava o build anterior. Sem um carimbo visível,
   * "testei e deu X" é uma afirmação sobre uma versão desconhecida.
   */
  define: {
    __BUILD_ID__: JSON.stringify(
      new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    ),
  },
  plugins: [
    react(),
    VitePWA({
      /**
       * `prompt`, e não `autoUpdate`, por decisão explícita — D-032.
       *
       * `autoUpdate` gera um `sw.js` com `skipWaiting()` e `clientsClaim()`: a versão
       * nova assume o controle por cima da sessão viva. Com `prompt`, o build de
       * 2026-09-05 não tem `clientsClaim()` e o `skipWaiting()` que resta só roda se um
       * cliente postar `{ type: 'SKIP_WAITING' }` — coisa que nada neste projeto faz.
       * A versão nova fica em espera e assume na abertura seguinte, que é o que D-032
       * escolheu. Conferido no artefato; ver `src/plataforma/atualizacao.ts`.
       *
       * Não usamos o aviso do `virtual:pwa-register`: D-032 recusou perguntar a ela.
       * O que pede a checagem na abertura é `src/plataforma/atualizacao.ts`.
       */
      registerType: 'prompt',
      /**
       * Service worker também em desenvolvimento, para conferir registro e modo
       * standalone sem build a cada rodada. **Não serve para teste offline:** E-00
       * mediu 2 entradas / 0,12 KiB de precache em `dev` contra 6 / 497,87 KiB no
       * build. Modo avião contra o servidor de desenvolvimento produz falha falsa de
       * EL-06 — o teste offline exige `build` + `preview:lan`.
       */
      devOptions: { enabled: true, type: 'module' },
      manifest: {
        // Provisório. O nome sob o ícone é vocabulário dela (RI-07) e o definitivo,
        // com ícone e splash, é escopo de E-13 — é pergunta para a usuária.
        name: 'Controle de Fiado',
        short_name: 'Fiado',
        description: 'Fichas, fiado e recebimentos.',
        lang: 'pt-BR',
        theme_color: '#0f172a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
    ...(process.env.LAN ? [basicSsl()] : []),
  ],
  server: { host: true, port: 5173 },
}))
