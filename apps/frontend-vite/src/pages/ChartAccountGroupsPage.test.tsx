import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChartAccountGroup } from '@sheild/shared';

vi.mock('../services/chartAccountGroups', () => ({
  listChartAccountGroupsPage: vi.fn(),
  createChartAccountGroup: vi.fn(),
  updateChartAccountGroup: vi.fn(),
}));

import ChartAccountGroupsPage from './ChartAccountGroupsPage';
import { listChartAccountGroupsPage } from '../services/chartAccountGroups';

const sample: ChartAccountGroup = {
  chart_account_group_id: 1,
  group_code: '1',
  group_description: 'Ativo',
  group_type: 'A',
};

beforeEach(() => {
  vi.mocked(listChartAccountGroupsPage).mockReset();
  vi.mocked(listChartAccountGroupsPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('ChartAccountGroupsPage', () => {
  it('lista os grupos carregados', async () => {
    render(<ChartAccountGroupsPage />);
    expect(await screen.findByText('Ativo')).toBeInTheDocument();
  });

  it('abre o modal ao clicar em "Novo grupo"', async () => {
    render(<ChartAccountGroupsPage />);
    await screen.findByText('Ativo');
    await userEvent.click(screen.getByRole('button', { name: /novo grupo/i }));
    expect(await screen.findByRole('button', { name: 'Cadastrar', hidden: true })).toBeInTheDocument();
  });
});
