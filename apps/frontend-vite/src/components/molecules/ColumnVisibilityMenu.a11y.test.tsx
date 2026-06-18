import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '../../../tests/axe';
import ColumnVisibilityMenu, { type ColumnMenuItem } from './ColumnVisibilityMenu';

const ITEMS: ColumnMenuItem[] = [
  { id: 'a', label: 'Alpha', visible: true, canHide: true, pin: false },
  { id: 'b', label: 'Beta', visible: false, canHide: true, pin: 'left' },
];

describe('ColumnVisibilityMenu — acessibilidade (WCAG AA)', () => {
  it('não tem violações com o popover aberto', async () => {
    const { container } = render(
      <ColumnVisibilityMenu items={ITEMS} onToggleVisible={vi.fn()} onSetPin={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Colunas/ }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
