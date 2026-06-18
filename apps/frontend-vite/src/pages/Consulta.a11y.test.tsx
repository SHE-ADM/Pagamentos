import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { axe } from '../../tests/axe';

// Mocka o serviço de dados — o teste cobre a acessibilidade do layout, não a rede.
const getFinancialAccountControl = vi.fn();
const getFinancialStats = vi.fn();
const getFinancialAccountTotalValue = vi.fn();

vi.mock('../services/supabase', () => ({
  getFinancialAccountControl: (...args: unknown[]) => getFinancialAccountControl(...args),
  getFinancialStats: (...args: unknown[]) => getFinancialStats(...args),
  getFinancialAccountTotalValue: (...args: unknown[]) => getFinancialAccountTotalValue(...args),
  setFinancialAccountFlag: vi.fn(),
  setFinancialAccountStatus: vi.fn(),
}));

import Consulta from './Consulta';

describe('Consulta — acessibilidade (WCAG AA)', () => {
  beforeEach(() => {
    getFinancialAccountControl.mockResolvedValue({ data: [], total: 0 });
    getFinancialStats.mockResolvedValue({ totalRecords: 0, pending: 0, totalValue: 0, vencendo: 0, vencidas: 0 });
    getFinancialAccountTotalValue.mockResolvedValue(0);
  });

  it('página de consulta (filtros + tabela) não tem violações', async () => {
    const { container } = render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());
    expect(await axe(container)).toHaveNoViolations();
  });
});
