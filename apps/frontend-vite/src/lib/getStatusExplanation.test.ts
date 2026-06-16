import { describe, it, expect } from 'vitest';
import type { EmailControl } from '@sheild/shared';
import { getStatusExplanation } from './getStatusExplanation';

// Base mínima de um registro de email_control; cada caso ajusta apenas o status
// (e has_attachment quando relevante para o texto de 'falha').
const baseEmail: EmailControl = {
  id: 1,
  message_id: '<abc@x>',
  imap_uid: null,
  received_at: '2026-06-11T12:19:00Z',
  sender_name: 'Rose',
  sender_email: 'rose@otimotex.com.br',
  subject: 'boleto vencendo hoje',
  body_preview: '',
  keyword_matched: 'boleto',
  has_attachment: false,
  attachment_names: null,
  attachment_saved: false,
  pdf_extracted: false,
  extraction_csv: null,
  status: 'falha',
  notes: null,
  processed_at: '2026-06-11T12:19:00Z',
  updated_at: '2026-06-11T12:19:00Z',
};

describe('getStatusExplanation', () => {
  it("'falha' -> variante error e texto de falha", () => {
    const exp = getStatusExplanation({ ...baseEmail, status: 'falha' });
    expect(exp).not.toBeNull();
    expect(exp?.variant).toBe('error');
    expect(exp?.title).toMatch(/falhou/i);
    expect(exp?.message).toMatch(/palavra-chave financeira/i);
  });

  it("'pendente' -> variante warning citando reprocessamento", () => {
    const exp = getStatusExplanation({ ...baseEmail, status: 'pendente' });
    expect(exp?.variant).toBe('warning');
    expect(exp?.title).toMatch(/pendente/i);
    expect(exp?.message).toMatch(/anexo/i);
    expect(exp?.message).toMatch(/reprocessamento/i);
  });

  it("'ignorado' -> variante info citando assunto não-financeiro", () => {
    const exp = getStatusExplanation({ ...baseEmail, status: 'ignorado' });
    expect(exp?.variant).toBe('info');
    expect(exp?.title).toMatch(/ignorado/i);
    expect(exp?.message).toMatch(/não combinou com nenhuma palavra-chave/i);
    expect(exp?.message).toMatch(/não-financeiro/i);
  });

  it("status de sucesso ('extraído'/'recebido') -> null", () => {
    expect(getStatusExplanation({ ...baseEmail, status: 'extraído' })).toBeNull();
    expect(getStatusExplanation({ ...baseEmail, status: 'recebido' })).toBeNull();
  });
});
