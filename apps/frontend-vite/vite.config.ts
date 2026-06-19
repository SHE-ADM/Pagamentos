import { defineConfig } from 'vitest/config';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';

// Proxy /api → backend Flask local (server/app.py). Evita CORS no dev.
// A leitura de e-mails (POST /api/emails/read) é servida diretamente pelo
// Flask. A Next API (apps/api-backend, porta 3000) é camada de CRUD/dados
// independente e não intercepta este caminho.
export default defineConfig({
  plugins: [
    react(),
    // React Compiler (transform de build) — memoiza componentes/hooks automaticamente.
    // No @vitejs/plugin-react v6 (oxc/Rolldown) o compiler entra via @rolldown/plugin-babel
    // + reactCompilerPreset (não pelo antigo `babel` option). target React 19 (runtime
    // embutido em react/compiler-runtime); faz "bail out" seguro em código incompatível
    // (ex.: @tanstack/react-table no DataGrid).
    babel({ presets: [reactCompilerPreset()] }),
  ],
  resolve: {
    // Resolução nativa dos paths do tsconfig (Vite 8) — substitui o plugin
    // `vite-tsconfig-paths`, que ficou redundante (o Vite 8 resolve `paths`
    // nativamente) e pesava no build (alerta PLUGIN_TIMINGS do Rolldown).
    tsconfigPaths: true,
    // Defensivo: garante uma ÚNICA cópia do React no bundle/teste. Hoje o monorepo
    // está unificado em react@19.2.7 (confirmado por `npm ls react` — tudo `deduped`),
    // então o dedupe não corrige divergência ativa; fica como rede de segurança contra
    // um futuro transitivo react@18 puxado por dependência vizinha (@dnd-kit etc.).
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Vendors estáveis em chunks próprios — melhora cache e download paralelo.
        // O código das rotas é dividido via React.lazy (ver App.tsx).
        // Vite 8 (Rolldown) só aceita `manualChunks` como função — o regex casa os
        // pacotes exatos por segmento de `node_modules` (não pega react-hook-form,
        // lucide-react nem @tanstack/react-table).
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|@remix-run[\\/]router|scheduler)[\\/]/.test(id)) {
            return 'react-vendor';
          }
          if (id.includes('@supabase')) return 'supabase';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: false,
  },
});
