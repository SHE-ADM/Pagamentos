import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { axe } from '../../tests/axe';

// Mocka o serviço de dados — o teste cobre a acessibilidade do layout, não a rede.
const getFinancialAccountControl = vi.fn();
const getFinancialStats = vi.fn();
const getFinancialAccountTotalValue = vi.fn();
const getFinancialAccountCount = vi.fn();

vi.mock('../services/supabase', () => ({
  getFinancialAccountControl: (...args: unknown[]) => getFinancialAccountControl(...args),
  getFinancialStats: (...args: unknown[]) => getFinancialStats(...args),
  getFinancialAccountTotalValue: (...args: unknown[]) => getFinancialAccountTotalValue(...args),
  getFinancialAccountCount: (...args: unknown[]) => getFinancialAccountCount(...args),
  setFinancialAccountFlag: vi.fn(),
  setFinancialAccountStatus: vi.fn(),
  getAppUsers: vi.fn(() => Promise.resolve({})),
}));

// Consulta usa useAuth (gate do hard delete). Sem provider no teste → mock.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ isAdminGroup: false }),
}));

// Lookups dos filtros — sem isto o teste iria à rede de verdade. As opções precisam
// existir para o axe avaliar os <select> POPULADOS da 2ª linha, não só o placeholder.
vi.mock('../services/lookups', () => ({
  listCompanies: () => Promise.resolve([{ sk_company: 1, trade_name: 'OTIMOTEX TECIDOS' }]),
  listCostCenters: () =>
    Promise.resolve([{ cost_center_id: 4, cost_center_code: '004', cost_center_description: 'Logística' }]),
  listChartAccountGroups: () =>
    Promise.resolve([{ chart_account_group_id: 24, group_code: '24', group_description: 'Despesas Fixas' }]),
  listChartAccountSubgroups: () =>
    Promise.resolve([
      { chart_account_subgroup_id: 93, subgroup_code: '93', subgroup_description: 'Copa e Cozinha' },
    ]),
  listPlanoDescriptions: () => Promise.resolve([{ account_description: 'Serviços Gerais' }]),
}));

import Consulta from './Consulta';

describe('Consulta — acessibilidade (WCAG AA)', () => {
  beforeEach(() => {
    getFinancialAccountControl.mockResolvedValue({ data: [], total: 0 });
    getFinancialStats.mockResolvedValue({ totalRecords: 0, pending: 0, totalValue: 0, vencendo: 0, vencidas: 0 });
    getFinancialAccountTotalValue.mockResolvedValue(0);
    getFinancialAccountCount.mockResolvedValue(0);
  });

  it('página de consulta (filtros + tabela) não tem violações', async () => {
    const { container } = render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());
    // Espera que OBSERVA o que o mock acima promete: os <select> da 2ª linha POPULADOS.
    // Aguardar só a chamada do serviço de dados não garante isso — os lookups são outra
    // promessa, e se um dia ficarem mais lentos o axe passaria a escanear apenas o
    // placeholder, com o teste seguindo verde (CLAUDE.md §Regra 2: a asserção precisa
    // observar a garantia que o comentário afirma).
    await screen.findByRole('option', { name: '24 — Despesas Fixas' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
