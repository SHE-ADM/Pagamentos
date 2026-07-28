// src/lib/paymentDate.ts
// Espelho, no cliente, da trigger `trg_fac_payment_date` (migration 096) — a única
// dona de `financial_account_control.payment_date` no banco. Usado pelo update
// otimista de situação em /consulta (applyStatusId), que altera a linha em memória
// sem refetch: sem espelhar a regra, a conta apareceria "paga sem data" até o próximo
// carregamento. Hoje isso é invisível (a coluna não é exibida no grid nem no CSV) e
// vira visível assim que ela for.
//
// Vive em `lib/` — e não como helper de módulo em Consulta.tsx — para ser testável
// diretamente: é lógica pura, sem nada observável na tela, então teste de UI não a
// alcança. Mesmo precedente do `todayISO` (ver lib/format.ts).
import { STATUS_ID_PAGO } from '@sheild/shared';
import type { FinancialAccountControl } from '@sheild/shared';
import { todayISO } from './format';

/**
 * Próximo valor de `payment_date` ao mudar a situação de uma conta para `id`.
 *
 * Regra idêntica à da trigger no banco:
 * - ENTRA em pago  → preenche com a data de hoje, **preservando** data já existente
 *   (pagamento retroativo informado no mesmo comando);
 * - SAI de pago    → limpa (baixa corrigida não deixa data órfã);
 * - demais transições → não toca no campo.
 */
export function nextPaymentDate(r: FinancialAccountControl, id: number): string | null {
  if (id === STATUS_ID_PAGO) return r.payment_date ?? todayISO();
  if (r.status_id === STATUS_ID_PAGO) return null;
  return r.payment_date;
}
