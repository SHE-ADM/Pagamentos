import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import LabeledSelect from './LabeledSelect';

describe('LabeledSelect a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(
      <LabeledSelect
        label="Grupo"
        placeholder="Selecione…"
        options={[
          { value: 1, label: 'Um' },
          { value: 2, label: 'Dois' },
        ]}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
