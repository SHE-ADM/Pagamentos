import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mocka os serviços de dados e o reader — o teste cobre o layout/interação, não a rede.
const getEmailControl = vi.fn();
const getEmailStats = vi.fn();
const getAccountsByMessageId = vi.fn();
const getInvoiceNumbersByMessageIds = vi.fn();

vi.mock('../services/supabase', () => ({
  getEmailControl: (...a: unknown[]) => getEmailControl(...a),
  getEmailStats: (...a: unknown[]) => getEmailStats(...a),
  getAccountsByMessageId: (...a: unknown[]) => getAccountsByMessageId(...a),
  getInvoiceNumbersByMessageIds: (...a: unknown[]) => getInvoiceNumbersByMessageIds(...a),
}));
vi.mock('../services/emailReader', () => ({ triggerEmailRead: vi.fn() }));
vi.mock('../hooks/useIdleLogout', () => ({ suspendIdleLogout: vi.fn(), resumeIdleLogout: vi.fn() }));

import Emails from './Emails';

describe('Emails', () => {
  beforeEach(() => {
    getEmailControl.mockResolvedValue([]);
    getEmailStats.mockResolvedValue({});
    getAccountsByMessageId.mockResolvedValue([]);
    getInvoiceNumbersByMessageIds.mockResolvedValue({});
  });

  it('o ícone de limpar aparece com texto e zera a busca', async () => {
    const user = userEvent.setup();
    render(<Emails />);
    await waitFor(() => expect(getEmailControl).toHaveBeenCalled());

    const search = screen.getByPlaceholderText('Remetente, assunto ou Nº doc…');
    // sem texto, o ícone de limpar não é renderizado
    expect(screen.queryByRole('button', { name: 'Limpar busca' })).not.toBeInTheDocument();

    await user.type(search, 'ACME');
    await user.click(screen.getByRole('button', { name: 'Limpar busca' }));

    expect(search).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Limpar busca' })).not.toBeInTheDocument();
  });
});
