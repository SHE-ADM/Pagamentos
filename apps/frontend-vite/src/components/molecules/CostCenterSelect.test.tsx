import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../services/lookups', () => ({
  listCostCenters: vi.fn().mockResolvedValue([]),
  listChartAccounts: vi.fn(),
}));

import CostCenterSelect from './CostCenterSelect';

describe('CostCenterSelect', () => {
  it('renderiza o rótulo', () => {
    render(<CostCenterSelect label="Centro de custo" value={null} onChange={vi.fn()} />);
    expect(screen.getByText('Centro de custo')).toBeInTheDocument();
  });

  it('exibe o item já selecionado (modo edição)', () => {
    render(<CostCenterSelect label="Centro de custo" value={1} defaultLabel="ADM — Administrativo" onChange={vi.fn()} />);
    expect(screen.getByText('ADM — Administrativo')).toBeInTheDocument();
  });
});
