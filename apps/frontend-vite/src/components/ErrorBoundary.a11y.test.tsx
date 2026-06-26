import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../tests/axe';

vi.mock('../lib/chunkReload', () => ({
  isChunkLoadError: vi.fn(() => false),
  reloadOnceForChunk: vi.fn(() => true),
}));

import ErrorBoundary from './ErrorBoundary';

function Bomb(): never {
  throw new Error('erro de runtime');
}

let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => consoleSpy.mockRestore());

describe('ErrorBoundary a11y', () => {
  it('fallback de erro não tem violações de acessibilidade', async () => {
    const { container } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    await screen.findByRole('button', { name: 'Recarregar' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
