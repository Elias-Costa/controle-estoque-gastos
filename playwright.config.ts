import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

/**
 * A prova de offline em navegador real (E-08, D-033, D-043): `bun run test:navegador`.
 *
 * Dirige o **build de laboratório** (`dist-laboratorio/`, `bun run build:laboratorio`) servido
 * pelo `vite preview` na 4174 — nunca o servidor de dev, cujo service worker quase não faz cache
 * e produz falha falsa de EL-06 (`docs/fatos-verificados.md`). O build de laboratório é o de
 * produção mais `window.laboratorio`, a mão do teste no app enquanto não há tela (E-09) nem
 * login (E-13).
 *
 * Só Chromium: é a coluna "desktop" de D-036. O WebKit de desktop não é o Safari do iOS e não
 * entra para não ser reportado como tal (AGENTS.md §3). O Android próprio é roteiro à mão
 * (`testes/navegador/LEIA-ME.md`); o iPhone dela, o lote de E-15.
 *
 * Os specs terminam em `.navegador.ts` porque o `bun test` também recolhe `*.spec.*` e `*.test.*`
 * e tentaria executá-los no runtime do Bun. Um worker só e nada em paralelo: os quatro testes
 * compartilham a nuvem real e o usuário de teste, e cada um deixa linhas lá (D-042).
 *
 * As credenciais (`SUPABASE_TESTE_EMAIL`/`SUPABASE_TESTE_SENHA`) vêm de `.env.local`, carregado
 * aqui pelo Node — o `bunx playwright` roda em Node, e o `bun test` não é quem está por cima.
 * Sem elas a suíte pula e diz por quê (`testes/navegador/apoio.ts`); nunca "passa".
 */

if (existsSync('.env.local')) process.loadEnvFile('.env.local')

/** A porta do build de laboratório. Não é a 4173 do `preview` de produção, de propósito. */
export const PORTA_DO_LABORATORIO = 4174

export default defineConfig({
  testDir: 'testes/navegador',
  testMatch: /.*\.navegador\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Cada teste fala com a nuvem real várias vezes (150–300 ms por ida, docs/fatos-verificados.md).
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${PORTA_DO_LABORATORIO}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run preview:laboratorio',
    url: `http://localhost:${PORTA_DO_LABORATORIO}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
