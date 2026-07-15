import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FinancialAccountAttachment } from '@sheild/shared';
import { axe } from '../../../tests/axe';

vi.mock('../../services/contaAttachments', () => ({
  listContaAttachments: vi.fn(),
  deleteContaAttachment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../AttachmentViewer', () => ({ default: () => <div /> }));

import ContaAttachments from './ContaAttachments';

const att = (over: Partial<FinancialAccountAttachment> = {}): FinancialAccountAttachment => ({
  id: 1,
  account_id: 7,
  storage_key: 'manual/7/x_boleto.pdf',
  file_name: 'boleto.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  origin: 'manual',
  uploaded_by: 'u1',
  created_at: '2026-07-15T12:00:00Z',
  ...over,
});

describe('ContaAttachments — acessibilidade (WCAG AA)', () => {
  it('lista de anexos não tem violações', async () => {
    const { container } = render(
      <ContaAttachments accountId={7} items={[att(), att({ id: 2, origin: 'pipeline', file_name: 'email.pdf' })]} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('vazio não tem violações', async () => {
    const { container } = render(<ContaAttachments accountId={7} items={[]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('confirmação de remoção não tem violações', async () => {
    const { container } = render(<ContaAttachments accountId={7} items={[att()]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover boleto.pdf' }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
