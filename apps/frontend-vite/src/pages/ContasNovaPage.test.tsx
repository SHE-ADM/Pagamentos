import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../services/contas', () => ({ createConta: vi.fn() }));
// Stub do SupplierSelect (evita o react-select + rede no teste da página).
vi.mock('../components/molecules/SupplierSelect', () => ({
  default: ({ label, onChange }: { label: string; onChange: (sk: number | null) => void }) => (
    <button type="button" aria-label={label} onClick={() => onChange(1)}>
      {label}
    </button>
  ),
}));

vi.mock('../components/molecules/CostCenterSelect', () => ({
  default: ({ label }: { label: string }) => <input aria-label={label} />,
}));
vi.mock('../components/molecules/ChartAccountSelect', () => ({
  default: ({ label }: { label: string }) => <input aria-label={label} />,
}));

import ContasNovaPage from './ContasNovaPage';

describe('ContasNovaPage', () => {
  it('renderiza o título e o formulário de lançamento', () => {
    render(<ContasNovaPage />);
    expect(screen.getByRole('heading', { name: 'Cadastro de contas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lançar conta' })).toBeInTheDocument();
  });
});
