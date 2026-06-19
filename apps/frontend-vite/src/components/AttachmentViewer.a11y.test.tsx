import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { axe } from '../../tests/axe';

// Mocka o client Supabase Storage — controla view/notfound sem rede real.
const createSignedUrl = vi.fn();
vi.mock('../lib/supabaseClient', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl: (...a: unknown[]) => createSignedUrl(...a) }) } },
}));

import AttachmentViewer from './AttachmentViewer';

describe('AttachmentViewer — acessibilidade (WCAG AA)', () => {
  beforeEach(() => createSignedUrl.mockReset());

  // O axe em jsdom não consegue varrer DENTRO de um <iframe> (limitação de
  // postMessage cross-frame). O requisito WCAG do iframe é ter nome acessível
  // (title — 4.1.2/2.4.1), verificado aqui direto no DOM. A varredura axe
  // completa do chrome do modal fica no estado "notfound" (sem iframe).
  it('estado "ok": o iframe do PDF tem título acessível', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://example.test/doc.pdf' }, error: null });
    const { container } = render(<AttachmentViewer sourceFile="nota.pdf" onClose={vi.fn()} />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(container.querySelector('iframe')?.getAttribute('title')).toBe('nota.pdf');
  });

  it('estado "notfound" (anexo ausente) não tem violações', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const { container, findByText } = render(<AttachmentViewer sourceFile="sumiu.pdf" onClose={vi.fn()} />);
    await findByText(/Anexo não encontrado/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  // O modal usa <dialog> nativo (role dialog + aria-modal implícitos). Garante o
  // nome acessível: aria-labelledby deve apontar para o título com o nome do arquivo.
  it('o <dialog> tem nome acessível ligado ao nome do arquivo', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const { container, findByText } = render(<AttachmentViewer sourceFile="contrato.pdf" onClose={vi.fn()} />);
    await findByText(/Anexo não encontrado/i);
    const dialog = container.querySelector('dialog');
    const labelId = dialog?.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(container.querySelector(`#${CSS.escape(labelId ?? '')}`)?.textContent).toBe('contrato.pdf');
  });
});
