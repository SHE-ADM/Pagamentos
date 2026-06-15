import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import FilledTextField from './FilledTextField';

describe('FilledTextField — acessibilidade (WCAG AA)', () => {
  it('campo com label associado não tem violações', async () => {
    const { container } = render(<FilledTextField label="Usuário" placeholder="usuario123" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
