import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import AttachmentPicker from './AttachmentPicker';

const file = (name: string, type = 'application/pdf'): File =>
  new File(['x'], name, { type, lastModified: 1_700_000_000_000 });

describe('AttachmentPicker — acessibilidade (WCAG AA)', () => {
  it('vazio não tem violações', async () => {
    const { container } = render(<AttachmentPicker value={[]} onChange={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('com fila não tem violações (nome acessível nos botões de remover)', async () => {
    const { container } = render(<AttachmentPicker value={[file('boleto.pdf')]} onChange={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('erro de validação é anunciado (role=alert) e não tem violações', async () => {
    const { container } = render(<AttachmentPicker value={[]} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Anexar arquivos'), { target: { files: [file('x.txt', 'text/plain')] } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
