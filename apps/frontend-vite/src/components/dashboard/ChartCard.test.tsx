// src/components/dashboard/ChartCard.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Building2 } from 'lucide-react';
import { ChartCard } from './ChartCard';

describe('ChartCard', () => {
  it('renderiza título (h3), subtítulo e o conteúdo', () => {
    render(
      <ChartCard title="Ranking de contas" subtitle="Maiores valores no período">
        <p>conteúdo</p>
      </ChartCard>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Ranking de contas' })).toBeInTheDocument();
    expect(screen.getByText('Maiores valores no período')).toBeInTheDocument();
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
  });

  it('sem ícone não renderiza o selo; com ícone, renderiza', () => {
    const { container, rerender } = render(
      <ChartCard title="T" subtitle="S">
        <span />
      </ChartCard>,
    );
    expect(container.querySelector('svg')).toBeNull();

    rerender(
      <ChartCard title="T" subtitle="S" icon={Building2}>
        <span />
      </ChartCard>,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });

  // Classes literais completas: nome computado (`bg-${tone}`) não é gerado pelo JIT e o
  // card sairia sem estilo, em silêncio.
  it('aplica o tom do ícone e a densidade por classe literal', () => {
    const { container, rerender } = render(
      <ChartCard title="T" subtitle="S" icon={Building2} tone="danger" dense>
        <span />
      </ChartCard>,
    );
    expect(container.firstElementChild).toHaveClass('card', 'p-2.5');
    expect(container.querySelector('span')?.className).toContain('text-status-error-fg');

    rerender(
      <ChartCard title="T" subtitle="S" icon={Building2}>
        <span />
      </ChartCard>,
    );
    expect(container.firstElementChild).toHaveClass('card', 'p-3');
    expect(container.querySelector('span')?.className).toContain('text-brand');
  });

  it('acrescenta className sem perder as classes da moldura', () => {
    const { container } = render(
      <ChartCard title="T" subtitle="S" className="mb-3">
        <span />
      </ChartCard>,
    );
    expect(container.firstElementChild).toHaveClass('card', 'p-3', 'mb-3');
  });

  // Merge por tailwind-merge, não concatenação: com `+` sairia "p-3 p-4" e o vencedor
  // dependeria da ordem no CSS, não da intenção de quem chamou.
  it('deixa a classe do chamador VENCER a da variante no mesmo utilitário', () => {
    const { container } = render(
      <ChartCard title="T" subtitle="S" className="p-4">
        <span />
      </ChartCard>,
    );
    const frame = container.firstElementChild;
    expect(frame).toHaveClass('card', 'p-4');
    expect(frame).not.toHaveClass('p-3');
  });
});
