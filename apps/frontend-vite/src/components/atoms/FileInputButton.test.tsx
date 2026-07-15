import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FileInputButton from './FileInputButton';

const pdf = (name = 'boleto.pdf') => new File(['x'], name, { type: 'application/pdf' });

describe('FileInputButton', () => {
  it('renderiza um input file REAL com nome acessível (foco/teclado nativos)', () => {
    render(<FileInputButton accept="application/pdf" onFiles={vi.fn()} />);
    const input = screen.getByLabelText('Anexar arquivos');
    expect(input).toHaveAttribute('type', 'file');
  });

  it('repassa os arquivos escolhidos', async () => {
    const onFiles = vi.fn();
    render(<FileInputButton accept="application/pdf" onFiles={onFiles} />);
    await userEvent.upload(screen.getByLabelText('Anexar arquivos'), pdf());
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect((onFiles.mock.calls[0][0] as File[])[0].name).toBe('boleto.pdf');
  });

  it('aceita múltiplos arquivos de uma vez', async () => {
    const onFiles = vi.fn();
    render(<FileInputButton accept="application/pdf" onFiles={onFiles} />);
    await userEvent.upload(screen.getByLabelText('Anexar arquivos'), [pdf('a.pdf'), pdf('b.pdf')]);
    expect((onFiles.mock.calls[0][0] as File[]).map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('passa o accept adiante (filtro do diálogo do SO)', () => {
    render(<FileInputButton accept="application/pdf,image/png" onFiles={vi.fn()} />);
    expect(screen.getByLabelText('Anexar arquivos')).toHaveAttribute('accept', 'application/pdf,image/png');
  });

  it('desabilitado não dispara onFiles', async () => {
    const onFiles = vi.fn();
    render(<FileInputButton accept="application/pdf" onFiles={onFiles} disabled />);
    const input = screen.getByLabelText('Anexar arquivos');
    expect(input).toBeDisabled();
    await userEvent.upload(input, pdf());
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('escolher O MESMO arquivo duas vezes dispara nas duas (o value é zerado)', async () => {
    const onFiles = vi.fn();
    render(<FileInputButton accept="application/pdf" onFiles={onFiles} />);
    const input = screen.getByLabelText('Anexar arquivos');
    await userEvent.upload(input, pdf());
    await userEvent.upload(input, pdf());
    // Sem zerar o value, o navegador não emitiria o 2º `change` (valor não mudou).
    expect(onFiles).toHaveBeenCalledTimes(2);
  });

  it('aceita rótulo customizado', () => {
    render(<FileInputButton accept="application/pdf" onFiles={vi.fn()} label="Adicionar anexos" />);
    expect(screen.getByLabelText('Adicionar anexos')).toBeInTheDocument();
  });
});
