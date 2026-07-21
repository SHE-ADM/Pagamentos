// src/components/dashboard/DonutCard.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DonutCard } from './DonutCard';

const SLICES = [
  { label: 'Folha de Pagamento', value: 10000 },
  { label: 'Transporte', value: 30000 },
];

describe('DonutCard', () => {
  it('renderiza a casca (título/subtítulo) e as fatias na legenda', () => {
    render(<DonutCard title="Despesas Fixas" subtitle="Por grupo · Janeiro" slices={SLICES} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Despesas Fixas' })).toBeInTheDocument();
    expect(screen.getByText('Por grupo · Janeiro')).toBeInTheDocument();
    expect(screen.getByText('Folha de Pagamento')).toBeInTheDocument();
    expect(screen.getByText('Transporte')).toBeInTheDocument();
  });

  // `slices` chega undefined enquanto carrega (e quando o read falha) — não pode quebrar.
  it('trata slices ausente/vazio como donut vazio', () => {
    const { rerender } = render(<DonutCard title="T" subtitle="S" slices={undefined} />);
    expect(screen.getByText('Sem contas no período.')).toBeInTheDocument();
    rerender(<DonutCard title="T" subtitle="S" slices={[]} />);
    expect(screen.getByText('Sem contas no período.')).toBeInTheDocument();
  });

  it('usa a paleta cíclica por padrão e respeita colorFor quando informado', () => {
    const colorFor = vi.fn(() => 'rgb(1, 2, 3)');
    render(<DonutCard title="T" subtitle="S" slices={SLICES} colorFor={colorFor} />);
    expect(colorFor).toHaveBeenCalledWith('Transporte', 0); // ordenado por VALOR desc
    expect(colorFor).toHaveBeenCalledWith('Folha de Pagamento', 1);
  });
});
