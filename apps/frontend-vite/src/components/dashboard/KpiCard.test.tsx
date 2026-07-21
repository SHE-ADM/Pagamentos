// src/components/dashboard/KpiCard.test.tsx
// Trava o contrato do card de KPI clicável (compartilhado pelos dois dashboards).
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Clock } from 'lucide-react';
import { KpiCard } from './KpiCard';

const base = { icon: Clock, label: 'A vencer', amount: 1234.5, count: 7, tone: 'muted' as const };

describe('KpiCard', () => {
  it('renderiza valor, contagem e rótulo', () => {
    render(<KpiCard {...base} active={false} onClick={vi.fn()} />);
    expect(screen.getByText('R$ 1.234,50')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('A vencer')).toBeInTheDocument();
  });

  it('inativo: sem selo, aria-pressed=false e título convida a filtrar', () => {
    render(<KpiCard {...base} active={false} onClick={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAttribute('title', 'Filtrar por A vencer');
    expect(screen.queryByText('filtrando')).not.toBeInTheDocument();
  });

  it('ativo: anel de destaque + selo textual (WCAG 1.4.1 — não só cor) + título de limpar', () => {
    render(<KpiCard {...base} active onClick={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('title', 'Limpar filtro');
    expect(screen.getByText('filtrando')).toBeInTheDocument();
    // Anel do estado ativo — distinto do `focus-visible:ring-2`, que existe em qualquer estado.
    expect(btn.className).toContain('ring-brand');
    expect(btn.className).toContain('ring-offset-1');
  });

  it('mantém a affordance de clique (hover) em qualquer estado', () => {
    const { rerender } = render(<KpiCard {...base} active={false} onClick={vi.fn()} />);
    const cls = (): string => screen.getByRole('button').className;
    expect(cls()).toContain('cursor-pointer');
    expect(cls()).toContain('hover:bg-slate-50');
    expect(cls()).toContain('hover:-translate-y-0.5');
    rerender(<KpiCard {...base} active onClick={vi.fn()} />);
    // O hover NÃO pode mexer no ring: competiria com o anel do ativo na mesma variável
    // (--tw-ring-width) e apagaria o destaque ao passar o mouse.
    expect(cls()).not.toContain('hover:ring');
  });

  it('o anel de FOCO difere do anel de ATIVO (WCAG 2.4.7)', () => {
    render(<KpiCard {...base} active onClick={vi.fn()} />);
    const cls = screen.getByRole('button').className;
    // Ativo: cor de marca, halo 1. Foco: cor mais escura, halo 2 — com os dois iguais,
    // chegar por teclado ao card já selecionado não mudaria NADA na tela.
    expect(cls).toContain('ring-brand');
    expect(cls).toContain('focus-visible:ring-brand-dark');
    expect(cls).toContain('focus-visible:ring-offset-2');
    // Halo não pode depender do default do Tailwind para a cor do fundo.
    expect(cls).toContain('ring-offset-white');
  });

  it('respeita prefers-reduced-motion (desliga o movimento do hover)', () => {
    render(<KpiCard {...base} active={false} onClick={vi.fn()} />);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('motion-reduce:transition-none');
    expect(cls).toContain('motion-reduce:hover:translate-y-0');
  });

  it('formata a contagem em pt-BR (milhar com ponto)', () => {
    render(<KpiCard {...base} count={1234} active={false} onClick={vi.fn()} />);
    expect(screen.getByText('1.234')).toBeInTheDocument();
  });

  it('dispara onClick', async () => {
    const onClick = vi.fn();
    render(<KpiCard {...base} active={false} onClick={onClick} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('cada tom pinta a barra lateral e o ícone de forma distinta', () => {
    const { rerender } = render(<KpiCard {...base} tone="danger" active={false} onClick={vi.fn()} />);
    expect(screen.getByRole('button').className).toContain('border-l-status-error-solid');
    rerender(<KpiCard {...base} tone="success" active={false} onClick={vi.fn()} />);
    expect(screen.getByRole('button').className).toContain('border-l-status-success-fg');
  });
});
