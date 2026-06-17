import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CheckToggle from './CheckToggle';

describe('CheckToggle', () => {
  it('reflete o estado marcado e o aria-label', () => {
    render(<CheckToggle checked onToggle={vi.fn()} ariaLabel="Tem NF" />);
    const box = screen.getByRole('checkbox', { name: 'Tem NF' });
    expect(box).toBeChecked();
  });

  it('chama onToggle com o valor invertido ao clicar', async () => {
    const onToggle = vi.fn();
    render(<CheckToggle checked={false} onToggle={onToggle} ariaLabel="Tem Boleto" />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tem Boleto' }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('interrompe a propagação do clique (não dispara o onRowClick do grid)', () => {
    render(<CheckToggle checked={false} onToggle={vi.fn()} ariaLabel="Tem NF" />);
    const box = screen.getByRole('checkbox', { name: 'Tem NF' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const stop = vi.spyOn(event, 'stopPropagation');
    box.dispatchEvent(event);
    expect(stop).toHaveBeenCalled();
  });

  it('não aciona onToggle quando desabilitado', async () => {
    const onToggle = vi.fn();
    render(<CheckToggle checked={false} onToggle={onToggle} ariaLabel="Tem NF" disabled />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tem NF' }));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
