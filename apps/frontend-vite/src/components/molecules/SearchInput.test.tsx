import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SearchInput from './SearchInput';

const baseProps = {
  id: 'q',
  ariaLabel: 'Buscar',
  placeholder: 'Buscar…',
  onChange: vi.fn(),
};

describe('SearchInput', () => {
  it('renderiza o input pelo nome acessível', () => {
    render(<SearchInput {...baseProps} value="" />);
    expect(screen.getByLabelText('Buscar')).toBeInTheDocument();
  });

  it('NÃO mostra o botão de limpar quando vazio', () => {
    render(<SearchInput {...baseProps} value="" />);
    expect(screen.queryByRole('button', { name: 'Limpar busca' })).not.toBeInTheDocument();
  });

  it('mostra o botão de limpar quando há texto', () => {
    render(<SearchInput {...baseProps} value="abc" />);
    expect(screen.getByRole('button', { name: 'Limpar busca' })).toBeInTheDocument();
  });

  it('chama onChange("") ao clicar em limpar', async () => {
    const onChange = vi.fn();
    render(<SearchInput {...baseProps} onChange={onChange} value="abc" />);
    await userEvent.click(screen.getByRole('button', { name: 'Limpar busca' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('propaga a digitação via onChange', async () => {
    const onChange = vi.fn();
    render(<SearchInput {...baseProps} onChange={onChange} value="" />);
    await userEvent.type(screen.getByLabelText('Buscar'), 'x');
    expect(onChange).toHaveBeenCalledWith('x');
  });
});
