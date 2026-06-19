import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from '../../../tests/axe';

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      updateUser: vi.fn().mockResolvedValue({ error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  },
}));

import ResetPasswordForm from './ResetPasswordForm';

describe('ResetPasswordForm — acessibilidade (WCAG AA)', () => {
  it('formulário de nova senha não tem violações', async () => {
    const { container } = render(
      <MemoryRouter>
        <ResetPasswordForm />
      </MemoryRouter>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
