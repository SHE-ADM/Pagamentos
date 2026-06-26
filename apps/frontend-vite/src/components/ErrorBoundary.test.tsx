import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Controla a detecção/recarga de chunk (evita chamar location.reload no jsdom).
vi.mock('../lib/chunkReload', () => ({
  isChunkLoadError: vi.fn(),
  reloadOnceForChunk: vi.fn(() => true),
}));

import ErrorBoundary from './ErrorBoundary';
import { isChunkLoadError, reloadOnceForChunk } from '../lib/chunkReload';

function Bomb({ message }: { message: string }): never {
  throw new Error(message);
}

let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.mocked(isChunkLoadError).mockReset();
  vi.mocked(reloadOnceForChunk).mockReset().mockReturnValue(true);
  // React loga o erro capturado — silencia para não poluir a saída do teste.
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => consoleSpy.mockRestore());

describe('ErrorBoundary', () => {
  it('renderiza os filhos quando não há erro', () => {
    render(
      <ErrorBoundary>
        <p>conteúdo ok</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('conteúdo ok')).toBeInTheDocument();
  });

  it('erro de runtime → mostra fallback com botão Recarregar (não recarrega)', () => {
    vi.mocked(isChunkLoadError).mockReturnValue(false);
    render(
      <ErrorBoundary>
        <Bomb message="undefined is not a function" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/algo deu errado/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeInTheDocument();
    expect(reloadOnceForChunk).not.toHaveBeenCalled();
  });

  it('erro de chunk → tenta recarregar e exibe "Atualizando…"', () => {
    vi.mocked(isChunkLoadError).mockReturnValue(true);
    render(
      <ErrorBoundary>
        <Bomb message="Failed to fetch dynamically imported module" />
      </ErrorBoundary>,
    );
    expect(reloadOnceForChunk).toHaveBeenCalled();
    expect(screen.getByText(/atualizando/i)).toBeInTheDocument();
  });
});
