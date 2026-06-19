import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { axe } from '../../tests/axe';

// Mocka o serviço de dados — o teste cobre a acessibilidade do layout, não a rede.
const getProcessingErrors = vi.fn();
const getProcessingErrorStats = vi.fn();

vi.mock('../services/supabase', () => ({
  getProcessingErrors: (...a: unknown[]) => getProcessingErrors(...a),
  getProcessingErrorStats: (...a: unknown[]) => getProcessingErrorStats(...a),
}));

import Erros from './Erros';

describe('Erros — acessibilidade (WCAG AA)', () => {
  beforeEach(() => {
    getProcessingErrors.mockResolvedValue({ data: [], total: 0 });
    getProcessingErrorStats.mockResolvedValue({ total: 0, counts: {} });
  });

  it('página de erros (filtros + tabela) não tem violações', async () => {
    const { container } = render(<Erros />);
    await waitFor(() => expect(getProcessingErrors).toHaveBeenCalled());
    expect(await axe(container)).toHaveNoViolations();
  });
});
