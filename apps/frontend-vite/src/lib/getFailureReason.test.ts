import { describe, it, expect } from 'vitest';
import type { EmailControl } from '@sheild/shared';
import { getFailureReason } from './getFailureReason';

// Base mínima de um registro de email_control para os testes; cada caso ajusta
// apenas o campo relevante (has_attachment).
const baseEmail: EmailControl = {
  id: 1,
  message_id: '<abc@x>',
  imap_uid: null,
  received_at: '2026-06-11T12:19:00Z',
  sender_name: 'Rose',
  sender_email: 'rose@otimotex.com.br',
  subject: 'RES: boleto e nf em anexo favor confirmar',
  body_preview: 'No aguardo do boleto vencendo hj',
  keyword_matched: 'boleto',
  has_attachment: false,
  attachment_names: null,
  attachment_saved: false,
  pdf_extracted: false,
  extraction_csv: null,
  status: 'falha',
  notes: 'Sem anexo PDF — registrado para revisão',
  processed_at: '2026-06-11T12:19:00Z',
  updated_at: '2026-06-11T12:19:00Z',
};

describe('getFailureReason', () => {
  it('explica falha sem anexo citando ausência de PDF e de valor/nota', () => {
    const reason = getFailureReason({ ...baseEmail, has_attachment: false });
    expect(reason).toMatch(/palavra-chave financeira/i);
    expect(reason).toMatch(/nenhum PDF anexado/i);
    expect(reason).toMatch(/revisar este e-mail manualmente/i);
  });

  it('explica falha com anexo citando que o anexo não pôde ser lido', () => {
    const reason = getFailureReason({ ...baseEmail, has_attachment: true });
    expect(reason).toMatch(/trazia um anexo/i);
    expect(reason).toMatch(/revisar este e-mail manualmente/i);
  });
});
