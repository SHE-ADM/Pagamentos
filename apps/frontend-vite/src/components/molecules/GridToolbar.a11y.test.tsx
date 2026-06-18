import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
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

describe('GridToolbar — acessibilidade (WCAG AA)', () => {
  it('não tem violações sem seleção', async () => {
    const { container } = render(<GridToolbar {...baseProps} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('não tem violações com a barra de seleção ativa', async () => {
    const { container } = render(
      <GridToolbar {...baseProps} selectedCount={2} onExportSelected={vi.fn()} onClearSelection={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
