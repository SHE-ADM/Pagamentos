import { z } from 'zod';

// Cadastro `financial_chart_of_account` — plano de contas. Tabela de CADASTRO
// pré-existente (preservada em limpezas), usada como lookup na classificação
// contábil das contas a pagar (FK financial_account_control.chart_account_id —
// migration 047). Leitura apenas; o CRUD desta dimensão é externo ao app. A
// listagem expõe só as contas postáveis (is_postable), que são as elegíveis a
// lançamento.

export const chartAccountSchema = z.object({
  chart_account_id: z.number().int(),
  account_code: z.string().nullable(),
  account_description: z.string().nullable(),
});

export type ChartAccount = z.infer<typeof chartAccountSchema>;
