import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mocka o serviço de dados — o teste cobre o layout/interação, não a rede.
const getFinancialAccountControl = vi.fn();
const getFinancialStats = vi.fn();
const getFinancialAccountTotalValue = vi.fn();

vi.mock('../services/supabase', () => ({
  getFinancialAccountControl: (...args: unknown[]) => getFinancialAccountControl(...args),
  getFinancialStats: (...args: unknown[]) => getFinancialStats(...args),
  getFinancialAccountTotalValue: (...args: unknown[]) => getFinancialAccountTotalValue(...args),
}));

import Consulta from './Consulta';

describe('Consulta', () => {
  beforeEach(() => {
    getFinancialAccountControl.mockResolvedValue({ data: [], total: 0 });
    getFinancialStats.mockResolvedValue({
      totalRecords: 0,
      pending: 0,
      totalValue: 0,
      vencendo: 0,
      vencidas: 0,
    });
    getFinancialAccountTotalValue.mockResolvedValue(0);
  });

  it('renderiza cabeçalho, cards de métricas e estado vazio', async () => {
    render(<Consulta />);

    expect(screen.getByText('Consulta de movimentações')).toBeInTheDocument();
    expect(screen.getByText('Total de registros')).toBeInTheDocument();
    expect(screen.getByText('Vencidas')).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByText(/Nenhum registro encontrado/),
      ).toBeInTheDocument(),
    );
  });

  it('o botão Limpar reseta o campo de fornecedor', async () => {
    const user = userEvent.setup();
    render(<Consulta />);

    const supplier = screen.getByPlaceholderText('Fornecedor, CNPJ, Nº doc, assunto ou remetente…');
    await user.type(supplier, 'ACME');
    expect(supplier).toHaveValue('ACME');

    await user.click(screen.getByRole('button', { name: /Limpar/ }));
    expect(supplier).toHaveValue('');
  });

  it('atualiza o card "Valor total" conforme o filtro do card Pendentes', async () => {
    const user = userEvent.setup();
    // 1ª soma (sem filtro) = global; após clicar Pendentes = subconjunto filtrado.
    getFinancialAccountTotalValue.mockResolvedValueOnce(5000).mockResolvedValueOnce(1234);
    render(<Consulta />);

    // valor global é exibido
    await waitFor(() => expect(screen.getByText(/5\.000,00/)).toBeInTheDocument());

    await user.click(screen.getByText('Pendentes'));

    // a soma é refeita com o filtro do card...
    await waitFor(() =>
      expect(getFinancialAccountTotalValue).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'pendente' }),
      ),
    );
    // ...e o card passa a refletir o valor filtrado
    await waitFor(() => expect(screen.getByText(/1\.234,00/)).toBeInTheDocument());
  });
});
