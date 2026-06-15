import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from '../../../tests/axe';

// Mock do cliente Supabase — sem rede real no teste.
vi.mock('../../lib/supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: vi.fn() } },
}));

import LoginForm from './LoginForm';

describe('LoginForm — acessibilidade (WCAG AA)', () => {
  it('formulário de login não tem violações', async () => {
    const { container } = render(
      <MemoryRouter>
        <LoginForm />
      </MemoryRouter>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
