import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Configuração do spike E-00.
 *
 * `SPIKE_LAN=1` liga HTTPS auto-assinado e expõe o servidor na rede local, que é
 * o que permite abrir o spike no iPhone. Service worker e instalação na tela de
 * início exigem contexto seguro, e `localhost` só é exceção no próprio aparelho —
 * pela rede, sem HTTPS, metade das verificações de E-00 não roda.
 */
export default defineConfig(() => ({
  /**
   * Carimbo do build, exibido na tela do spike.
   *
   * Existe porque em 2026-09-05 gastamos uma rodada inteira de teste no iPhone
   * sem perceber que o aparelho ainda rodava o build anterior — o service worker
   * não havia trocado. Sem um carimbo visível, "testei e deu X" é uma afirmação
   * sobre uma versão desconhecida.
   */
  define: {
    __BUILD_ID__: JSON.stringify(
      new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    ),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Necessário para verificar instalação e modo standalone em desenvolvimento,
      // sem precisar de build a cada rodada do spike.
      devOptions: { enabled: true, type: 'module' },
      manifest: {
        name: 'Spike E-00 — Controle de Fiado',
        short_name: 'Spike E-00',
        description: 'Spike de viabilidade. Não é o aplicativo.',
        lang: 'pt-BR',
        theme_color: '#0f172a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
    ...(process.env.SPIKE_LAN ? [basicSsl()] : []),
  ],
  server: { host: true, port: 5173 },
}))
