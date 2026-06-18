import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import SelectCheckbox from './SelectCheckbox';

describe('SelectCheckbox — acessibilidade (WCAG AA)', () => {
  it('não tem violações (nome acessível via aria-label)', async () => {
    const { container } = render(
      <SelectCheckbox checked={false} onToggle={vi.fn()} ariaLabel="Selecionar linha" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
