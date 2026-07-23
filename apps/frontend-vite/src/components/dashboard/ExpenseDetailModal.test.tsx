// src/components/dashboard/ExpenseDetailModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExpenseDetailModal } from './ExpenseDetailModal';
import type { ExpenseDetailRow } from '../../services/supabase';

const mk = (id: number, amount: number, trade: string | null, legal: string | null, code: string, desc: string, due: string): ExpenseDetailRow => ({
  id, amount, status_id: 3, due_date: due, cost_center_id: 0,
  supplier: { trade_name: trade, legal_name: legal },
  cost_center: null,
  chart_account: { account_code: code, account_description: desc, group: null, subgroup: null },
});

const ROWS: ExpenseDetailRow[] = [
  mk(1, 300, 'ACME Ltda', null, '6.1.01', 'Salários', '2026-07-10'),
  mk(2, 100, null, 'Beta Comércio LTDA', '4.5.01', 'Fretes', '2026-07-05'),
];

describe('ExpenseDetailModal', () => {
  it('renderiza as 5 colunas (Situação por último) e as linhas (fornecedor com fallback legal_name)', () => {
    render(<ExpenseDetailModal open title="Centro de custo · Compras" rows={ROWS} onClose={vi.fn()} />);
    const headers = ['Fornecedor', 'Plano de conta', 'Vencimento', 'Valor', 'Situação'];
    for (const h of headers) {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    }
    const headerCells = screen.getAllByRole('columnheader').map((el) => el.textContent);
    expect(headerCells[headerCells.length - 1]).toBe('Situação'); // última coluna
    expect(screen.getByText('ACME Ltda')).toBeInTheDocument();
    expect(screen.getByText('Beta Comércio LTDA')).toBeInTheDocument(); // fallback legal_name
    expect(screen.getByText('6.1.01 — Salários')).toBeInTheDocument();
    expect(screen.getByText('10/07/2026')).toBeInTheDocument();
    expect(screen.getByText('R$ 300,00')).toBeInTheDocument();
    expect(screen.getAllByText('a vencer').length).toBeGreaterThan(0); // badge de situação (status_id 3)
  });

  it('cabeçalho traz o título e o rodapé de contagem + total', () => {
    render(<ExpenseDetailModal open title="Centro de custo · Compras" rows={ROWS} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Centro de custo · Compras' })).toBeInTheDocument();
    const footer = screen.getByText(/conta\(s\)/);
    expect(footer).toHaveTextContent('2 conta(s)');
    expect(footer).toHaveTextContent('R$ 400,00'); // 300 + 100
  });

  it('open=false não renderiza o conteúdo', () => {
    render(<ExpenseDetailModal open={false} title="Centro de custo · Compras" rows={ROWS} onClose={vi.fn()} />);
    expect(screen.queryByText('Centro de custo · Compras')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Fornecedor' })).toBeNull();
  });

  it('o botão Fechar chama onClose', async () => {
    const onClose = vi.fn();
    render(<ExpenseDetailModal open title="X" rows={ROWS} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ordena as linhas por vencimento ASCENDENTE (mais próximo primeiro)', () => {
    render(<ExpenseDetailModal open title="Centro de custo · Compras" rows={ROWS} onClose={vi.fn()} />);
    const rows = screen.getAllByRole('row').slice(1); // pula o header
    expect(rows[0]).toHaveTextContent('05/07/2026'); // id 2 vence antes
    expect(rows[1]).toHaveTextContent('10/07/2026'); // id 1 vence depois
  });

  it('linha sem vencimento vai para o fim da lista', () => {
    const rowsWithoutDue = [...ROWS, mk(3, 50, 'Sem Data Ltda', null, '9.9.99', 'Diversos', '')];
    rowsWithoutDue[2].due_date = null;
    render(<ExpenseDetailModal open title="X" rows={rowsWithoutDue} onClose={vi.fn()} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[2]).toHaveTextContent('Sem Data Ltda');
  });

  it('clique no backdrop (o próprio <dialog>) chama onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<ExpenseDetailModal open title="X" rows={ROWS} onClose={onClose} />);
    const dialog = container.querySelector('dialog');
    expect(dialog).not.toBeNull();
    fireEvent.click(dialog as HTMLDialogElement); // e.target === dialog → backdrop
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
