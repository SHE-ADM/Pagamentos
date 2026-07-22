// src/components/dashboard/BreakdownDonut.test.tsx
// Trava o contrato do donut compartilhado: ordenação por VALOR, % sobre o valor e o
// mapeamento de `size` → classes LITERAIS do círculo/furo (Tailwind JIT não gera CSS
// para nome de classe computado, então a regressão seria silenciosa: o donut renderiza,
// só que sem tamanho).
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BreakdownDonut } from './BreakdownDonut';

const SEGS = [
  { key: 'a', label: 'Despesas Fixas', value: 100 },
  { key: 'b', label: 'Despesas Variáveis', value: 300 },
];
const color = (_label: string, i: number): string => (i === 0 ? '#111111' : '#222222');

// O círculo é o único elemento com largura fixa em px — serve de âncora para o tamanho.
const circleOf = (c: HTMLElement): Element | null => c.querySelector('[class*="w-["]');

describe('BreakdownDonut', () => {
  it('ordena as fatias por VALOR desc e calcula a % sobre o total', () => {
    render(<BreakdownDonut segs={SEGS} colorFor={color} />);
    const labels = screen.getAllByText(/Despesas (Fixas|Variáveis)/).map((el) => el.textContent);
    expect(labels).toEqual(['Despesas Variáveis', 'Despesas Fixas']); // 300 antes de 100
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('usa o círculo médio (120px) por padrão', () => {
    const { container } = render(<BreakdownDonut segs={SEGS} colorFor={color} />);
    expect(circleOf(container)?.className).toContain('w-[120px]');
  });

  it('size="sm" reduz o círculo (4 donuts na mesma linha em /dashboard_vencimentos)', () => {
    const { container } = render(<BreakdownDonut segs={SEGS} colorFor={color} size="sm" />);
    expect(circleOf(container)?.className).toContain('w-[108px]');
    expect(container.querySelector('.inset-3')).not.toBeNull();
  });

  it('size="lg" aumenta o círculo E o furo (anel proporcional) — /dashboard_despesas', () => {
    const { container } = render(<BreakdownDonut segs={SEGS} colorFor={color} size="lg" />);
    expect(circleOf(container)?.className).toContain('w-[176px]');
    // Furo maior junto com o diâmetro: com inset-3 o anel ficaria fino demais no lg.
    expect(container.querySelector('.inset-5')).not.toBeNull();
    expect(container.querySelector('.inset-3')).toBeNull();
  });

  it('sem fatias, não quebra na divisão por zero e mostra o vazio', () => {
    render(<BreakdownDonut segs={[]} colorFor={color} />);
    expect(screen.getByText('Sem contas no período.')).toBeInTheDocument();
  });

  it('sem onSelect, as fatias NÃO são botões (não-interativas — regressão dos call sites de vencimentos)', () => {
    render(<BreakdownDonut segs={SEGS} colorFor={color} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('com onSelect, cada fatia vira <button> e o clique devolve o seg', async () => {
    const onSelect = vi.fn();
    render(<BreakdownDonut segs={SEGS} colorFor={color} onSelect={onSelect} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: /Despesas Variáveis/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ label: 'Despesas Variáveis', value: 300 }));
  });
});
