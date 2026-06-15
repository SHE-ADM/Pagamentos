import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import InlineMessage from './InlineMessage';

describe('InlineMessage — acessibilidade (WCAG AA)', () => {
  it.each(['error', 'success'] as const)('variante %s não tem violações', async (type) => {
    const { container } = render(<InlineMessage type={type}>Mensagem inline</InlineMessage>);
    expect(await axe(container)).toHaveNoViolations();
  });
});
