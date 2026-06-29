import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from '../../../tests/axe';

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    auth: { updateUser: vi.fn().mockResolvedValue({ error: null }) },
  },
}));

import ChangePasswordForm from './ChangePasswordForm';

describe('ChangePasswordForm — acessibilidade (WCAG AA)', () => {
  it('formulário de troca obrigatória não tem violações', async () => {
    const { container } = render(
      <MemoryRouter>
        <ChangePasswordForm />
      </MemoryRouter>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
