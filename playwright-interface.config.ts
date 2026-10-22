import { defineConfig } from '@playwright/test'

/** Provas visuais e de interação contra o build sem nuvem, com dados fictícios isolados. */
export default defineConfig({
  testDir: 'testes/interface',
  testMatch: /.*\.navegador\.ts$/,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/interface',
  use: { baseURL: 'http://localhost:4176', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'bun run preview:local --port 4176',
    url: 'http://localhost:4176',
    reuseExistingServer: false,
  },
})
