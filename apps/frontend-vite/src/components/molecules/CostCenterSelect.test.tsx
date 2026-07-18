import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/lookups', () => ({
  listCentersForPlano: vi.fn().mockResolvedValue([]),
}));

import { listCentersForPlano } from '../../services/lookups';
import CostCenterSelect from './CostCenterSelect';

const center = (chart_account_id: number, cost_center_id: number, cost_center_description: string) => ({
  chart_account_id,
  account_code: `${chart_account_id}.0`,
  cost_center_id,
  cost_center_description,
});

// Aguarda o effect de auto-seleção assentar (a busca + o encadeamento de promessas).
const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  vi.mocked(listCentersForPlano).mockReset().mockResolvedValue([]);
});

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
    vi.mocked(listCentersForPlano).mockRejectedValue(new Error('network'));
    render(<CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={null} onChange={vi.fn()} />);
    // defaultOptions dispara o load no mount → falha → mensagem clara abaixo do select.
    expect(await screen.findByText(/API de dados indisponível/i)).toBeInTheDocument();
  });

  // ── Auto-seleção quando o plano tem UM único centro ──────────────────────────
  it('auto-seleciona o centro quando o plano tem UM único centro (value null)', async () => {
    vi.mocked(listCentersForPlano).mockResolvedValue([center(42, 7, 'Logística')]);
    const onChange = vi.fn();
    render(<CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={null} onChange={onChange} />);
    // Devolve o chart_account_id resolvido + o cost_center_id, juntos.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(42, 7));
  });

  it('NÃO auto-seleciona quando o plano tem mais de um centro', async () => {
    vi.mocked(listCentersForPlano).mockResolvedValue([center(42, 7, 'Logística'), center(43, 8, 'Compras')]);
    const onChange = vi.fn();
    render(<CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={null} onChange={onChange} />);
    await waitFor(() => expect(listCentersForPlano).toHaveBeenCalled());
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('NÃO auto-seleciona quando já há um centro selecionado (value != null)', async () => {
    vi.mocked(listCentersForPlano).mockResolvedValue([center(42, 7, 'Logística')]);
    const onChange = vi.fn();
    render(
      <CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={99} defaultLabel="Já escolhido" onChange={onChange} />,
    );
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('NÃO re-busca ao re-renderizar com nova identidade de onChange (mesmo plano, sem seleção)', async () => {
    // Robustez: sem a guarda lastAutoPlanoRef, o churn de identidade de onChange (com value
    // ainda null) re-incrementaria o request-id e poderia invalidar/re-disparar a busca.
    vi.mocked(listCentersForPlano).mockResolvedValue([center(42, 7, 'Logística')]);
    const { rerender } = render(
      <CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={null} onChange={vi.fn()} />,
    );
    await waitFor(() => expect(vi.mocked(listCentersForPlano).mock.calls.length).toBeGreaterThan(0));
    await flush();
    const before = vi.mocked(listCentersForPlano).mock.calls.length;

    // Novo onChange (identidade diferente), MESMO plano, value ainda null.
    rerender(
      <CostCenterSelect label="Centro de custo" planoDescription="Serviços Gerais" value={null} onChange={vi.fn()} />,
    );
    await flush();
    expect(vi.mocked(listCentersForPlano).mock.calls).toHaveLength(before); // não re-buscou
  });
});
