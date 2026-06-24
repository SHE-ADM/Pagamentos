import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { axe } from '../../tests/axe';

// Mocka os serviços de dados e o reader — o teste cobre a acessibilidade do layout.
const getEmailControl = vi.fn();
const getEmailStats = vi.fn();
const getAccountsByMessageId = vi.fn();
const getInvoiceNumbersByMessageIds = vi.fn();
const getCompanyEmail = vi.fn();

vi.mock('../services/supabase', () => ({
  getEmailControl: (...a: unknown[]) => getEmailControl(...a),
  getEmailStats: (...a: unknown[]) => getEmailStats(...a),
  getAccountsByMessageId: (...a: unknown[]) => getAccountsByMessageId(...a),
  getInvoiceNumbersByMessageIds: (...a: unknown[]) => getInvoiceNumbersByMessageIds(...a),
  getCompanyEmail: (...a: unknown[]) => getCompanyEmail(...a),
}));
vi.mock('../services/emailReader', () => ({
  startEmailRead: vi.fn(),
  getEmailReadProgress: vi.fn(() => Promise.resolve({ running: false })),
}));
vi.mock('../hooks/useIdleLogout', () => ({ suspendIdleLogout: vi.fn(), resumeIdleLogout: vi.fn() }));

import Emails from './Emails';

describe('Emails — acessibilidade (WCAG AA)', () => {
  beforeEach(() => {
    getEmailControl.mockResolvedValue([]);
    getEmailStats.mockResolvedValue({});
    getAccountsByMessageId.mockResolvedValue([]);
    getInvoiceNumbersByMessageIds.mockResolvedValue({});
    getCompanyEmail.mockResolvedValue('financeiro@otimotex.com.br');
  });

  it('página de e-mails (filtros + tabela) não tem violações', async () => {
    const { container } = render(<Emails />);
    await waitFor(() => expect(getEmailControl).toHaveBeenCalled());
    expect(await axe(container)).toHaveNoViolations();
  });
});
