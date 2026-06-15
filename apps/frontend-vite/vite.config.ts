import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

// Proxy /api → backend Flask local (server/app.py). Evita CORS no dev.
// A leitura de e-mails (POST /api/emails/read) é servida diretamente pelo
// Flask. A Next API (apps/api-backend, porta 3000) é camada de CRUD/dados
// independente e não intercepta este caminho.
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
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
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          supabase: ['@supabase/supabase-js'],
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
