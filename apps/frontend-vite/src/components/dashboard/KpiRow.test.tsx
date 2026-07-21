// src/components/dashboard/KpiRow.test.tsx
// A faixa de KPIs concentra a regra de "quem fica ativo" — que antes era repetida nas
// duas páginas. O caso que não pode regredir: o KPI 'total' representa a AUSÊNCIA de
// filtro, então NUNCA aparece selecionado (nem quando `filter === 'total'`).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileText, CheckCircle2, Clock } from 'lucide-react';
import { KpiRow, type KpiEntry } from './KpiRow';

const ITEMS: KpiEntry[] = [
  { icon: FileText, label: 'Total', amount: 100, count: 9, tone: 'neutral', filter: 'total' },
  { icon: CheckCircle2, label: 'Pagas', amount: 40, count: 4, tone: 'success', filter: 'pago' },
  { icon: Clock, label: 'A vencer', amount: 60, count: 5, tone: 'muted', filter: 'aVencer' },
];

const cards = (): HTMLElement[] => screen.getAllByRole('button');

describe('KpiRow', () => {
  it('renderiza um card por item', () => {
    render(<KpiRow items={ITEMS} filter="total" onToggle={vi.fn()} />);
    expect(cards()).toHaveLength(3);
  });

  it('o KPI "total" NUNCA fica ativo — ele é a ausência de filtro', () => {
    render(<KpiRow items={ITEMS} filter="total" onToggle={vi.fn()} />);
    expect(cards().filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  });

  it('marca só o card cujo filtro está em vigor', () => {
    render(<KpiRow items={ITEMS} filter="aVencer" onToggle={vi.fn()} />);
    const ativos = cards().filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(ativos).toHaveLength(1);
    expect(ativos[0].textContent).toContain('A vencer');
  });

  it('clicar devolve o filtro do card', () => {
    const onToggle = vi.fn();
    render(<KpiRow items={ITEMS} filter="total" onToggle={onToggle} />);
    fireEvent.click(cards()[1]);
    expect(onToggle).toHaveBeenCalledWith('pago');
  });
});
