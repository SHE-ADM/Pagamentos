import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FinancialAccount } from '@sheild/shared';

vi.mock('../services/financialAccounts', () => ({
  listFinancialAccountsPage: vi.fn(),
  createFinancialAccount: vi.fn(),
  updateFinancialAccount: vi.fn(),
}));
vi.mock('../services/lookups', () => ({
  listBanks: vi.fn().mockResolvedValue([]),
  listStatuses: vi.fn().mockResolvedValue([{ status_id: 1, status_name: 'pendente' }]),
}));

import FinancialAccountsPage from './FinancialAccountsPage';
import { listFinancialAccountsPage } from '../services/financialAccounts';

const sample: FinancialAccount = {
  financial_account_id: 1,
  account_description: 'Caixa',
  bank_id: 0,
  payment_type_id: 8,
  currency_code: 'R$',
  balance_amount: 0,
  status_id: 1,
};

beforeEach(() => {
  vi.mocked(listFinancialAccountsPage).mockReset();
  vi.mocked(listFinancialAccountsPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('FinancialAccountsPage', () => {
  it('lista as contas carregadas', async () => {
    render(<FinancialAccountsPage />);
    expect(await screen.findByText('Caixa')).toBeInTheDocument();
  });

  it('abre o modal ao clicar em "Nova conta"', async () => {
    render(<FinancialAccountsPage />);
    await screen.findByText('Caixa');
    await userEvent.click(screen.getByRole('button', { name: /nova conta/i }));
    expect(await screen.findByRole('button', { name: 'Cadastrar', hidden: true })).toBeInTheDocument();
  });
});
