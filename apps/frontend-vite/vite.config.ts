import { defineConfig } from 'vitest/config';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tsconfigPaths from 'vite-tsconfig-paths';

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
    tsconfigPaths(),
  ],
  // Força uma ÚNICA cópia do React no bundle/teste: o monorepo ainda tem react@18
  // hoisted na raiz (puxado pelo next dos apps Next), e libs vizinhas (@dnd-kit etc.)
  // dariam dedupe para ele — gerando dois React. `dedupe` resolve tudo para o react 19
  // do frontend-vite. Mesmo padrão já usado em apps/portal-next.
  resolve: {
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
