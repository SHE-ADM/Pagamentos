import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResendProgress } from '../../services/cobrancaService';

// Mock do serviço de reenvio — nenhuma chamada de rede real.
const startResend = vi.fn();
const getResendProgress = vi.fn();
vi.mock('../../services/cobrancaService', () => ({
  startResend: (...a: unknown[]) => startResend(...a),
  getResendProgress: (...a: unknown[]) => getResendProgress(...a),
}));

import ResendErrosAction from './ResendErrosAction';

const DONE: ResendProgress = {
  running: false, phase: 'concluído', total: 2, done: 2,
  sent: 2, skipped: 0, no_email: 0, error: 0, elapsed: 1,
  results: [
    { id: 1, document_id: '1', status: 'sent', message: 'Enviado.' },
    { id: 2, document_id: '2', status: 'sent', message: 'Enviado.' },
  ],
  error_msg: null,
};

function renderAction(overrides: Partial<React.ComponentProps<typeof ResendErrosAction>> = {}) {
  const props = {
    ids: [1, 2],
    ready: true,
    reason: null,
    clearSelection: vi.fn(),
    onFinished: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  render(<ResendErrosAction {...props} />);
  return props;
}

describe('ResendErrosAction', () => {
  beforeEach(() => {
    startResend.mockReset();
    getResendProgress.mockReset();
  });

  it('fica desabilitado quando o backend não está pronto, com o motivo no title', () => {
    renderAction({ ready: false, reason: 'Backend offline ou não configurado.' });
    const btn = screen.getByRole('button', { name: /reenviar e-mails \(2\)/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Backend offline ou não configurado.');
  });

  it('pede confirmação antes de enviar e cancela voltando ao estado inicial', async () => {
    const user = userEvent.setup();
    renderAction();
    await user.click(screen.getByRole('button', { name: /reenviar e-mails \(2\)/i }));
    expect(screen.getByText(/reenviar 2 e-mails de cobrança\?/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByRole('button', { name: /reenviar e-mails \(2\)/i })).toBeInTheDocument();
    expect(startResend).not.toHaveBeenCalled();
  });

  it('confirma, dispara o reenvio com os ids e avisa ao concluir', async () => {
    startResend.mockResolvedValue({ started: true, alreadyRunning: false });
    getResendProgress.mockResolvedValue(DONE);
    const user = userEvent.setup();
    const props = renderAction();

    await user.click(screen.getByRole('button', { name: /reenviar e-mails \(2\)/i }));
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(startResend).toHaveBeenCalledWith([1, 2]);
    await waitFor(() => expect(props.onFinished).toHaveBeenCalledWith(DONE));
    expect(props.clearSelection).toHaveBeenCalled();
  });

  it('reporta erro de disparo via onError', async () => {
    startResend.mockRejectedValue(new Error('Servidor de reenvio indisponível.'));
    const user = userEvent.setup();
    const props = renderAction();

    await user.click(screen.getByRole('button', { name: /reenviar e-mails \(2\)/i }));
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() =>
      expect(props.onError).toHaveBeenCalledWith('Servidor de reenvio indisponível.'),
    );
  });
});
