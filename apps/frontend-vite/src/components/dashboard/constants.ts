// src/components/dashboard/constants.ts
// Rótulos de mês compartilhados pelos dashboards (vencimentos e financeiro) e pelos
// primitivos de gráfico. Abreviado (eixo do gráfico mês a mês) e por extenso (subtítulos).
import type { KpiFilter } from '../../services/supabase';

export const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
export const MONTHS_FULL = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

// Rótulo pt-BR do filtro de KPI ativo (fonte única — o cabeçalho e os subtítulos dos
// gráficos consomem o mesmo mapa). Mora aqui (constante pura, sem componente) para poder
// ser importado por páginas sem disparar react-refresh/only-export-components.
export const KPI_FILTER_LABEL: Record<KpiFilter, string> = {
  total: 'Todos', pago: 'Pagos', aVencer: 'A vencer', vencendo7: 'A vencer em 7 dias', vencidas: 'Vencidas',
};

/**
 * Sufixo do filtro ativo para o subtítulo de um card — a RESSALVA de que o número exibido é
 * um recorte. `'total'` (sem filtro) devolve string vazia: a ressalva aparece exatamente
 * quando há o que ressalvar.
 *
 * Mora aqui, e não em cada página, porque as DUAS a usam e o separador é semântico: ` - `
 * marca o recorte por KPI, enquanto ` · ` junta partes do rótulo ("Por status · Agosto").
 * Com uma cópia por página, o primeiro ajuste em uma delas faria as telas divergirem num
 * detalhe que ninguém olha — e a ressalva é justamente o que impede o leitor de concluir o
 * oposto do dado (mesma família do balde parcial da migration 124).
 */
export function kpiFilterSuffix(filter: KpiFilter): string {
  return filter === 'total' ? '' : ` - ${KPI_FILTER_LABEL[filter]}`;
}
