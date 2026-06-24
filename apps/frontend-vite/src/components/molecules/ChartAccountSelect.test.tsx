import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../services/lookups', () => ({
  listChartAccounts: vi.fn().mockResolvedValue([]),
  listCostCenters: vi.fn(),
}));

import ChartAccountSelect from './ChartAccountSelect';

describe('ChartAccountSelect', () => {
  it('renderiza o rótulo', () => {
    render(<ChartAccountSelect label="Plano de contas" value={null} costCenterId={1} onChange={vi.fn()} />);
    expect(screen.getByText('Plano de contas')).toBeInTheDocument();
  });

  it('exibe o item já selecionado (modo edição)', () => {
    render(
      <ChartAccountSelect label="Plano de contas" value={5} costCenterId={1} defaultLabel="Clientes" onChange={vi.fn()} />,
    );
    expect(screen.getByText('Clientes')).toBeInTheDocument();
  });

  it('fica desabilitado quando não há centro de custo (cascata)', () => {
    render(<ChartAccountSelect label="Plano de contas" value={null} costCenterId={null} onChange={vi.fn()} />);
    // Sem centro: orienta o usuário e não expõe o input interativo (react-select
    // remove o role combobox quando isDisabled).
    expect(screen.getByText('Selecione um centro de custo primeiro')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('habilita quando há um centro de custo selecionado', () => {
    render(<ChartAccountSelect label="Plano de contas" value={null} costCenterId={1} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeEnabled();
  });
});
