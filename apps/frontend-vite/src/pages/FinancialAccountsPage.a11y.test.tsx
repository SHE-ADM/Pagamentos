import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../tests/axe';
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
  vi.mocked(listFinancialAccountsPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('FinancialAccountsPage a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<FinancialAccountsPage />);
    await screen.findByText('Caixa');
    expect(await axe(container)).toHaveNoViolations();
  });
});
