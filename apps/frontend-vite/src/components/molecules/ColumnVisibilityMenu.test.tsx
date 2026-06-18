import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ColumnVisibilityMenu, { type ColumnMenuItem } from './ColumnVisibilityMenu';

const ITEMS: ColumnMenuItem[] = [
  { id: 'a', label: 'Alpha', visible: true, canHide: true, pin: false },
  { id: 'b', label: 'Beta', visible: false, canHide: true, pin: 'left' },
];

describe('ColumnVisibilityMenu', () => {
  it('abre o popover e alterna a visibilidade de uma coluna', async () => {
    const onToggleVisible = vi.fn();
    render(<ColumnVisibilityMenu items={ITEMS} onToggleVisible={onToggleVisible} onSetPin={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /Colunas/ }));
    expect(screen.getByRole('dialog', { name: 'Gerenciar colunas' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Mostrar coluna Alpha' }));
    expect(onToggleVisible).toHaveBeenCalledWith('a', false);
  });

  it('fixa uma coluna à esquerda', async () => {
    const onSetPin = vi.fn();
    render(<ColumnVisibilityMenu items={ITEMS} onToggleVisible={vi.fn()} onSetPin={onSetPin} />);

    await userEvent.click(screen.getByRole('button', { name: /Colunas/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Fixar Alpha à esquerda' }));
    expect(onSetPin).toHaveBeenCalledWith('a', 'left');
  });

  it('exibe a contagem de colunas ocultas no botão', () => {
    render(<ColumnVisibilityMenu items={ITEMS} onToggleVisible={vi.fn()} onSetPin={vi.fn()} />);
    expect(screen.getByText('1 ocultas')).toBeInTheDocument();
  });
});
