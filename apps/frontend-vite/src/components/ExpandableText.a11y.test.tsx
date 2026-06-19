import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../tests/axe';
import ExpandableText from './ExpandableText';

const LONG = Array.from({ length: 8 }, (_, i) => `linha ${i + 1} do corpo do e-mail`).join('\n');

describe('ExpandableText — acessibilidade (WCAG AA)', () => {
  it('texto curto não tem violações', async () => {
    const { container } = render(<ExpandableText text="trecho curto" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('texto longo (com botão ver mais) não tem violações', async () => {
    const { container } = render(<ExpandableText text={LONG} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
