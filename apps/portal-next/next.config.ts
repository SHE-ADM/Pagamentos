import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { NextConfig } from 'next';

// Raiz do monorepo (dois níveis acima). Evita o aviso de múltiplos lockfiles
// do Turbopack — o lockfile único vive na raiz do workspace.
const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const nextConfig: NextConfig = {
  turbopack: {
    root: monorepoRoot,
  },
  transpilePackages: ['@sheild/shared'],
};

export default nextConfig;
