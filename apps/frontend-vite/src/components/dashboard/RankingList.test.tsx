// src/components/dashboard/RankingList.test.tsx
// Ranking horizontal compartilhado (fornecedores | centros de custo | plano de contas).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('sem onSelect, as linhas NÃO são botões (não-interativas — regressão de vencimentos)', () => {
    render(<RankingList rows={ROWS} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('com onSelect, cada linha vira <button> e o clique devolve a row (com a key do balde)', async () => {
    const onSelect = vi.fn();
    const rows = [
      { key: 'cc:1', name: 'Compras', value: 1500, count: 12 },
      { key: 'cc:4', name: 'Logística', value: 500, count: 4 },
    ];
    render(<RankingList rows={rows} onSelect={onSelect} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: /Compras/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'cc:1', name: 'Compras' }));
  });

  it('com `pct`, a célula da direita mostra o percentual arredondado — não mais "N conta(s)" (rankings de /dashboard_despesas)', () => {
    render(
      <RankingList
        rows={[
          { name: 'Serviços Gerais', value: 20000, count: 2, pct: 33.333 },
          { name: 'Compras', value: 500, count: 1, pct: 8 },
        ]}
      />,
    );
    expect(screen.getByText('33%')).toBeInTheDocument();
    expect(screen.getByText('8%')).toBeInTheDocument();
    expect(screen.queryByText(/conta\(s\)/)).toBeNull();
  });

  it('sem `pct`, mantém "N conta(s)" (ranking de fornecedores de /dashboard_vencimentos, inalterado)', () => {
    render(<RankingList rows={ROWS} />);
    expect(screen.getByText('12 conta(s)')).toBeInTheDocument();
    expect(screen.getByText('4 conta(s)')).toBeInTheDocument();
  });

  it('`dense` reduz a altura da linha (padding vertical zerado) sem remover nenhuma informação', () => {
    const { container: normal } = render(<RankingList rows={ROWS} />);
    const { container: compact } = render(<RankingList rows={ROWS} dense />);
    // A linha em modo dense usa py-0 (sem padding vertical) — a normal usa py-0.5.
    expect(normal.querySelector('.py-0\\.5')).not.toBeNull();
    expect(compact.querySelector('.py-0\\.5')).toBeNull();
    expect(compact.querySelector('.py-0')).not.toBeNull();
    // Conteúdo (nome/valor/contagem) continua todo presente, só mais compacto.
    const dense = within(compact);
    expect(dense.getByText('Compras')).toBeInTheDocument();
    expect(dense.getByText('R$ 1.500,00')).toBeInTheDocument();
    expect(dense.getByText('12 conta(s)')).toBeInTheDocument();
  });
});
