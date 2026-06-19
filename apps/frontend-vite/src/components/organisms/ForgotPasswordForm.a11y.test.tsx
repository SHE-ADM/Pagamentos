import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from '../../../tests/axe';

vi.mock('../../lib/supabaseClient', () => ({
  supabase: { auth: { resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }) } },
}));

import ForgotPasswordForm from './ForgotPasswordForm';

describe('ForgotPasswordForm — acessibilidade (WCAG AA)', () => {
  it('formulário de recuperação não tem violações', async () => {
    const { container } = render(
      <MemoryRouter>
        <ForgotPasswordForm />
      </MemoryRouter>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
