import { defineConfig } from 'vitest/config';

// Testes do portal rodam em ambiente Node renderizando via react-dom/server
// (renderToStaticMarkup), sem jsdom e sem @testing-library/react.
//
// ⚠️ O MOTIVO MUDOU — não regredir o entendimento. Este comentário dizia que a escolha
// CONTORNAVA um conflito de duas versões do React no monorepo (18 do frontend-vite ×
// 19 dos apps Next). Esse conflito NÃO EXISTE MAIS desde a Fase 2 do upgrade: medido em
// 2026-08-12, há `react@19.2.7` em 23 nós do grafo e UMA só cópia física. Medido também
// que jsdom + Testing Library rodam aqui sem erro nenhum.
//
// A escolha do server rendering permanece por MÉRITO PRÓPRIO, não por bloqueio: a página
// é um placeholder sem hooks e sem interação, então jsdom seria ~16 s de ambiente por
// nada. Quando o portal ganhar componente interativo, migrar é legítimo — e aí é preciso
// DECLARAR `jsdom` e `@testing-library/react` como devDependencies do portal, que hoje só
// resolvem por hoisting da raiz.
//
// `dedupe` fica como defesa em profundidade contra um react transitivo futuro, não como
// contorno de um problema atual. Guarda da versão única: tests/test_react_versao_unica.py.
export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  // Vite 8 (Rolldown/oxc) removeu `jsx` de `esbuild` (ESBuildOptions) e já infere o
  // runtime automático do tsconfig (`jsx: react-jsx`) — não é mais preciso configurar aqui.
  test: {
    environment: 'node',
    globals: true,
    include: ['app/**/*.test.{ts,tsx}'],
  },
});
