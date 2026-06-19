import { defineConfig, devices } from '@playwright/test';

// Camada de acessibilidade em NAVEGADOR REAL (Chromium) — complementa a suíte
// jsdom (Vitest + jest-axe). Só o axe rodando em render real avalia o que o jsdom
// não consegue: contraste de cor efetivo (1.4.3/1.4.11), ordem de foco e autofill.
//
// Specs em e2e/*.a11y.e2e.ts. Sobe o app via Vite dev (porta 5173) e escaneia cada
// página com @axe-core/playwright nas tags WCAG 2.1 A + AA.
//
// Rodar:  npm run test:e2e            (todas)
//         npm run test:e2e:headed     (com janela)
// As rotas protegidas (/emails, /consulta, /erros) exigem A11Y_TEST_EMAIL e
// A11Y_TEST_PASSWORD (usuário de teste no Supabase) — sem isso, são puladas.
const PORT = 5173;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.a11y.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // 'list' no console + 'html' (não abre sozinho) para o artefato de CI inspecionar violações.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Flags de estabilidade para rodar em ambiente restrito/headless
        // (evita "Page crashed" por sandbox/GPU/shm).
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
