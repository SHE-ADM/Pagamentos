// src/components/organisms/ResetPasswordForm.test.tsx
//
// A7-3 (pendência aberta desde o review de 2026-07-08): o formulário só tinha teste de a11y.
//
// É o último passo do fluxo "esqueci a senha" — se ele falhar em silêncio, o usuário fica
// trancado fora do sistema. Três garantias que o teste de a11y não alcança: senhas divergentes
// não chegam ao servidor, o `signOut()` acontece ANTES do redirecionamento (senão a sessão
// temporária do link de recuperação sobreviveria à troca) e a falha do provedor vira mensagem
// em vez de navegação.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const updateUser = vi.fn();
const signOut = vi.fn();
const navigate = vi.fn();

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { auth: { updateUser: (...a: unknown[]) => updateUser(...a), signOut: () => signOut() } },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

import ResetPasswordForm from './ResetPasswordForm';

const SENHA = 'senha-nova-123';

async function preencher(nova: string, confirmacao: string) {
  const usuario = userEvent.setup();
  await usuario.type(screen.getByLabelText(/^Nova senha$/i), nova);
  await usuario.type(screen.getByLabelText(/Confirmar nova senha/i), confirmacao);
  fireEvent.submit(screen.getByRole('button', { name: /Redefinir senha/i }).closest('form')!);
}

describe('ResetPasswordForm', () => {
  beforeEach(() => {
    updateUser.mockReset();
    signOut.mockReset();
    navigate.mockReset();
    updateUser.mockResolvedValue({ error: null });
    signOut.mockResolvedValue({ error: null });
  });

  it('senha válida: troca, DESLOGA e volta ao login sinalizando o sucesso', async () => {
    render(<ResetPasswordForm />);
    await preencher(SENHA, SENHA);

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: SENHA }));
    expect(signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/auth/login',
      { replace: true, state: { passwordReset: true } });
  });

  it('desloga ANTES de navegar', async () => {
    // A sessão aberta pelo link de recuperação é temporária e privilegiada: navegar sem
    // encerrá-la deixaria o usuário autenticado por um token que veio de um e-mail.
    const ordem: string[] = [];
    signOut.mockImplementation(() => { ordem.push('signOut'); return Promise.resolve({ error: null }); });
    navigate.mockImplementation(() => { ordem.push('navigate'); });

    render(<ResetPasswordForm />);
    await preencher(SENHA, SENHA);

    await waitFor(() => expect(ordem).toEqual(['signOut', 'navigate']));
  });

  it('confirmação divergente NÃO chega ao servidor', async () => {
    render(<ResetPasswordForm />);
    await preencher(SENHA, 'outra-senha-456');

    expect(await screen.findByText(/senhas não conferem/i)).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('senha curta é barrada pelo schema compartilhado', async () => {
    render(<ResetPasswordForm />);
    await preencher('123', '123');

    expect(await screen.findByText(/no mínimo 8 caracteres/i)).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('falha do provedor vira mensagem e NÃO navega — o usuário pode tentar de novo', async () => {
    updateUser.mockResolvedValue({ error: { message: 'Auth session missing!' } });
    render(<ResetPasswordForm />);
    await preencher(SENHA, SENHA);

    expect(await screen.findByText(/Não foi possível redefinir a senha/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
});
