import { z } from 'zod';

// Cadastro `financial_cost_center` — centro de custo. Tabela de CADASTRO
// pré-existente (preservada em limpezas), usada como lookup na classificação
// contábil das contas a pagar (FK financial_account_control.cost_center_id —
// migration 047). Leitura apenas; o CRUD desta dimensão é externo ao app.

export const costCenterSchema = z.object({
  cost_center_id: z.number().int(),
  cost_center_code: z.string().nullable(),
  cost_center_description: z.string().nullable(),
});

export type CostCenter = z.infer<typeof costCenterSchema>;
