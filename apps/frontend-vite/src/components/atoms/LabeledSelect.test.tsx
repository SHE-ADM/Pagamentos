import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LabeledSelect from './LabeledSelect';

const options = [
  { value: 1, label: 'Um' },
  { value: 2, label: 'Dois' },
];

describe('LabeledSelect', () => {
  it('renderiza label, placeholder e opções', () => {
    render(<LabeledSelect label="Grupo" placeholder="Selecione…" options={options} />);
    expect(screen.getByLabelText('Grupo')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Selecione…' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Um' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Dois' })).toBeInTheDocument();
  });

  it('exibe a mensagem de erro e marca aria-invalid', () => {
    render(<LabeledSelect label="Grupo" options={options} error="Grupo é obrigatório" />);
    expect(screen.getByText('Grupo é obrigatório')).toBeInTheDocument();
    expect(screen.getByLabelText('Grupo')).toHaveAttribute('aria-invalid', 'true');
  });
});
