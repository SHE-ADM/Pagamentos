import { describe, it, expect } from 'vitest';
import { isChunkLoadError } from './chunkReload';

describe('isChunkLoadError', () => {
  it('reconhece falhas de import dinâmico (variações de navegador)', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /assets/Consulta-abc.js'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    const e = new Error('boom');
    e.name = 'ChunkLoadError';
    expect(isChunkLoadError(e)).toBe(true);
  });

  it('não confunde erros de runtime comuns com erro de chunk', () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isChunkLoadError(new Error('Supabase 401: Unauthorized'))).toBe(false);
    expect(isChunkLoadError('string qualquer')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
