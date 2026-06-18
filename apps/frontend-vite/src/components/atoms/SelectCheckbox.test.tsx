import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SelectCheckbox from './SelectCheckbox';

describe('SelectCheckbox', () => {
  it('reflete o estado e dispara onToggle ao clicar', async () => {
    const onToggle = vi.fn();
    render(<SelectCheckbox checked={false} onToggle={onToggle} ariaLabel="Selecionar linha" />);
    const box = screen.getByRole('checkbox', { name: 'Selecionar linha' });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('aplica o estado indeterminate (propriedade do DOM)', () => {
    render(<SelectCheckbox checked={false} indeterminate onToggle={vi.fn()} ariaLabel="Selecionar todas" />);
    const box = screen.getByRole('checkbox', { name: 'Selecionar todas' });
    expect((box as HTMLInputElement).indeterminate).toBe(true);
  });
});
