import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '../../../tests/axe';
import StatusSelectCell, { type StatusOption } from './StatusSelectCell';

const OPTIONS: StatusOption[] = [
  { value: 'pendente', label: 'Pendente' },
  { value: 'pago', label: 'Pago' },
  { value: 'vencido', label: 'Vencido' },
];

describe('StatusSelectCell — acessibilidade (WCAG AA)', () => {
  it('modo de visualização (botão) não tem violações', async () => {
    const { container } = render(
      <StatusSelectCell rowId={1} value="pendente" options={OPTIONS} onSave={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('modo de edição (select) não tem violações', async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(
      <StatusSelectCell rowId={1} value="pendente" options={OPTIONS} onSave={vi.fn()} />,
    );
    await user.click(getByRole('button'));
    expect(await axe(container)).toHaveNoViolations();
  });
});
