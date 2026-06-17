import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mocka os serviços de dados e o reader — o teste cobre o layout/interação, não a rede.
const getEmailControl = vi.fn();
const getEmailStats = vi.fn();
const getAccountsByMessageId = vi.fn();
const getInvoiceNumbersByMessageIds = vi.fn();
const markEmailReviewed = vi.fn();

vi.mock('../services/supabase', () => ({
  getEmailControl: (...a: unknown[]) => getEmailControl(...a),
  getEmailStats: (...a: unknown[]) => getEmailStats(...a),
  getAccountsByMessageId: (...a: unknown[]) => getAccountsByMessageId(...a),
  getInvoiceNumbersByMessageIds: (...a: unknown[]) => getInvoiceNumbersByMessageIds(...a),
  markEmailReviewed: (...a: unknown[]) => markEmailReviewed(...a),
}));

const falhaRow = {
  id: 7, message_id: '<x@y>', imap_uid: null,
  received_at: '2026-06-10T12:00:00Z', sender_name: 'Fornecedor X',
  sender_email: 'f@x.com', subject: 'Boleto perdido', body_preview: '',
  keyword_matched: 'boleto', has_attachment: false, attachment_names: null,
  attachment_saved: false, pdf_extracted: false, extraction_csv: null,
  status: 'falha', notes: null, processed_at: '2026-06-10T12:00:00Z',
  updated_at: '2026-06-10T12:00:00Z', reviewed_at: null,
};
vi.mock('../services/emailReader', () => ({
  startEmailRead: vi.fn(),
  getEmailReadProgress: vi.fn(() => Promise.resolve({ running: false })),
}));
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

  it('cada card usa a cor do StatusBadge correspondente (Falha=erro, Extraídos=sucesso)', async () => {
    render(<Emails />);
    await waitFor(() => expect(getEmailStats).toHaveBeenCalled());

    // O card "Falha" carrega o tom de erro (mesma cor do badge de status 'falha').
    const falhaCard = screen.getByText('Falha').closest('button');
    expect(falhaCard?.querySelector('.text-status-error-fg')).not.toBeNull();

    // O card "Extraídos" carrega o tom de sucesso (mesma cor do badge 'extraído').
    const extraidoCard = screen.getByText('Extraídos').closest('button');
    expect(extraidoCard?.querySelector('.text-status-success-fg')).not.toBeNull();
  });

  it('marca e-mail com falha como revisado ao abrir o card e exibe o check', async () => {
    const user = userEvent.setup();
    getEmailControl.mockResolvedValue([{ ...falhaRow }]);
    markEmailReviewed.mockResolvedValue('2026-06-17T10:00:00Z');
    render(<Emails />);
    await waitFor(() => expect(getEmailControl).toHaveBeenCalled());

    // Sem check antes da revisão.
    expect(screen.queryByLabelText('Revisado')).not.toBeInTheDocument();

    // Abrir o card de detalhes (clicar na linha) marca como revisado.
    await user.click(screen.getByText('Boleto perdido'));
    expect(markEmailReviewed).toHaveBeenCalledWith(7);

    // Após o estado atualizar, o check de revisado aparece.
    await waitFor(() => expect(screen.getByLabelText('Revisado')).toBeInTheDocument());
  });
});
