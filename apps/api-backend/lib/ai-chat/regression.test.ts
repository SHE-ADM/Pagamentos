// lib/ai-chat/regression.test.ts
// BATERIA DE REGRESSÃO DE PERGUNTAS — item 1.4 da Onda 1 (Fase 4 do roadmap do chat).
//
// O QUE ESTA SUÍTE PROTEGE
// Cada pergunta sugerida no painel é um CONTRATO: o usuário clica confiando que ela responde. Se
// uma mudança de schema, de tool ou de prompt quebrar a cobertura, isto falha ANTES de o usuário
// descobrir clicando.
//
// POR QUE ELA NÃO CHAMA A CLAUDE API
// A resposta do modelo é não-determinística e paga. O que dá para travar de forma determinística é
// o que está sob nosso controle: (a) a pergunta tem alguma tool capaz de respondê-la; (b) os
// parâmetros que o modelo produziria são aceitos pela camada de validação; (c) o dicionário do
// prompt cobre os conceitos que a pergunta usa. A resposta em si é verificada na validação manual
// em produção (§20.9 do doc de arquitetura).
//
// ⚠️ ASSERÇÃO NUNCA É NÚMERO ABSOLUTO (achado da Fase 1, registrado no roadmap §3): o pipeline roda
// a cada 5 min e o batch de vencidos 1×/dia, então qualquer literal de contagem ou valor reprovaria
// no dia seguinte sem defeito nenhum — e o ruído treinaria a equipe a ignorar a bateria.

import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, parseToolInput, type ToolName } from './tools';

/**
 * As perguntas do painel (`AiChatPanel.tsx`) e a tool que cada uma exercita.
 *
 * A duplicação do texto entre este arquivo e o componente é DELIBERADA: são apps distintos
 * (`api-backend` e `frontend-vite`), sem dependência entre si, e criar um pacote compartilhado só
 * para 15 strings acoplaria as duas camadas por um ganho pequeno. O que importa é que toda
 * pergunta sugerida tenha cobertura — e é isso que esta lista trava.
 */
const PERGUNTAS: ReadonlyArray<{ pergunta: string; tool: ToolName; params: Record<string, unknown> }> = [
  // ---- Panorama ----
  {
    pergunta: 'Como estamos de contas a pagar?',
    tool: 'resumo_situacao',
    params: {},
  },
  {
    pergunta: 'Quanto vence nos próximos 7 dias?',
    tool: 'listar_contas',
    params: { date_from: '2026-07-31', date_to: '2026-08-07' },
  },
  {
    pergunta: 'Qual a distribuição das contas vencidas por faixa de atraso?',
    tool: 'aging_vencidos',
    params: { group_by: 'faixa' },
  },
  {
    pergunta: 'Quais os 5 maiores fornecedores com contas vencidas?',
    tool: 'gasto_por_fornecedor',
    params: { date_from: '2020-01-01', date_to: '2026-07-31', limit: 5 },
  },

  // ---- Despesas e custos (foco de auditoria 1) ----
  {
    pergunta: 'Mostre o demonstrativo de custos e despesas do mês',
    tool: 'demonstrativo_despesas',
    params: { date_from: '2026-07-01', date_to: '2026-07-31' },
  },
  {
    pergunta: 'Quanto foi despesa fixa e quanto foi variável neste mês?',
    tool: 'gasto_por_classificacao',
    params: { date_from: '2026-07-01', date_to: '2026-07-31', group_by: 'tipo' },
  },
  {
    pergunta: 'Quanto gastamos por centro de custo neste mês?',
    tool: 'gasto_por_classificacao',
    params: { date_from: '2026-07-01', date_to: '2026-07-31', group_by: 'centro_custo' },
  },
  {
    pergunta: 'Quanto pagamos de tributos no período?',
    tool: 'demonstrativo_despesas',
    params: { date_from: '2026-07-01', date_to: '2026-07-31' },
  },

  // ---- Compliance (o achado mais material: boleto sem NF) ----
  {
    pergunta: 'Quais contas têm boleto mas não têm nota fiscal?',
    tool: 'listar_contas',
    params: {
      date_from: '2020-01-01', date_to: '2030-12-31',
      has_bank_slip: true, has_invoice: false,
    },
  },
  {
    pergunta: 'Quanto pagamos de juros e multa, e por qual fornecedor?',
    tool: 'gasto_por_fornecedor',
    params: { date_from: '2026-01-01', date_to: '2026-12-31' },
  },
  {
    pergunta: 'Quanto capturamos em descontos por antecipação?',
    tool: 'gasto_por_fornecedor',
    params: { date_from: '2026-01-01', date_to: '2026-12-31' },
  },
  {
    pergunta: 'Quais contas estão sem centro de custo ou plano de contas definido?',
    tool: 'gasto_por_classificacao',
    params: { date_from: '2020-01-01', date_to: '2030-12-31', group_by: 'centro_custo' },
  },

  // ---- Evolução ----
  {
    pergunta: 'Como evoluíram os pagamentos mês a mês neste ano?',
    tool: 'gasto_por_periodo',
    params: { date_from: '2026-01-01', date_to: '2026-12-31', date_field: 'pagamento', granularity: 'mes' },
  },
  {
    pergunta: 'Qual a diferença entre o que vence e o que saiu de caixa neste mês?',
    tool: 'gasto_por_periodo',
    params: { date_from: '2026-07-01', date_to: '2026-07-31', date_field: 'pagamento' },
  },
  {
    pergunta: 'Compare os gastos entre OTIMOTEX TECIDOS, LEBIANCO e OTIMOTEX FARDOS',
    tool: 'gasto_por_periodo',
    params: { date_from: '2026-07-01', date_to: '2026-07-31', sk_company: 2 },
  },

  // ---- E-mails (Onda 2) ----
  {
    pergunta: 'Em quais e-mails falaram sobre reajuste?',
    tool: 'buscar_emails',
    params: { termo: 'reajuste' },
  },
];

describe('bateria de regressão — perguntas sugeridas no painel', () => {
  it.each(PERGUNTAS)('"$pergunta" → $tool aceita os parâmetros', ({ tool, params }) => {
    const r = parseToolInput(tool, params);
    // A mensagem do Zod entra na asserção para o teste dizer O QUE está errado, não só que falhou.
    expect(r.ok ? '' : r.message).toBe('');
    expect(r.ok).toBe(true);
  });

  it('toda pergunta aponta para uma tool que existe de fato', () => {
    const existentes = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    for (const { pergunta, tool } of PERGUNTAS) {
      expect(existentes.has(tool), `${pergunta} → ${tool}`).toBe(true);
    }
  });

  // As 3 tools/capacidades que a Onda 1 acrescentou precisam estar REPRESENTADAS. Sem isto, alguém
  // poderia remover o eixo `tipo` ou o demonstrativo e a bateria seguiria verde.
  it('cobre as capacidades novas da Onda 1 (demonstrativo, eixo tipo, filtro de compliance)', () => {
    const usadas = PERGUNTAS.map((p) => p.tool);
    expect(usadas).toContain('demonstrativo_despesas');

    const porTipo = PERGUNTAS.some((p) => p.params.group_by === 'tipo');
    expect(porTipo, 'nenhuma pergunta exercita group_by="tipo"').toBe(true);

    const compliance = PERGUNTAS.some(
      (p) => p.params.has_bank_slip === true && p.params.has_invoice === false,
    );
    expect(compliance, 'nenhuma pergunta exercita boleto sem NF').toBe(true);
  });

  // O painel oferece 16 perguntas; se alguém acrescentar uma lá sem cobrir aqui, o número diverge.
  // É um lembrete mecânico de que sugestão e teste são o MESMO artefato.
  it('mantém a lista alinhada com o painel (16 perguntas em 5 temas)', () => {
    expect(PERGUNTAS).toHaveLength(16);
  });

  it('cobre a busca em e-mails (capacidade nova da Onda 2)', () => {
    expect(PERGUNTAS.map((p) => p.tool)).toContain('buscar_emails');
  });
});
