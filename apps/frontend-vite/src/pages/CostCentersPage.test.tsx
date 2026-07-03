import { describe, it, expect, vi, beforeEach } from 'vitest';

// useAuth (gate isAdminGroup do hard delete) — mock: sem grupo Administrador nestes testes.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, session: null, loading: false, isAdmin: false, groupId: 0, isAdminGroup: false, signOut: vi.fn() }),
}));
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CostCenter, ChartAccount } from '@sheild/shared';

vi.mock('../services/costCenters', () => ({
  listCostCentersPage: vi.fn(),
  createCostCenter: vi.fn(),
  updateCostCenter: vi.fn(),
  deleteCostCenter: vi.fn(),
}));

vi.mock('../services/chartAccounts', () => ({
  listChartAccountsByCostCenter: vi.fn(),
}));

import CostCentersPage from './CostCentersPage';
import { listCostCentersPage } from '../services/costCenters';
import { listChartAccountsByCostCenter } from '../services/chartAccounts';

const sample: CostCenter = {
  cost_center_id: 5,
  cost_center_code: 'TI',
  cost_center_description: 'Tecnologia da Informação',
};

const chartAccount: ChartAccount = {
  chart_account_id: 12,
  account_code: '3.1.01',
  account_description: 'Serviços de TI',
  cost_center_id: 5,
  chart_account_group_id: 2,
  chart_account_subgroup_id: 4,
  account_level: 3,
  is_postable: true,
  group: { group_code: 'G2', group_description: 'Despesas' },
  subgroup: { subgroup_code: 'S4', subgroup_description: 'Operacionais' },
};

const listMock = vi.mocked(listCostCentersPage);
const detailMock = vi.mocked(listChartAccountsByCostCenter);

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
  detailMock.mockReset();
  detailMock.mockResolvedValue({ data: [chartAccount], total: 1, page: 1, limit: 20 });
});

describe('CostCentersPage', () => {
  it('lista os centros de custo carregados', async () => {
    render(<CostCentersPage />);
    expect(await screen.findByText('Tecnologia da Informação')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalled();
  });

  it('abre o modal ao clicar em "Novo centro de custo"', async () => {
    render(<CostCentersPage />);
    await screen.findByText('Tecnologia da Informação');
    await userEvent.click(screen.getByRole('button', { name: /novo centro de custo/i }));
    // jsdom não implementa <dialog>.showModal — o conteúdo fica hidden na a11y tree.
    expect(await screen.findByRole('button', { name: 'Cadastrar', hidden: true })).toBeInTheDocument();
  });

  it('mostra a instrução do grid complementar antes de selecionar um centro', async () => {
    render(<CostCentersPage />);
    await screen.findByText('Tecnologia da Informação');
    expect(screen.getByText(/selecione um centro de custo para ver o plano de contas/i)).toBeInTheDocument();
    expect(detailMock).not.toHaveBeenCalled();
  });

  it('carrega o plano de contas ao clicar num centro de custo', async () => {
    render(<CostCentersPage />);
    await userEvent.click(await screen.findByText('Tecnologia da Informação'));
    expect(await screen.findByText('Serviços de TI')).toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledWith(5, expect.objectContaining({ page: 1, limit: 20 }));
  });
});
