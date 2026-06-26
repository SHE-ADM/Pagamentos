import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  vi.mocked(listBanksPage).mockReset();
  vi.mocked(listBanksPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('BanksPage', () => {
  it('lista os bancos carregados', async () => {
    render(<BanksPage />);
    expect(await screen.findByText('Banco do Brasil')).toBeInTheDocument();
  });

  it('abre o modal ao clicar em "Novo banco"', async () => {
    render(<BanksPage />);
    await screen.findByText('Banco do Brasil');
    await userEvent.click(screen.getByRole('button', { name: /novo banco/i }));
    expect(await screen.findByRole('button', { name: 'Cadastrar', hidden: true })).toBeInTheDocument();
  });
});
