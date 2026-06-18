import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GridToolbar from './GridToolbar';
import type { ColumnMenuItem } from './ColumnVisibilityMenu';

const COLUMN_ITEMS: ColumnMenuItem[] = [
  { id: 'a', label: 'Alpha', visible: true, canHide: true, pin: false },
];

const baseProps = {
  columnItems: COLUMN_ITEMS,
  onToggleVisible: vi.fn(),
  onSetPin: vi.fn(),
  onResetLayout: vi.fn(),
  density: 'comfortable' as const,
  onDensityChange: vi.fn(),
};

describe('GridToolbar', () => {
  it('alterna a densidade para compacto', async () => {
    const onDensityChange = vi.fn();
    render(<GridToolbar {...baseProps} onDensityChange={onDensityChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Compacto' }));
    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('restaura o layout', async () => {
    const onResetLayout = vi.fn();
    render(<GridToolbar {...baseProps} onResetLayout={onResetLayout} />);
    await userEvent.click(screen.getByRole('button', { name: /Restaurar/ }));
    expect(onResetLayout).toHaveBeenCalled();
  });

  it('mostra a barra de seleção e exporta as selecionadas', async () => {
    const onExportSelected = vi.fn();
    render(
      <GridToolbar
        {...baseProps}
        selectedCount={3}
        onExportSelected={onExportSelected}
        onClearSelection={vi.fn()}
      />,
    );
    expect(screen.getByText('3 selecionadas')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Exportar selecionadas/ }));
    expect(onExportSelected).toHaveBeenCalled();
  });

  it('esconde a barra de seleção quando nada está selecionado', () => {
    render(<GridToolbar {...baseProps} selectedCount={0} onExportSelected={vi.fn()} />);
    expect(screen.queryByText(/selecionada/)).not.toBeInTheDocument();
  });
});
