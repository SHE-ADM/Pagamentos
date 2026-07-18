// lib/classification.ts
// Validação do PAR de classificação contábil (centro de custo + plano de contas) de uma
// conta/fornecedor, sobre o Supabase (service_role). É a trava autoritativa do requisito:
// não gravar plano sem centro relacionado (e vice-versa), nem ids inexistentes, nem par
// inconsistente (o centro informado precisa PERTENCER ao plano — cost_center_id da linha
// do plano == centro informado). Cascata invertida Plano → Centro: cada `chart_account_id`
// carrega o seu único `cost_center_id`, então a consistência é uma checagem direta.

import { getSupabaseAdmin } from './supabase-admin';

const CHART_ACCOUNT_TABLE = 'financial_chart_of_account';
const COST_CENTER_TABLE = 'financial_cost_center';

/**
 * Valida o par (centro de custo, plano de contas). Retorna a MENSAGEM de erro (pt-BR, para
 * um 422 pelo chamador) ou `null` quando o par é aceitável. Regras:
 * - ambos 0/ausente ("não informado") → válido (classificação opcional);
 * - apenas um informado (par incompleto) → inválido;
 * - ambos informados → o plano precisa existir, o centro precisa existir e o plano precisa
 *   PERTENCER a esse centro (cost_center_id da linha == centro informado).
 *
 * NÃO valida `is_postable`: o select da UI já só oferece planos lançáveis, e re-impor isso
 * aqui bloquearia a EDIÇÃO de uma conta histórica cujo plano tenha sido desativado depois —
 * um plano não-lançável ainda é uma FK válida; a lançabilidade é regra de UI, não de dado.
 *
 * @throws Erro genérico (→ 500 no chamador) em falha de INFRAESTRUTURA do banco — nunca
 *   confundir com erro de validação (o cliente não é culpado por um banco indisponível).
 */
export async function checkClassificationPair(
  costCenterId: number,
  chartAccountId: number,
): Promise<string | null> {
  const cc = costCenterId || 0;
  const ca = chartAccountId || 0;

  if (!cc && !ca) return null; // não informado — permitido
  if (!cc || !ca) return 'Informe o centro de custo e o plano de contas juntos.';

  const admin = getSupabaseAdmin();

  const { data: chart, error: chartErr } = await admin
    .from(CHART_ACCOUNT_TABLE)
    .select('cost_center_id')
    .eq('chart_account_id', ca)
    .maybeSingle();
  if (chartErr) throw new Error(`classification: falha ao consultar o plano de contas: ${chartErr.message}`);
  if (!chart) return 'Plano de contas informado não existe.';
  const row = chart as { cost_center_id: number | null };
  if (row.cost_center_id !== cc) return 'O centro de custo informado não pertence ao plano de contas selecionado.';

  const { data: center, error: centerErr } = await admin
    .from(COST_CENTER_TABLE)
    .select('cost_center_id')
    .eq('cost_center_id', cc)
    .maybeSingle();
  if (centerErr) throw new Error(`classification: falha ao consultar o centro de custo: ${centerErr.message}`);
  if (!center) return 'Centro de custo informado não existe.';

  return null;
}
