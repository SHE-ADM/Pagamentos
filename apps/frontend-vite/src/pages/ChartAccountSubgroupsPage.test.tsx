import { describe, it, expect, vi, beforeEach } from 'vitest';

// useAuth (gate isAdminGroup do hard delete) — mock: sem grupo Administrador nestes testes.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, session: null, loading: false, isAdmin: false, groupId: 0, isAdminGroup: false, signOut: vi.fn() }),
}));
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChartAccountSubgroup } from '@sheild/shared';

vi.mock('../services/chartAccountSubgroups', () => ({
  listChartAccountSubgroupsPage: vi.fn(),
  createChartAccountSubgroup: vi.fn(),
  updateChartAccountSubgroup: vi.fn(),
}));
vi.mock('../services/lookups', () => ({ listChartAccountGroups: vi.fn().mockResolvedValue([]) }));

import ChartAccountSubgroupsPage from './ChartAccountSubgroupsPage';
import { listChartAccountSubgroupsPage } from '../services/chartAccountSubgroups';

const sample: ChartAccountSubgroup = {
  chart_account_subgroup_id: 1,
  chart_account_group_id: 1,
  subgroup_code: '1.1',
  subgroup_description: 'Ativo Circulante',
};

beforeEach(() => {
  vi.mocked(listChartAccountSubgroupsPage).mockReset();
  vi.mocked(listChartAccountSubgroupsPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('ChartAccountSubgroupsPage', () => {
  it('lista os subgrupos carregados', async () => {
    render(<ChartAccountSubgroupsPage />);
    expect(await screen.findByText('Ativo Circulante')).toBeInTheDocument();
  });

  it('abre o modal ao clicar em "Novo subgrupo"', async () => {
    render(<ChartAccountSubgroupsPage />);
    await screen.findByText('Ativo Circulante');
    await userEvent.click(screen.getByRole('button', { name: /novo subgrupo/i }));
    expect(await screen.findByRole('button', { name: 'Cadastrar', hidden: true })).toBeInTheDocument();
  });
});
