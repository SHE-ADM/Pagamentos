import { describe, it, expect, vi, beforeEach } from 'vitest';

// useAuth (gate isAdminGroup do hard delete) — mock: sem grupo Administrador nestes testes.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, session: null, loading: false, isAdmin: false, groupId: 0, isAdminGroup: false, signOut: vi.fn() }),
}));
import { render, screen } from '@testing-library/react';
import { axe } from '../../tests/axe';
import type { Bank } from '@sheild/shared';

vi.mock('../services/banks', () => ({
  listBanksPage: vi.fn(),
  createBank: vi.fn(),
  updateBank: vi.fn(),
}));

import BanksPage from './BanksPage';
import { listBanksPage } from '../services/banks';

const sample: Bank = { bank_id: 1, bank_code: '001', bank_name: 'Banco do Brasil' };

beforeEach(() => {
  vi.mocked(listBanksPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('BanksPage a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<BanksPage />);
    await screen.findByText('Banco do Brasil');
    expect(await axe(container)).toHaveNoViolations();
  });
});
