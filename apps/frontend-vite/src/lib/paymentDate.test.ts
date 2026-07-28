import { describe, it, expect } from 'vitest';
import {
  STATUS_ID_PAGO,
  STATUS_ID_A_VENCER,
  STATUS_ID_VENCIDO,
  STATUS_ID_CANCELADO,
} from '@sheild/shared';
import type { FinancialAccountControl } from '@sheild/shared';
import { nextPaymentDate } from './paymentDate';
import { todayISO } from './format';

// Só os campos que a regra lê; o resto da conta é irrelevante aqui.
const conta = (status_id: number, payment_date: string | null): FinancialAccountControl =>
  ({ status_id, payment_date }) as FinancialAccountControl;

describe('nextPaymentDate (espelho da trigger trg_fac_payment_date)', () => {
  it('preenche com a data de hoje ao ENTRAR em pago', () => {
    expect(nextPaymentDate(conta(STATUS_ID_A_VENCER, null), STATUS_ID_PAGO)).toBe(todayISO());
    expect(nextPaymentDate(conta(STATUS_ID_VENCIDO, null), STATUS_ID_PAGO)).toBe(todayISO());
  });

  it('PRESERVA data já existente ao entrar em pago (pagamento retroativo)', () => {
    expect(nextPaymentDate(conta(STATUS_ID_A_VENCER, '2026-01-15'), STATUS_ID_PAGO)).toBe('2026-01-15');
    // continua pago: também não sobrescreve
    expect(nextPaymentDate(conta(STATUS_ID_PAGO, '2026-01-15'), STATUS_ID_PAGO)).toBe('2026-01-15');
  });

  it('LIMPA ao SAIR de pago — baixa corrigida não deixa data órfã', () => {
    expect(nextPaymentDate(conta(STATUS_ID_PAGO, '2026-07-28'), STATUS_ID_A_VENCER)).toBeNull();
    expect(nextPaymentDate(conta(STATUS_ID_PAGO, '2026-07-28'), STATUS_ID_CANCELADO)).toBeNull();
  });

  it('não toca no campo nas demais transições', () => {
    // a vencer -> cancelado: nunca esteve pago, nada a limpar nem a preencher
    expect(nextPaymentDate(conta(STATUS_ID_A_VENCER, null), STATUS_ID_CANCELADO)).toBeNull();
    // valor pré-existente numa conta não paga é preservado (não inventa nem apaga)
    expect(nextPaymentDate(conta(STATUS_ID_VENCIDO, '2026-03-01'), STATUS_ID_A_VENCER)).toBe('2026-03-01');
  });
});
