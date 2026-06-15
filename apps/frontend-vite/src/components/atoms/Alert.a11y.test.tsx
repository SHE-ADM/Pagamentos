import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import Alert from './Alert';

describe('Alert — acessibilidade (WCAG AA)', () => {
  it.each(['error', 'success', 'warning', 'info'] as const)(
    'variante %s não tem violações',
    async (variant) => {
      const { container } = render(<Alert variant={variant}>Mensagem de feedback</Alert>);
      expect(await axe(container)).toHaveNoViolations();
    },
  );
});
