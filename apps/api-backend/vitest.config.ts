import { defineConfig } from 'vitest/config';

// Testes da API rodam em ambiente Node (route handlers usam Web Request/Response
// e o globalThis.fetch do Node). Testes co-locados em lib/ como *.test.ts.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['lib/**/*.test.ts'],
  },
});
