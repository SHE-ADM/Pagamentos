import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy /api → backend Flask local (server/app.py). Evita CORS no dev.
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
