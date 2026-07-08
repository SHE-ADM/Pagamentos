import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AttachmentViewer from './AttachmentViewer';

// Mock do client Supabase — só a API de Storage usada pelo viewer.
const { createSignedUrl } = vi.hoisted(() => ({ createSignedUrl: vi.fn() }));
vi.mock('../lib/supabaseClient', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl }) } },
}));

describe('AttachmentViewer', () => {
  beforeEach(() => {
    createSignedUrl.mockReset();
  });

  it('renderiza o iframe com a URL assinada quando o anexo existe', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://sb/sign/boleto.pdf?token=x' }, error: null });
    const { container } = render(<AttachmentViewer sourceFile="boleto X.pdf" onClose={vi.fn()} />);

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('https://sb/sign/boleto.pdf?token=x');
    // S5-1: o PDF hostil é confinado por sandbox — sem allow-scripts (JS não roda) nem
    // allow-top-navigation (não redireciona o app). Trava a regressão do achado.
    const sandbox = iframe?.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-top-navigation');
  });

  it('chama onClose ao clicar no botão fechar', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://sb/sign/a.pdf?token=x' }, error: null });
    const onClose = vi.fn();
    const { container } = render(<AttachmentViewer sourceFile="a.pdf" onClose={onClose} />);

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    fireEvent.click(screen.getByTitle('Fechar'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mostra mensagem quando o anexo não existe no Storage', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    render(<AttachmentViewer sourceFile="sumiu.pdf" onClose={vi.fn()} />);

    expect(await screen.findByText(/não encontrado no Storage/i)).toBeInTheDocument();
  });
});
