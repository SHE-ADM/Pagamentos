import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../services/lookups', () => ({
  listCostCenters: vi.fn().mockResolvedValue([]),
  listChartAccounts: vi.fn(),
}));

import { listCostCenters } from '../../services/lookups';
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

  it('é controlado: reflete a mudança do value após montado (não some)', () => {
    // Regressão: antes o select inicializava `selected` uma vez e perdia o valor quando
    // o pai o atualizava (pré-preenchimento/edição). Agora espelha o `value` no render.
    const { rerender } = render(<CostCenterSelect label="Centro de custo" value={null} onChange={vi.fn()} />);
    rerender(<CostCenterSelect label="Centro de custo" value={7} defaultLabel="Logística" onChange={vi.fn()} />);
    expect(screen.getByText('Logística')).toBeInTheDocument();
  });

  it('mostra erro claro quando o lookup falha (API indisponível), não "nenhum encontrado"', async () => {
    vi.mocked(listCostCenters).mockRejectedValueOnce(new Error('network'));
    render(<CostCenterSelect label="Centro de custo" value={null} onChange={vi.fn()} />);
    // defaultOptions dispara o load no mount → falha → mensagem clara abaixo do select.
    expect(await screen.findByText(/API de dados indisponível/i)).toBeInTheDocument();
  });
});
