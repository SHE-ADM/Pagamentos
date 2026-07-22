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
