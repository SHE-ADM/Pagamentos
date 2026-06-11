import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusBadge from './StatusBadge';

describe('StatusBadge', () => {
  it('renderiza o valor recebido', () => {
    render(<StatusBadge value="extracted" />);
    expect(screen.getByText('extracted')).toBeInTheDocument();
  });

  it('exibe travessão quando o valor é nulo', () => {
    render(<StatusBadge value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('valor não mapeado recebe badge neutro (sem ícone nem ponto)', () => {
    // Ex.: keyword de assunto ("nota fiscal", "transporte") — preservada como badge.
    const { container } = render(<StatusBadge value="nota fiscal" />);
    expect(screen.getByText('nota fiscal')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('span.rounded-full')).toBeNull();
  });

  it('status recebe ponto colorido à esquerda (sem ícone)', () => {
    const { container } = render(<StatusBadge value="pending" />);
    expect(screen.getByText('pending')).toBeInTheDocument();
    // ponto = span arredondado com bg-current; nenhum ícone svg
    expect(container.querySelector('span.rounded-full')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('tipo de documento recebe ícone de documento', () => {
    const { container } = render(<StatusBadge value="boleto" />);
    expect(screen.getByText('boleto')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('origem da extração usa variante teal com ícone de origem', () => {
    const { container } = render(<StatusBadge value="email_body" />);
    expect(screen.getByText('email_body')).toBeInTheDocument();
    const badge = screen.getByText('email_body');
    expect(badge.className).toContain('text-teal-700');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('mapeia "Vencido" para a variante vermelha', () => {
    render(<StatusBadge value="Vencido" />);
    expect(screen.getByText('Vencido').className).toContain('text-red-600');
  });
});
