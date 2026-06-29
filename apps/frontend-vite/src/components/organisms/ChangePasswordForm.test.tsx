import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mock do cliente Supabase e do navigate — sem rede nem rota real.
const updateUser = vi.fn();
vi.mock('../../lib/supabaseClient', () => ({
  supabase: { auth: { updateUser: (...args: unknown[]) => updateUser(...args) } },
}));
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

describe('ChangePasswordForm', () => {
  beforeEach(() => {
    updateUser.mockReset();
    navigate.mockReset();
  });

  it('renderiza os campos de nova senha e confirmação', () => {
    renderForm();
    expect(screen.getByText('Nova senha')).toBeInTheDocument();
    expect(screen.getByText('Confirmar nova senha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /salvar nova senha/i })).toBeInTheDocument();
  });

  it('grava a nova senha + a marca password_changed e segue para o app', async () => {
    updateUser.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderForm();

    const campos = screen.getAllByPlaceholderText('••••••••');
    await user.type(campos[0], 'novaSenha123');
    await user.type(campos[1], 'novaSenha123');
    await user.click(screen.getByRole('button', { name: /salvar nova senha/i }));

    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith({
        password: 'novaSenha123',
        data: { password_changed: true },
      }),
    );
    expect(navigate).toHaveBeenCalledWith('/consulta', { replace: true });
  });

  it('exibe erro e não navega quando o updateUser falha', async () => {
    updateUser.mockResolvedValue({ error: { message: 'boom' } });
    const user = userEvent.setup();
    renderForm();

    const campos = screen.getAllByPlaceholderText('••••••••');
    await user.type(campos[0], 'novaSenha123');
    await user.type(campos[1], 'novaSenha123');
    await user.click(screen.getByRole('button', { name: /salvar nova senha/i }));

    expect(await screen.findByText(/não foi possível alterar a senha/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
