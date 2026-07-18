import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../services/lookups', () => ({
  listPlanoDescriptions: vi.fn().mockResolvedValue([]),
}));

import { listPlanoDescriptions } from '../../services/lookups';
import ChartAccountSelect from './ChartAccountSelect';

// 1º select da cascata INVERTIDA: o plano de contas é escolhido pela DESCRIÇÃO (o value é
// a própria descrição, não um id). O centro (CostCenterSelect) resolve o chart_account_id.
describe('ChartAccountSelect (plano de contas por descrição)', () => {
  it('renderiza o rótulo', () => {
    render(<ChartAccountSelect label="Plano de contas" value={null} onChange={vi.fn()} />);
    expect(screen.getByText('Plano de contas')).toBeInTheDocument();
  });

  it('exibe a descrição já selecionada (modo edição)', () => {
    render(<ChartAccountSelect label="Plano de contas" value="Serviços Gerais" onChange={vi.fn()} />);
    expect(screen.getByText('Serviços Gerais')).toBeInTheDocument();
  });

  it('é controlado: reflete a mudança do value após montado (não some)', () => {
    const { rerender } = render(<ChartAccountSelect label="Plano de contas" value={null} onChange={vi.fn()} />);
    rerender(<ChartAccountSelect label="Plano de contas" value="Frete sobre vendas" onChange={vi.fn()} />);
    expect(screen.getByText('Frete sobre vendas')).toBeInTheDocument();
  });

  it('mostra erro claro quando o lookup falha (API indisponível), não "nenhum encontrado"', async () => {
    vi.mocked(listPlanoDescriptions).mockRejectedValueOnce(new Error('network'));
    render(<ChartAccountSelect label="Plano de contas" value={null} onChange={vi.fn()} />);
    expect(await screen.findByText(/API de dados indisponível/i)).toBeInTheDocument();
  });
});
