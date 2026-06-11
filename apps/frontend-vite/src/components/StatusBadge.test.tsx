import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusBadge from './StatusBadge';

describe('StatusBadge', () => {
  it('renderiza o valor recebido', () => {
    render(<StatusBadge value="extraído" />);
    expect(screen.getByText('extraído')).toBeInTheDocument();
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
    const { container } = render(<StatusBadge value="pendente" />);
    expect(screen.getByText('pendente')).toBeInTheDocument();
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

  it('mapeia "vencido" para a variante vermelha', () => {
    render(<StatusBadge value="vencido" />);
    expect(screen.getByText('vencido').className).toContain('text-red-600');
  });

  it('mapeia "pago" para a variante esmeralda', () => {
    render(<StatusBadge value="pago" />);
    expect(screen.getByText('pago').className).toContain('text-emerald-700');
  });

  it('mapeia "erro_api" para vermelho sólido (distinto do erro comum)', () => {
    render(<StatusBadge value="erro_api" />);
    const badge = screen.getByText('erro_api');
    // vermelho sólido: fundo cheio + texto branco — destaca de extracao_falhou (red suave)
    expect(badge.className).toContain('bg-red-600');
    expect(badge.className).toContain('text-white');
  });

  it('"extracao_falhou" usa vermelho suave — diferente do erro_api sólido', () => {
    render(<StatusBadge value="extracao_falhou" />);
    const badge = screen.getByText('extracao_falhou');
    expect(badge.className).toContain('text-red-600');
    expect(badge.className).not.toContain('bg-red-600');
  });
});
