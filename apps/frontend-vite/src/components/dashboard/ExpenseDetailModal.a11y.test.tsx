// src/components/dashboard/ExpenseDetailModal.a11y.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import { ExpenseDetailModal } from './ExpenseDetailModal';
import type { ExpenseDetailRow } from '../../services/supabase';

const ROWS: ExpenseDetailRow[] = [
  {
    id: 1, amount: 300, status_id: 3, due_date: '2026-07-10',
    supplier: { trade_name: 'ACME Ltda', legal_name: null },
    chart_account: { account_code: '6.1.01', account_description: 'Salários', group: null, subgroup: null },
  },
];

describe('ExpenseDetailModal a11y', () => {
  it('sem violações com o modal aberto (dialog com nome acessível via aria-labelledby)', async () => {
    const { container } = render(
      <ExpenseDetailModal open title="Conta · Fretes" rows={ROWS} onClose={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
