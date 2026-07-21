// src/components/dashboard/constants.ts
// Rótulos de mês compartilhados pelos dashboards (vencimentos e financeiro) e pelos
// primitivos de gráfico. Abreviado (eixo do gráfico mês a mês) e por extenso (subtítulos).
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

// Fatia do donut "Tipo" que agrupa as contas SEM plano de contas (`chart_account_id = 0`).
// Fica aqui — módulo de constantes sem dependência — porque o rótulo é produzido pelo
// serviço (services/supabase.ts, ao montar o breakdown) e consumido pela cor do gráfico
// (chartColors.ts). Fonte única: os dois lados comparam contra ESTA constante, nunca contra
// o literal — divergir de um acento faria a fatia perder o vermelho, em silêncio.
export const UNCLASSIFIED_LABEL = 'Sem Definição';
