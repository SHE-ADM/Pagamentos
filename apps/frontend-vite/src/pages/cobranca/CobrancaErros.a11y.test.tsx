import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { axe } from '../../../tests/axe';

// Mocka o serviço de dados — o teste cobre a acessibilidade do layout, não a rede.
const fetchErrosLog = vi.fn();

vi.mock('../../services/cobrancaService', () => ({
  fetchErrosLog: (...args: unknown[]) => fetchErrosLog(...args),
}));

// Sessão válida — a página lê `session.access_token` para chamar o serviço.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'test-token' }, user: null, loading: false, signOut: vi.fn() }),
}));

import CobrancaErros from './CobrancaErros';

describe('CobrancaErros — acessibilidade (WCAG AA)', () => {
  beforeEach(() => {
    fetchErrosLog.mockResolvedValue({ data: [], total: 0 });
  });

  it('página de falhas (busca + filtro + tabela) não tem violações', async () => {
    const { container } = render(<CobrancaErros />);
    await waitFor(() => expect(fetchErrosLog).toHaveBeenCalled());
    expect(await axe(container)).toHaveNoViolations();
  });
});
