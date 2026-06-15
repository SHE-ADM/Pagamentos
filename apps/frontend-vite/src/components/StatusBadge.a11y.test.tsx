import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../tests/axe';
import StatusBadge from './StatusBadge';

describe('StatusBadge — acessibilidade (WCAG AA)', () => {
  it.each(['pendente', 'pago', 'vencido', 'erro_api', 'boleto', 'email_body', null])(
    'valor %s não tem violações',
    async (value) => {
      const { container } = render(<StatusBadge value={value} />);
      expect(await axe(container)).toHaveNoViolations();
    },
  );
});
