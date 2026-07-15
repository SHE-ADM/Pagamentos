import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ATTACHMENT_MAX_BYTES } from '@sheild/shared';
import AttachmentPicker from './AttachmentPicker';

// `lastModified` fixo: entra na chave de identidade do arquivo (name:size:lastModified),
// e dois `new File` criados em milissegundos diferentes não seriam vistos como o mesmo.
const file = (name: string, type = 'application/pdf', size = 1024): File => {
  const f = new File(['x'], name, { type, lastModified: 1_700_000_000_000 });
  // O File do jsdom deriva o size do conteúdo; sobrescreve para testar o limite sem
  // alocar 10 MB de verdade.
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

// O userEvent.upload RESPEITA o `accept` do input e descarta o arquivo antes de o
// componente vê-lo (bom: prova que o accept está certo). Para exercitar a VALIDAÇÃO —
// que é a defesa real, já que `accept` é só um filtro de diálogo e não vale para
// arrastar-e-soltar — o evento é disparado direto.
const uploadIgnoringAccept = (input: HTMLElement, files: File[]) => {
  fireEvent.change(input, { target: { files } });
};

describe('AttachmentPicker', () => {
  it('adiciona o arquivo escolhido à fila', async () => {
    const onChange = vi.fn();
    render(<AttachmentPicker value={[]} onChange={onChange} />);
    await userEvent.upload(screen.getByLabelText('Anexar arquivos'), file('boleto.pdf'));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ name: 'boleto.pdf' })]);
  });

  it('acumula com a fila que já existe (não substitui)', async () => {
    const onChange = vi.fn();
    const existente = file('a.pdf');
    render(<AttachmentPicker value={[existente]} onChange={onChange} />);
    await userEvent.upload(screen.getByLabelText('Anexar arquivos'), file('b.pdf'));
    expect((onChange.mock.calls[0][0] as File[]).map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('lista os arquivos da fila', () => {
    render(<AttachmentPicker value={[file('boleto.pdf')]} onChange={vi.fn()} />);
    expect(screen.getByText('boleto.pdf')).toBeInTheDocument();
  });

  it('remove um arquivo da fila', async () => {
    const onChange = vi.fn();
    render(<AttachmentPicker value={[file('a.pdf'), file('b.pdf')]} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover a.pdf' }));
    expect((onChange.mock.calls[0][0] as File[]).map((f) => f.name)).toEqual(['b.pdf']);
  });

  it('rejeita tipo não permitido com mensagem em pt-BR', () => {
    const onChange = vi.fn();
    render(<AttachmentPicker value={[]} onChange={onChange} />);
    uploadIgnoringAccept(screen.getByLabelText('Anexar arquivos'), [file('script.txt', 'text/plain')]);
    expect(screen.getByRole('alert')).toHaveTextContent(/tipo não permitido/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('o input declara accept só com os tipos permitidos', () => {
    render(<AttachmentPicker value={[]} onChange={vi.fn()} />);
    const accept = screen.getByLabelText('Anexar arquivos').getAttribute('accept');
    expect(accept).toContain('application/pdf');
    expect(accept).toContain('image/png');
    expect(accept).not.toContain('text/plain');
  });

  it('rejeita arquivo acima do limite, citando o tamanho', async () => {
    const onChange = vi.fn();
    render(<AttachmentPicker value={[]} onChange={onChange} />);
    await userEvent.upload(
      screen.getByLabelText('Anexar arquivos'),
      file('grande.pdf', 'application/pdf', ATTACHMENT_MAX_BYTES + 1),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/excede o limite/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejeita arquivo vazio', async () => {
    const onChange = vi.fn();
    render(<AttachmentPicker value={[]} onChange={onChange} />);
    await userEvent.upload(screen.getByLabelText('Anexar arquivos'), file('vazio.pdf', 'application/pdf', 0));
    expect(screen.getByRole('alert')).toHaveTextContent(/vazio/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejeita o MESMO arquivo já na fila (duplicata)', async () => {
    const onChange = vi.fn();
    const f = file('boleto.pdf');
    render(<AttachmentPicker value={[f]} onChange={onChange} />);
    await userEvent.upload(screen.getByLabelText('Anexar arquivos'), file('boleto.pdf'));
    expect(screen.getByRole('alert')).toHaveTextContent(/já está na lista/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('numa seleção mista, aceita os válidos e reporta só os rejeitados', () => {
    const onChange = vi.fn();
    render(<AttachmentPicker value={[]} onChange={onChange} />);
    uploadIgnoringAccept(screen.getByLabelText('Anexar arquivos'), [
      file('ok.pdf'),
      file('ruim.txt', 'text/plain'),
    ]);
    expect((onChange.mock.calls[0][0] as File[]).map((f) => f.name)).toEqual(['ok.pdf']);
    expect(screen.getByRole('alert')).toHaveTextContent(/ruim\.txt/);
  });

  it('rejeita duplicata DENTRO da mesma seleção múltipla', () => {
    const onChange = vi.fn();
    render(<AttachmentPicker value={[]} onChange={onChange} />);
    uploadIgnoringAccept(screen.getByLabelText('Anexar arquivos'), [file('a.pdf'), file('a.pdf')]);
    // Valida contra a fila + os já aceitos nesta leva — senão o mesmo arquivo entraria 2x.
    expect((onChange.mock.calls[0][0] as File[]).map((f) => f.name)).toEqual(['a.pdf']);
    expect(screen.getByRole('alert')).toHaveTextContent(/já está na lista/i);
  });

  it('desabilitado impede escolher', () => {
    render(<AttachmentPicker value={[]} onChange={vi.fn()} disabled />);
    expect(screen.getByLabelText('Anexar arquivos')).toBeDisabled();
  });
});
