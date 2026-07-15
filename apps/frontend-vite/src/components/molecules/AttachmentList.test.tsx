import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AttachmentList, { type AttachmentListItem } from './AttachmentList';

const item = (over: Partial<AttachmentListItem> = {}): AttachmentListItem => ({
  id: 1,
  name: 'boleto.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  ...over,
});

describe('AttachmentList', () => {
  it('lista os itens com nome e tamanho legível', () => {
    render(<AttachmentList items={[item(), item({ id: 2, name: 'nota.pdf', sizeBytes: 1048576 })]} />);
    expect(screen.getByText('boleto.pdf')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.getByText('1 MB')).toBeInTheDocument();
  });

  it('exibe o texto de vazio quando não há itens', () => {
    render(<AttachmentList items={[]} emptyText="Nenhum anexo nesta conta." />);
    expect(screen.getByText('Nenhum anexo nesta conta.')).toBeInTheDocument();
  });

  it('chama onView com o item', async () => {
    const onView = vi.fn();
    render(<AttachmentList items={[item()]} onView={onView} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver boleto.pdf' }));
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('chama onRemove com o item', async () => {
    const onRemove = vi.fn();
    render(<AttachmentList items={[item()]} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover boleto.pdf' }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('anexo de E-MAIL: mostra o selo e NÃO oferece remover (trilha de auditoria)', () => {
    render(<AttachmentList items={[item({ fromEmail: true })]} onRemove={vi.fn()} />);
    expect(screen.getByText('e-mail')).toBeInTheDocument();
    // Mesmo com onRemove passado, o anexo do e-mail não tem lixeira.
    expect(screen.queryByRole('button', { name: 'Remover boleto.pdf' })).not.toBeInTheDocument();
  });

  it('sem onRemove não há lixeira em anexo nenhum', () => {
    render(<AttachmentList items={[item()]} onView={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Remover/ })).not.toBeInTheDocument();
  });

  it('busy desabilita a remoção', () => {
    render(<AttachmentList items={[item()]} onRemove={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: 'Remover boleto.pdf' })).toBeDisabled();
  });
});
