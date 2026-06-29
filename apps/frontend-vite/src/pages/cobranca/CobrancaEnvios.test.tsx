import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mocka o serviço de dados — o teste cobre a fiação dos filtros, não a rede.
const fetchEnviosLog = vi.fn();

vi.mock('../../services/cobrancaService', () => ({
  fetchEnviosLog: (...args: unknown[]) => fetchEnviosLog(...args),
}));

// Sessão válida — a página lê `session.access_token` para chamar o serviço.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'test-token' }, user: null, loading: false, signOut: vi.fn() }),
}));

import CobrancaEnvios from './CobrancaEnvios';

describe('CobrancaEnvios — filtros de data', () => {
  beforeEach(() => {
    fetchEnviosLog.mockReset();
    fetchEnviosLog.mockResolvedValue({ data: [], total: 0 });
  });

  it('renderiza os quatro campos de data (envio e vencimento)', async () => {
    render(<CobrancaEnvios />);
    await waitFor(() => expect(fetchEnviosLog).toHaveBeenCalled());
    expect(screen.getByLabelText('Envio de')).toBeInTheDocument();
    expect(screen.getByLabelText('Envio até')).toBeInTheDocument();
    expect(screen.getByLabelText('Vencimento de')).toBeInTheDocument();
    expect(screen.getByLabelText('Vencimento até')).toBeInTheDocument();
  });

  it('ordena por data de envio descendente por padrão', async () => {
    render(<CobrancaEnvios />);
    await waitFor(() =>
      expect(fetchEnviosLog).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortCol: 'sent_at', sortDir: 'desc' }),
      ),
    );
  });

  it('reordena ao clicar no cabeçalho de uma coluna (asc)', async () => {
    render(<CobrancaEnvios />);
    await waitFor(() => expect(fetchEnviosLog).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Cliente'));

    await waitFor(() =>
      expect(fetchEnviosLog).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortCol: 'customer_name', sortDir: 'asc' }),
      ),
    );
  });

  it('aplica o filtro por data de envio (sent_at) na consulta', async () => {
    render(<CobrancaEnvios />);
    await waitFor(() => expect(fetchEnviosLog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Envio de'), { target: { value: '2026-06-01' } });

    await waitFor(() =>
      expect(fetchEnviosLog).toHaveBeenLastCalledWith(
        expect.objectContaining({ sentFrom: '2026-06-01', page: 1 }),
      ),
    );
  });

  it('aplica o filtro por data de vencimento (due_date) na consulta', async () => {
    render(<CobrancaEnvios />);
    await waitFor(() => expect(fetchEnviosLog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Vencimento até'), { target: { value: '2026-06-30' } });

    await waitFor(() =>
      expect(fetchEnviosLog).toHaveBeenLastCalledWith(
        expect.objectContaining({ dueTo: '2026-06-30', page: 1 }),
      ),
    );
  });

  it('limpa os filtros ao clicar em "Limpar"', async () => {
    render(<CobrancaEnvios />);
    await waitFor(() => expect(fetchEnviosLog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Envio de'), { target: { value: '2026-06-01' } });
    await waitFor(() => expect(screen.getByText('Limpar')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Limpar'));

    // Após limpar, a última consulta não carrega filtro de envio (sentFrom undefined).
    await waitFor(() =>
      expect(fetchEnviosLog).toHaveBeenLastCalledWith(expect.objectContaining({ sentFrom: undefined })),
    );
  });
});
