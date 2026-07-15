import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FinancialAccountAttachment } from '@sheild/shared';

const listMock = vi.fn();
const deleteMock = vi.fn();
vi.mock('../../services/contaAttachments', () => ({
  listContaAttachments: (...a: unknown[]) => listMock(...a),
  deleteContaAttachment: (...a: unknown[]) => deleteMock(...a),
}));

// O viewer real gera signed URL; aqui só interessa QUE ele foi aberto e com qual chave.
vi.mock('../AttachmentViewer', () => ({
  default: ({ sourceFile, title }: { sourceFile: string; title?: string }) => (
    <div data-testid="viewer" data-key={sourceFile}>
      {title}
    </div>
  ),
}));

import ContaAttachments from './ContaAttachments';

const att = (over: Partial<FinancialAccountAttachment> = {}): FinancialAccountAttachment => ({
  id: 1,
  account_id: 7,
  storage_key: 'manual/7/20260715T120000Z_ab12cd34_boleto.pdf',
  file_name: 'boleto.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  origin: 'manual',
  uploaded_by: 'u1',
  created_at: '2026-07-15T12:00:00Z',
  ...over,
});

beforeEach(() => {
  listMock.mockReset();
  deleteMock.mockReset().mockResolvedValue(undefined);
});

describe('ContaAttachments', () => {
  it('usa os itens do embed sem consultar a API', () => {
    render(<ContaAttachments accountId={7} items={[att()]} />);
    expect(screen.getByText('boleto.pdf')).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('busca na API quando o pai não passa os itens', async () => {
    listMock.mockResolvedValue([att({ file_name: 'nota.pdf' })]);
    render(<ContaAttachments accountId={7} />);
    expect(await screen.findByText('nota.pdf')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(7);
  });

  it('abre o viewer com a CHAVE do objeto e o nome amigável', async () => {
    render(<ContaAttachments accountId={7} items={[att()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver boleto.pdf' }));
    const viewer = screen.getByTestId('viewer');
    // A chave crua vai ao Storage; o nome original é só rótulo.
    expect(viewer).toHaveAttribute('data-key', 'manual/7/20260715T120000Z_ab12cd34_boleto.pdf');
    expect(viewer).toHaveTextContent('boleto.pdf');
  });

  it('remover pede confirmação antes de chamar a API', async () => {
    render(<ContaAttachments accountId={7} items={[att()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover boleto.pdf' }));
    expect(deleteMock).not.toHaveBeenCalled(); // só confirmou a intenção
    expect(screen.getByText(/Remover o anexo/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remover' }));
    expect(deleteMock).toHaveBeenCalledWith(7, 1);
  });

  // A lixeira que abriu a confirmação sai da árvore; sem role + foco, o leitor de tela não
  // anunciaria nada e a ação (destrutiva) pareceria não ter efeito — WCAG 4.1.3.
  it('a confirmação é um alertdialog nomeado e recebe o foco', async () => {
    render(<ContaAttachments accountId={7} items={[att()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover boleto.pdf' }));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName(/Remover o anexo "boleto\.pdf"\?/);
    expect(screen.getByRole('button', { name: 'Remover' })).toHaveFocus();
  });

  it('cancelar a confirmação não remove', async () => {
    render(<ContaAttachments accountId={7} items={[att()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover boleto.pdf' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(deleteMock).not.toHaveBeenCalled();
    expect(screen.getByText('boleto.pdf')).toBeInTheDocument();
  });

  it('após remover, o anexo some da lista e o pai é avisado', async () => {
    const onChanged = vi.fn();
    render(<ContaAttachments accountId={7} items={[att(), att({ id: 2, file_name: 'outro.pdf' })]} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover boleto.pdf' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(screen.queryByText('boleto.pdf')).not.toBeInTheDocument());
    expect(screen.getByText('outro.pdf')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledWith([expect.objectContaining({ id: 2 })]);
  });

  it('falha ao remover mostra o erro e mantém o anexo', async () => {
    deleteMock.mockRejectedValue(new Error('O anexo recebido por e-mail não pode ser removido'));
    render(<ContaAttachments accountId={7} items={[att()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover boleto.pdf' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remover' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/não pode ser removido/);
    expect(screen.getByText('boleto.pdf')).toBeInTheDocument();
  });

  it('canRemove=false esconde a lixeira', () => {
    render(<ContaAttachments accountId={7} items={[att()]} canRemove={false} />);
    expect(screen.queryByRole('button', { name: /Remover/ })).not.toBeInTheDocument();
  });

  it('anexo do e-mail nunca tem lixeira, mesmo com canRemove', () => {
    render(<ContaAttachments accountId={7} items={[att({ origin: 'pipeline' })]} />);
    expect(screen.getByText('e-mail')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remover/ })).not.toBeInTheDocument();
  });

  it('FALLBACK: sem anexos registrados, exibe o source_file da conta', async () => {
    // O registro do anexo é não-fatal no pipeline: uma conta pode ter source_file e
    // nenhuma linha. Sem este fallback o anexo do e-mail sumiria da tela (regressão
    // contra o antigo botão "Ver anexo").
    render(<ContaAttachments accountId={7} items={[]} legacySourceFile="ester_HYOSUNG.pdf" />);
    expect(screen.getByText('ester_HYOSUNG.pdf')).toBeInTheDocument();
    expect(screen.getByText('e-mail')).toBeInTheDocument(); // tratado como do pipeline

    await userEvent.click(screen.getByRole('button', { name: 'Ver ester_HYOSUNG.pdf' }));
    // Chave do pipeline = o próprio nome (flat, sem pasta).
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-key', 'ester_HYOSUNG.pdf');
  });

  it('havendo anexos registrados, o fallback NÃO duplica o do e-mail', () => {
    render(
      <ContaAttachments
        accountId={7}
        items={[att({ origin: 'pipeline', file_name: 'ester_HYOSUNG.pdf', storage_key: 'ester_HYOSUNG.pdf' })]}
        legacySourceFile="ester_HYOSUNG.pdf"
      />,
    );
    expect(screen.getAllByText('ester_HYOSUNG.pdf')).toHaveLength(1);
  });

  // Regressão: a condição do fallback era `rows.length === 0`, então anexar UM arquivo
  // manual fazia o boleto do e-mail sumir da tela — exatamente o que o fallback evita.
  // A pergunta certa é "há anexo DE E-MAIL?", não "há algum anexo?".
  it('FALLBACK convive com anexo MANUAL: o do e-mail continua visível', () => {
    render(
      <ContaAttachments
        accountId={7}
        items={[att({ id: 5, origin: 'manual', file_name: 'enviado_pelo_usuario.pdf' })]}
        legacySourceFile="ester_HYOSUNG.pdf"
      />,
    );
    expect(screen.getByText('ester_HYOSUNG.pdf')).toBeInTheDocument(); // não sumiu
    expect(screen.getByText('enviado_pelo_usuario.pdf')).toBeInTheDocument();
    expect(screen.getByText('e-mail')).toBeInTheDocument(); // o selo é só do legado
  });

  it('sem anexos e sem source_file, mostra o vazio', () => {
    render(<ContaAttachments accountId={7} items={[]} />);
    expect(screen.getByText('Nenhum anexo nesta conta.')).toBeInTheDocument();
  });
});
