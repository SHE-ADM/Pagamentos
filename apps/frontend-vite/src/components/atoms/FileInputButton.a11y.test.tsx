import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import FileInputButton from './FileInputButton';

describe('FileInputButton — acessibilidade (WCAG AA)', () => {
  it('não tem violações', async () => {
    const { container } = render(<FileInputButton accept="application/pdf" onFiles={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('desabilitado não tem violações', async () => {
    const { container } = render(<FileInputButton accept="application/pdf" onFiles={vi.fn()} disabled />);
    expect(await axe(container)).toHaveNoViolations();
  });

  // O input fica `sr-only` (não `hidden`/`display:none`), então continua focável e na
  // árvore de acessibilidade — é o que dá teclado e leitor de tela de graça.
  it('o input file segue acessível ao leitor de tela (sr-only, não hidden)', () => {
    const { container } = render(<FileInputButton accept="application/pdf" onFiles={vi.fn()} />);
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input).not.toHaveAttribute('hidden');
    expect(input?.className).toContain('sr-only');
  });
});
