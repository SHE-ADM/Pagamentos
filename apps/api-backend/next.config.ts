import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { NextConfig } from 'next';

// Raiz do monorepo (dois níveis acima de apps/api-backend). Informar a raiz ao
// Turbopack evita o aviso de "múltiplos lockfiles" — o lockfile único vive na
// raiz do workspace.
const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const nextConfig: NextConfig = {
  turbopack: {
    root: monorepoRoot,
  },
  // Compila o código-fonte TS do pacote de workspace @sheild/shared
  // (schemas Zod consumidos pelos route handlers).
  transpilePackages: ['@sheild/shared'],
};

export default nextConfig;
