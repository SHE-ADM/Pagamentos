import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Testes da API rodam em ambiente Node (route handlers usam Web Request/Response
// e o globalThis.fetch do Node). Testes co-locados em lib/ e nas rotas (app/).
// O alias `@` espelha o tsconfig (`@/*` -> ./*) para resolver os imports das rotas.
const appRoot = fileURLToPath(new URL('.', import.meta.url)).replace(/[/\\]$/, '');

export default defineConfig({
  resolve: {
    alias: {
      '@': appRoot,
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
  },
});
