import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import CheckToggle from './CheckToggle';

describe('CheckToggle — acessibilidade (WCAG AA)', () => {
  it('checkbox com nome acessível não tem violações', async () => {
    const { container } = render(
      <CheckToggle checked={false} onToggle={vi.fn()} ariaLabel="Tem NF" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
