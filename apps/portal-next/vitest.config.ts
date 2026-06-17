import { defineConfig } from 'vitest/config';

// Testes do portal rodam em ambiente Node renderizando componentes via
// react-dom/server (renderToStaticMarkup) — não usam jsdom nem
// @testing-library/react, o que CONTORNA o conflito de duas versões do React no
// monorepo (18 hoisted do frontend-vite vs 19 local dos apps Next): server
// rendering de um componente sem hooks não dispara "invalid hook call".
// `dedupe` garante uma única cópia do React (a 19 local do portal).
export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  esbuild: {
    jsx: 'automatic', // injeta react/jsx-runtime (tsconfig usa jsx: react-jsx)
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['app/**/*.test.{ts,tsx}'],
  },
});
