import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mock do cliente Supabase — nenhuma chamada de rede real nos testes.
const signInWithPassword = vi.fn();
vi.mock('../../lib/supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: (...args: unknown[]) => signInWithPassword(...args) } },
}));

import LoginForm from './LoginForm';

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginForm />
    </MemoryRouter>,
  );
}

describe('LoginForm', () => {
  beforeEach(() => {
    signInWithPassword.mockReset();
  });

  it('renderiza os campos de e-mail e senha e o botão de login', () => {
    renderLogin();
    expect(screen.getByText('Email ou usuário')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('usuario123')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument();
  });

  it('submete credenciais via supabase.auth.signInWithPassword', async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByPlaceholderText('usuario123'), 'admin@sheild.app.br');
    await user.type(screen.getByPlaceholderText('••••••'), 'segredo123');
    await user.click(screen.getByRole('button', { name: 'Login' }));

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'admin@sheild.app.br',
      password: 'segredo123',
    });
  });

  it('exibe erro inline quando as credenciais são inválidas', async () => {
    signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } });
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByPlaceholderText('usuario123'), 'x@y.com');
    await user.type(screen.getByPlaceholderText('••••••'), 'errada');
    await user.click(screen.getByRole('button', { name: 'Login' }));

    expect(await screen.findByText('E-mail ou senha incorretos.')).toBeInTheDocument();
  });
});
