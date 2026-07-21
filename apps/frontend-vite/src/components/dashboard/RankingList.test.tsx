// src/components/dashboard/RankingList.test.tsx
// Ranking horizontal compartilhado (fornecedores | centros de custo | plano de contas).
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RankingList } from './RankingList';

const ROWS = [
  { name: 'Compras', value: 1500, count: 12 },
  { name: 'Logística', value: 500, count: 4 },
];

describe('RankingList', () => {
  it('lista os itens com valor e contagem, na ordem recebida', () => {
    render(<RankingList rows={ROWS} />);
    expect(screen.getByText('Compras')).toBeInTheDocument();
    expect(screen.getByText('R$ 1.500,00')).toBeInTheDocument();
    expect(screen.getByText('12 conta(s)')).toBeInTheDocument();
    // A posição vem do serviço (já ordenado por valor) — o componente não reordena.
    const nomes = screen.getAllByText(/Compras|Logística/).map((el) => el.textContent);
    expect(nomes).toEqual(['Compras', 'Logística']);
  });

  it('estado vazio', () => {
    render(<RankingList rows={[]} />);
    expect(screen.getByText('Sem contas no período.')).toBeInTheDocument();
  });

  it('aceita nomes REPETIDOS sem colidir (key não pode ser só o nome)', () => {
    // Cenário real possível: dois cadastros homônimos (não há UNIQUE em descrição) ou dois
    // fornecedores de mesmo trade_name. Antes, a key duplicada fazia o React descartar a
    // 2ª linha — o valor sumia da tela sem erro visível.
    render(<RankingList rows={[{ name: 'Administrativo', value: 300, count: 2 }, { name: 'Administrativo', value: 100, count: 1 }]} />);
    expect(screen.getAllByText('Administrativo')).toHaveLength(2);
    expect(screen.getByText('R$ 300,00')).toBeInTheDocument();
    expect(screen.getByText('R$ 100,00')).toBeInTheDocument();
  });
});
