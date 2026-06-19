import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { axe } from '../../../tests/axe';

// Mocka o serviço de dados — o teste cobre a acessibilidade do layout, não a rede.
const fetchEnviosLog = vi.fn();

vi.mock('../../services/cobrancaService', () => ({
  fetchEnviosLog: (...args: unknown[]) => fetchEnviosLog(...args),
}));

// Sessão válida — a página lê `session.access_token` para chamar o serviço.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'test-token' }, user: null, loading: false, signOut: vi.fn() }),
}));

import CobrancaEnvios from './CobrancaEnvios';

describe('CobrancaEnvios — acessibilidade (WCAG AA)', () => {
  beforeEach(() => {
    fetchEnviosLog.mockResolvedValue({ data: [], total: 0 });
  });

  it('página de envios (busca + tabela) não tem violações', async () => {
    const { container } = render(<CobrancaEnvios />);
    await waitFor(() => expect(fetchEnviosLog).toHaveBeenCalled());
    expect(await axe(container)).toHaveNoViolations();
  });
});
