import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mock do cliente Supabase, do endpoint de marca (Next API) e do navigate — sem rede.
const updateUser = vi.fn();
const refreshSession = vi.fn();
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      updateUser: (...args: unknown[]) => updateUser(...args),
      refreshSession: (...args: unknown[]) => refreshSession(...args),
    },
  },
}));
const dataApiCall = vi.fn();
vi.mock('../../services/dataApi', () => ({ dataApiCall: (...args: unknown[]) => dataApiCall(...args) }));
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

import ChangePasswordForm from './ChangePasswordForm';

function renderForm() {
  return render(
    <MemoryRouter>
      <ChangePasswordForm />
    </MemoryRouter>,
  );
}

async function preencheEEnvia() {
  const user = userEvent.setup();
  const campos = screen.getAllByPlaceholderText('••••••••');
  await user.type(campos[0], 'novaSenha123');
  await user.type(campos[1], 'novaSenha123');
  await user.click(screen.getByRole('button', { name: /salvar nova senha/i }));
}

describe('ChangePasswordForm', () => {
  beforeEach(() => {
    updateUser.mockReset();
    refreshSession.mockReset();
    dataApiCall.mockReset();
    navigate.mockReset();
  });

  it('renderiza os campos de nova senha e confirmação', () => {
    renderForm();
    expect(screen.getByText('Nova senha')).toBeInTheDocument();
    expect(screen.getByText('Confirmar nova senha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /salvar nova senha/i })).toBeInTheDocument();
  });

  it('troca a senha, marca no backend (app_metadata) + refresh e segue para o app', async () => {
    updateUser.mockResolvedValue({ error: null });
    dataApiCall.mockResolvedValue({ success: true, data: { password_changed: true } });
    refreshSession.mockResolvedValue({ data: {}, error: null });
    renderForm();
    await preencheEEnvia();

    // updateUser NÃO grava mais a marca em user_metadata (só a senha).
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: 'novaSenha123' }));
    // A marca vai para app_metadata via o endpoint server-controlled + refresh da sessão.
    expect(dataApiCall).toHaveBeenCalledWith('/users/me/password-changed', { method: 'POST' });
    expect(refreshSession).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/consulta', { replace: true });
  });

  it('exibe erro e não chama o backend quando o updateUser falha', async () => {
    updateUser.mockResolvedValue({ error: { message: 'boom' } });
    renderForm();
    await preencheEEnvia();

    expect(await screen.findByText(/não foi possível alterar a senha/i)).toBeInTheDocument();
    expect(dataApiCall).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('orienta a refazer login quando a marca no backend falha', async () => {
    updateUser.mockResolvedValue({ error: null });
    dataApiCall.mockRejectedValue(new Error('500'));
    renderForm();
    await preencheEEnvia();

    expect(await screen.findByText(/faça login novamente/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
