import { describe, it, expect } from 'vitest';
import { errosColumns } from './cobrancaColumns';
import type { CobrancaErroLog } from '../../types/cobranca';

const baseRow: CobrancaErroLog = {
  id: 1,
  document_id: '245107-A',
  customer_name: 'CLIENTE X',
  primary_email: null,
  cc_email: 'rep@lebianco.com.br',
  due_date: '2026-06-16',
  bill_amount: 100,
  email_subject: 'COBRANÇA',
  error_type: 'email_ausente',
  error_message: 'Cliente sem e-mail cadastrado.',
  error_detail: null,
  occurred_at: '2026-06-22T08:00:00Z',
  created_at: '2026-06-22T08:00:00Z',
};

describe('errosColumns — e-mail do representante (Cc)', () => {
  const ccCol = errosColumns.find((c) => c.key === 'cc_email');
  const toCol = errosColumns.find((c) => c.key === 'primary_email');

  it('inclui a coluna cc_email com cabeçalho "E-mail (Cc)"', () => {
    expect(ccCol).toBeDefined();
    expect(ccCol?.header).toBe('E-mail (Cc)');
  });

  it('renderiza o e-mail do representante', () => {
    expect(ccCol?.render(baseRow)).toBe('rep@lebianco.com.br');
  });

  it('mostra travessão quando não há Cc', () => {
    expect(ccCol?.render({ ...baseRow, cc_email: null })).toBe('—');
  });

  it('rotula a coluna do cliente como "E-mail"', () => {
    expect(toCol?.header).toBe('E-mail');
  });

  it('posiciona "E-mail (Cc)" imediatamente após "E-mail"', () => {
    const iTo = errosColumns.findIndex((c) => c.key === 'primary_email');
    const iCc = errosColumns.findIndex((c) => c.key === 'cc_email');
    expect(iCc).toBe(iTo + 1);
  });
});
