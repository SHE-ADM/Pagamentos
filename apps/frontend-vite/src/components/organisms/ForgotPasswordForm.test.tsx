import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mock do cliente Supabase — nenhuma chamada de rede real nos testes.
const resetPasswordForEmail = vi.fn();
vi.mock('../../lib/supabaseClient', () => ({
  supabase: { auth: { resetPasswordForEmail: (...args: unknown[]) => resetPasswordForEmail(...args) } },
}));

import ForgotPasswordForm from './ForgotPasswordForm';

function renderForm() {
  return render(
    <MemoryRouter>
      <ForgotPasswordForm />
    </MemoryRouter>,
  );
}

const SUCCESS_TEXT = /Se este e-mail estiver cadastrado/i;

describe('ForgotPasswordForm', () => {
  beforeEach(() => {
    resetPasswordForEmail.mockReset();
  });

  it('renderiza o campo de e-mail e o botão de envio', () => {
    renderForm();
    expect(screen.getByLabelText('E-mail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar link de redefinição' })).toBeInTheDocument();
  });

  it('exibe a mensagem genérica de sucesso ao enviar', async () => {
    resetPasswordForEmail.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('E-mail'), 'admin@sheild.app.br');
    await user.click(screen.getByRole('button', { name: 'Enviar link de redefinição' }));

    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      'admin@sheild.app.br',
      expect.objectContaining({ redirectTo: expect.stringContaining('/auth/reset-password') }),
    );
    expect(await screen.findByText(SUCCESS_TEXT)).toBeInTheDocument();
  });

  it('mantém a mensagem genérica mesmo quando o Supabase rejeita (não vaza erro)', async () => {
    resetPasswordForEmail.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('E-mail'), 'admin@sheild.app.br');
    await user.click(screen.getByRole('button', { name: 'Enviar link de redefinição' }));

    // O catch evita unhandled rejection e ainda exibe o estado genérico de envio.
    expect(await screen.findByText(SUCCESS_TEXT)).toBeInTheDocument();
  });
});
