import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExpandableText from './ExpandableText';

const longText = ['linha 1', 'linha 2', 'linha 3', 'linha 4', 'linha 5'].join('\n');

describe('ExpandableText', () => {
  it('não renderiza nada quando o texto é vazio', () => {
    const { container } = render(<ExpandableText text={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('alterna entre "ver mais" e "ver menos"', async () => {
    const user = userEvent.setup();
    render(<ExpandableText text={longText} previewLines={3} />);

    const toggle = screen.getByRole('button', { name: 'ver mais' });
    expect(toggle).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'ver menos' })).toBeInTheDocument();
    expect(screen.getByText(/linha 5/)).toBeInTheDocument();
  });
});
