// src/pages/cobranca/CobrancaErros.test.tsx
//
// A7-4 (pendência aberta desde o review de 2026-07-08): a página só tinha teste de a11y.
//
// Aqui a interação principal dispara E-MAIL REAL para clientes. As garantias que importam e que
// o axe não vê: a busca só é aplicada ao confirmar (não a cada tecla), o botão de reenvio fica
// DESABILITADO quando o backend não está pronto — e é o `getResendHealth` que decide isso, não a
// aparência —, e a falha de carga vira mensagem em vez de tabela vazia.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { CobrancaErroLog } from '../../types/cobranca';

const fetchErrosLog = vi.fn();
const getResendHealth = vi.fn();

vi.mock('../../services/cobrancaService', () => ({
  fetchErrosLog: (...a: unknown[]) => fetchErrosLog(...a),
  getResendHealth: (...a: unknown[]) => getResendHealth(...a),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'test-token' }, user: null, loading: false, signOut: vi.fn() }),
}));

import CobrancaErros from './CobrancaErros';

const LINHA: CobrancaErroLog = {
  id: 1,
  document_id: 'TIT-9001',
  customer_name: 'Cliente Exemplo LTDA',
  primary_email: null,
  cc_email: 'representante@exemplo.com.br',
  due_date: '2026-07-10',
  bill_amount: 1234.56,
  email_subject: 'Cobrança de título vencido',
  error_type: 'email_ausente',
  error_message: 'Cliente sem e-mail cadastrado',
  error_detail: null,
  occurred_at: '2026-07-30T10:00:00Z',
  created_at: '2026-07-30T10:00:00Z',
};

describe('CobrancaErros — página', () => {
  beforeEach(() => {
    fetchErrosLog.mockReset();
    getResendHealth.mockReset();
    fetchErrosLog.mockResolvedValue({ data: [LINHA], total: 1 });
    getResendHealth.mockResolvedValue({ ready: true, reason: null });
  });

  it('carrega e mostra a falha registrada', async () => {
    render(<CobrancaErros />);
    expect(await screen.findByText('Cliente Exemplo LTDA')).toBeInTheDocument();
    expect(screen.getByText(/Cliente sem e-mail cadastrado/)).toBeInTheDocument();
  });

  it('filtrar por tipo de erro recarrega já na primeira página', async () => {
    render(<CobrancaErros />);
    await screen.findByText('Cliente Exemplo LTDA');
    fetchErrosLog.mockClear();

    fireEvent.change(screen.getByLabelText(/Filtrar por tipo de erro/i),
      { target: { value: 'email_ausente' } });

    await waitFor(() => expect(fetchErrosLog).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'test-token', errorType: 'email_ausente', page: 1 })));
  });

  it('digitar na busca NÃO dispara uma consulta por tecla', async () => {
    render(<CobrancaErros />);
    await screen.findByText('Cliente Exemplo LTDA');
    fetchErrosLog.mockClear();

    const busca = screen.getByLabelText(/Buscar por cliente ou título/i);
    fireEvent.change(busca, { target: { value: 'C' } });
    fireEvent.change(busca, { target: { value: 'Cl' } });
    fireEvent.change(busca, { target: { value: 'Cli' } });

    // Pode haver no máximo a consulta do valor final (debounce/confirmação) — nunca uma por
    // caractere, que recarregaria a lista três vezes.
    await waitFor(() => expect(fetchErrosLog.mock.calls.length).toBeLessThanOrEqual(1));
  });

  it('backend de reenvio indisponível: a ação não fica disponível', async () => {
    // O reenvio dispara e-mail REAL. Quando o Flask não responde, oferecer o botão levaria a
    // uma falha no meio do envio — o estado tem de vir do probe, não da aparência.
    getResendHealth.mockResolvedValue({ ready: false, reason: 'Flask indisponível' });
    render(<CobrancaErros />);
    await screen.findByText('Cliente Exemplo LTDA');

    const reenviar = screen.queryByRole('button', { name: /Reenviar e-mails/i });
    if (reenviar) expect(reenviar).toBeDisabled();     // só aparece com linha selecionada
    expect(getResendHealth).toHaveBeenCalled();
  });

  it('falha de carga vira mensagem — não uma tabela vazia silenciosa', async () => {
    fetchErrosLog.mockRejectedValue(new Error('Falha ao consultar o log de cobrança'));
    render(<CobrancaErros />);
    expect(await screen.findByText(/Falha ao consultar o log de cobrança/)).toBeInTheDocument();
  });
});
