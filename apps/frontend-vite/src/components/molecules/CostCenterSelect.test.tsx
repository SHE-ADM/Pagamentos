import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../services/lookups', () => ({
  listCentersForPlano: vi.fn().mockResolvedValue([]),
}));

import { listCentersForPlano } from '../../services/lookups';
import CostCenterSelect from './CostCenterSelect';

// 2º select da cascata INVERTIDA: dado o PLANO (descrição), lista os centros que o compõem.
// O value é o chart_account_id resolvido; o onChange devolve (chartAccountId, costCenterId).
describe('CostCenterSelect (centro por plano)', () => {
  it('renderiza o rótulo', () => {
    render(<CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={null} onChange={vi.fn()} />);
    expect(screen.getByText('Centro de custo')).toBeInTheDocument();
  });

  it('exibe o item já selecionado (modo edição)', () => {
    render(
      <CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={10} defaultLabel="Logística" onChange={vi.fn()} />,
    );
    expect(screen.getByText('Logística')).toBeInTheDocument();
  });

  it('fica desabilitado quando não há plano de contas (cascata)', () => {
    render(<CostCenterSelect label="Centro de custo" planoDescription={null} value={null} onChange={vi.fn()} />);
    // Sem plano: orienta o usuário e não expõe o input interativo (react-select remove o
    // role combobox quando isDisabled).
    expect(screen.getByText('Selecione um plano de contas primeiro')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('habilita quando há um plano de contas selecionado', () => {
    render(<CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={null} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeEnabled();
  });

  it('é controlado: reflete a mudança do value após montado (não some)', () => {
    const { rerender } = render(
      <CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={null} onChange={vi.fn()} />,
    );
    rerender(
      <CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={9} defaultLabel="Logística" onChange={vi.fn()} />,
    );
    expect(screen.getByText('Logística')).toBeInTheDocument();
  });

  it('mostra erro claro quando o lookup falha (API indisponível), não "nenhum encontrado"', async () => {
    vi.mocked(listCentersForPlano).mockRejectedValueOnce(new Error('network'));
    render(<CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={null} onChange={vi.fn()} />);
    // defaultOptions dispara o load no mount → falha → mensagem clara abaixo do select.
    expect(await screen.findByText(/API de dados indisponível/i)).toBeInTheDocument();
  });
});
