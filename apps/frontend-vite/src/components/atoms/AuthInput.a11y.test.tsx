import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import AuthInput from './AuthInput';

describe('AuthInput — acessibilidade (WCAG AA)', () => {
  it('campo válido não tem violações', async () => {
    const { container } = render(<AuthInput label="E-mail" type="email" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('campo com erro não tem violações', async () => {
    const { container } = render(<AuthInput label="E-mail" type="email" error="E-mail inválido" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
