import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import SearchInput from './SearchInput';

describe('SearchInput a11y', () => {
  it('não tem violações (com o botão de limpar visível)', async () => {
    const { container } = render(
      <SearchInput id="q" ariaLabel="Buscar" placeholder="Buscar…" value="abc" onChange={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
