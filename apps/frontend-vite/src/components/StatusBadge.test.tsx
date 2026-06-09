import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusBadge from './StatusBadge';

describe('StatusBadge', () => {
  it('renderiza o valor recebido', () => {
    render(<StatusBadge value="extracted" />);
    expect(screen.getByText('extracted')).toBeInTheDocument();
  });

  it('exibe travessão quando o valor é nulo', () => {
    render(<StatusBadge value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
