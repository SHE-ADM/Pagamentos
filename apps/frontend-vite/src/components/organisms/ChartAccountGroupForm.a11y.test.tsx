import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import type { SelectOption } from '../atoms/LabeledSelect';
import ChartAccountGroupForm from './ChartAccountGroupForm';

const typeGroupOptions: SelectOption[] = [
  { value: 0, label: 'Não informado' },
  { value: 1, label: 'Receitas' },
  { value: 2, label: 'Despesas' },
];

describe('ChartAccountGroupForm — acessibilidade (WCAG AA)', () => {
  it('modo create (com select de Natureza) não tem violações', async () => {
    const { container } = render(
      <ChartAccountGroupForm
        mode="create"
        typeGroupOptions={typeGroupOptions}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('modo edit (Natureza preenchida) não tem violações', async () => {
    const { container } = render(
      <ChartAccountGroupForm
        mode="edit"
        typeGroupOptions={typeGroupOptions}
        defaultValues={{
          chart_account_group_id: 2,
          group_code: '2',
          group_description: 'Receitas',
          group_type: 'R',
          type_group_id: 1,
          type_group: { type_group_id: 1, type_group_description: 'Receitas' },
        }}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
