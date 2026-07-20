import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import ChartAccountSubgroupForm from './ChartAccountSubgroupForm';

const groupOptions = [
  { value: 1, label: '1 — Ativo' },
  { value: 2, label: '2 — Passivo' },
];
const typeGroupOptions = [
  { value: 0, label: 'Não informado' },
  { value: 5, label: 'Despesas Fixas' },
  { value: 6, label: 'Despesas Variáveis' },
];

describe('ChartAccountSubgroupForm — acessibilidade (WCAG AA)', () => {
  it('modo create (todos os selects, sem valor) não tem violações', async () => {
    const { container } = render(
      <ChartAccountSubgroupForm
        mode="create"
        groupOptions={groupOptions}
        typeGroupOptions={typeGroupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('modo edit (com Grupo e Tipo preenchidos) não tem violações', async () => {
    const { container } = render(
      <ChartAccountSubgroupForm
        mode="edit"
        groupOptions={groupOptions}
        typeGroupOptions={typeGroupOptions}
        defaultValues={{
          chart_account_subgroup_id: 62,
          chart_account_group_id: 1,
          subgroup_code: '62.1',
          subgroup_description: 'Salários',
          type_group_id: 5,
          type_group: { type_group_id: 5, type_group_description: 'Despesas Fixas' },
        }}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
