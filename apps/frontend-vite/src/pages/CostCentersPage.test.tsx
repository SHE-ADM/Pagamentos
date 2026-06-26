import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CostCenter } from '@sheild/shared';

vi.mock('../services/costCenters', () => ({
  listCostCentersPage: vi.fn(),
  createCostCenter: vi.fn(),
  updateCostCenter: vi.fn(),
}));

import CostCentersPage from './CostCentersPage';
import { listCostCentersPage } from '../services/costCenters';

const sample: CostCenter = {
  cost_center_id: 5,
  cost_center_code: 'TI',
  cost_center_description: 'Tecnologia da Informação',
};

const listMock = vi.mocked(listCostCentersPage);

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
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
});
