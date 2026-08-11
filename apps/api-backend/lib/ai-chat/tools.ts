// lib/ai-chat/tools.ts
// As 11 tools do chat de IA: definição enviada ao modelo + execução via RPC no schema `analytics`.
// (6 da migration 098 · demonstrativo_despesas da 104 — Onda 1 · buscar_emails da 106 — Onda 2 ·
// documentos_fiscais da 108 — Onda 3 · auditoria_eventos e auditoria_resumo da 118 — Onda 7.)
//
// POR QUE JSON SCHEMA CRU E NÃO ZOD (§17.7 do doc de arquitetura)
// O §6 do documento já especifica os contratos em JSON Schema, que é exatamente o formato que a
// Claude API consome. Converter para Zod só para o helper `betaZodTool` reconverter para JSON
// Schema seria trabalho circular — e o projeto está em Zod 4, enquanto o helper foi escrito
// contra Zod 3. O Zod permanece onde de fato agrega: validando os parâmetros que o MODELO produz,
// antes de chegarem ao banco (`parseToolInput` abaixo).
//
// POR QUE CADA TOOL É UMA FUNÇÃO SQL, NÃO UMA VIEW FILTRADA
// O PostgREST só agrega (`sum`/`count`) com `db-aggregates-enabled`, desligado por padrão no
// Supabase. Como função: a agregação roda no banco, os parâmetros viajam como BIND (o gateway
// nunca interpola string do modelo em SQL) e, sendo SECURITY INVOKER, a RLS das tabelas base
// continua valendo com o JWT do usuário.

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Schema exposto ao PostgREST (migration 098). */
export const ANALYTICS_SCHEMA = 'analytics';

/**
 * Teto de linhas por tool. Espelha o clamp que existe DENTRO das funções SQL — aqui é só o
 * default enviado ao modelo; quem garante o limite é o banco, porque o modelo pode pedir mais.
 */
const DEFAULT_LIMIT = 20;
const DETAIL_LIMIT = 50;

// Domínios espelhados do banco. `status` são os nomes da dimensão (migration 067+); as empresas
// são os 3 `sk_company` reais (1 OTIMOTEX TECIDOS · 2 LEBIANCO · 3 OTIMOTEX FARDOS).
const STATUS_NAMES = [
  'pendente', 'vencido', 'a vencer', 'prorrogado', 'baixado',
  'protestado', 'cartório', 'pago', 'cancelado', 'falha',
] as const;
// Status de `email_control` (migrations 022/031) — domínio DIFERENTE do de contas acima. São a
// caixa de entrada, não o ciclo de vida do título; misturar os dois faria o modelo filtrar por um
// valor que não existe naquela tabela e receber lista vazia, concluindo "não há e-mails".
const EMAIL_STATUS_NAMES = [
  'extraído', 'recebido', 'pendente', 'falha', 'ignorado', 'duplicidade',
] as const;
// Modelos de documento fiscal (migration 107 — Onda 3). Os nomes viajam em minúsculas e o SQL
// os traduz para o número do modelo (55/57/59/65). Valor fora deste domínio devolve VAZIO no
// banco, nunca "todos" — mas o Zod já o barra antes, com mensagem que o modelo consegue corrigir.
const FISCAL_DOC_TYPES = ['nfe', 'cte', 'cfe', 'nfce'] as const;
// Trilha de auditoria (migrations 117/118 — Onda 7). As tabelas auditadas são só estas duas; um
// nome fora do domínio devolveria VAZIO no banco, e o modelo concluiria "não houve alteração"
// em vez de "essa tabela não é auditada" — daí o enum barrar antes, com mensagem corrigível.
const AUDIT_TABLES = ['financial_account_control', 'supplier'] as const;
const AUDIT_OPERATIONS = ['UPDATE', 'DELETE', 'TRUNCATE'] as const;
const AUDIT_GROUPS = ['usuario', 'campo', 'tabela', 'operacao'] as const;
const DATE_FIELDS = ['vencimento', 'pagamento', 'emissao'] as const;
const GRANULARITIES = ['dia', 'semana', 'mes', 'trimestre'] as const;
const CLASSIFICATION_DIMS = ['centro_custo', 'plano_contas', 'grupo', 'subgrupo', 'tipo'] as const;
const AGING_GROUPS = ['faixa', 'empresa', 'fornecedor', 'centro_custo', 'plano_contas'] as const;
const SK_COMPANIES = [1, 2, 3] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve ser YYYY-MM-DD');

// O domínio precisa ser o MESMO do JSON Schema enviado ao modelo. Aceitar aqui um valor que lá é
// proibido faz o modelo receber uma lista vazia e concluir "não há contas dessa empresa", em vez
// de um erro que ele consegue corrigir — o oposto do propósito desta camada.
const skCompanyId = z
  .number()
  .int()
  .refine((v): v is 1 | 2 | 3 => (SK_COMPANIES as readonly number[]).includes(v), {
    message: `Empresa inválida — use ${SK_COMPANIES.join(', ')}`,
  });

// Id do catálogo `financial_type_group`, usado por DUAS dimensões distintas: a NATUREZA do grupo
// (nature_ids) e o TIPO do subgrupo (subgroup_type_ids). O nome é genérico de propósito — chamá-lo
// de `natureId` e reusá-lo no tipo do subgrupo induziria justamente a confusão que o system prompt
// adverte. `smallint` no banco: fora da faixa vira erro cru do Postgres no meio do loop, em vez de
// uma mensagem que o modelo entende.
const typeGroupId = z.number().int().min(0).max(32_767);

// Validação dos parâmetros que o MODELO gera. Não substitui as guardas do banco (as funções
// clampam limit e rejeitam group_by fora do domínio) — é a primeira barreira, que devolve um erro
// legível ao modelo em vez de deixá-lo receber um resultado vazio e concluir que "não há dados".
const schemas = {
  resumo_situacao: z.object({
    sk_company: skCompanyId.optional(),
    as_of: isoDate.optional(),
  }),
  gasto_por_periodo: z.object({
    date_from: isoDate,
    date_to: isoDate,
    date_field: z.enum(DATE_FIELDS).optional(),
    granularity: z.enum(GRANULARITIES).optional(),
    status: z.array(z.enum(STATUS_NAMES)).optional(),
    sk_company: skCompanyId.optional(),
  }),
  gasto_por_fornecedor: z.object({
    date_from: isoDate,
    date_to: isoDate,
    date_field: z.enum(DATE_FIELDS).optional(),
    supplier: z.string().optional(),
    sk_company: skCompanyId.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    has_invoice: z.boolean().optional(),
    has_bank_slip: z.boolean().optional(),
  }),
  gasto_por_classificacao: z.object({
    date_from: isoDate,
    date_to: isoDate,
    group_by: z.enum(CLASSIFICATION_DIMS),
    date_field: z.enum(DATE_FIELDS).optional(),
    nature_ids: z.array(typeGroupId).optional(),
    sk_company: skCompanyId.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    subgroup_type_ids: z.array(typeGroupId).optional(),
  }),
  demonstrativo_despesas: z.object({
    date_from: isoDate,
    date_to: isoDate,
    date_field: z.enum(DATE_FIELDS).optional(),
    sk_company: skCompanyId.optional(),
  }),
  aging_vencidos: z.object({
    group_by: z.enum(AGING_GROUPS).optional(),
    sk_company: skCompanyId.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  listar_contas: z.object({
    date_from: isoDate,
    date_to: isoDate,
    date_field: z.enum(DATE_FIELDS).optional(),
    supplier: z.string().optional(),
    status: z.array(z.enum(STATUS_NAMES)).optional(),
    sk_company: skCompanyId.optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    has_invoice: z.boolean().optional(),
    has_bank_slip: z.boolean().optional(),
  }),
  buscar_emails: z.object({
    // O termo é o único obrigatório: buscar "tudo" na caixa não é caso de uso e traria PII sem
    // propósito. `.min(2)` evita que uma letra solta varra a base inteira.
    termo: z.string().trim().min(2, 'Termo de busca muito curto'),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
    sender: z.string().optional(),
    status: z.array(z.enum(EMAIL_STATUS_NAMES)).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  documentos_fiscais: z.object({
    tipo: z.array(z.enum(FISCAL_DOC_TYPES)).optional(),
    emitente: z.string().optional(),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
    numero: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  auditoria_eventos: z.object({
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
    tabela: z.enum(AUDIT_TABLES).optional(),
    campo: z.string().optional(),
    usuario: z.string().optional(),
    operacao: z.enum(AUDIT_OPERATIONS).optional(),
    registro_id: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  auditoria_resumo: z.object({
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
    group_by: z.enum(AUDIT_GROUPS),
    apenas_sensiveis: z.boolean().optional(),
    tabela: z.enum(AUDIT_TABLES).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
} as const;

// Nome válido de tool — contrato de TOOL_DEFINITIONS/isToolName, consumido via inferência.
// ts-prune-ignore-next
export type ToolName = keyof typeof schemas;

/** Definição enviada ao modelo. `input_schema` é JSON Schema puro (formato da Claude API). */
// ts-prune-ignore-next
export interface ToolDefinition {
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
}

const dateField = {
  type: 'string',
  enum: DATE_FIELDS,
  default: 'vencimento',
  description: 'vencimento → due_date | pagamento → payment_date | emissao → issue_date',
};
const skCompany = {
  type: 'integer',
  enum: SK_COMPANIES,
  description: 'Empresa PAGADORA: 1 OTIMOTEX TECIDOS, 2 LEBIANCO, 3 OTIMOTEX FARDOS. '
    + 'É independente do fornecedor — nunca inferir uma da outra.',
};
const limitProp = (def: number) => ({ type: 'integer', maximum: 100, default: def });

// Curadoria (migration 033): as duas flags que o operador marca no /consulta. Tri-state — omitir
// não filtra. "Boleto sem nota fiscal" é has_bank_slip=true + has_invoice=false, o achado de
// compliance mais material da base.
const hasInvoice = {
  type: 'boolean',
  description: 'Filtra pela flag "Tem NF". Omitir não filtra.',
};
const hasBankSlip = {
  type: 'boolean',
  description: 'Filtra pela flag "Tem Boleto". Omitir não filtra.',
};

// ts-prune-ignore-next — consumido pelo gateway por inferência.
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'resumo_situacao',
    description:
      'KPIs por situação: quantidade e valor em cada status. Use para "como estamos", '
      + '"quanto tenho a pagar". Exclui cancelado. Devolve também overdue_count/overdue_amount, '
      + 'que recalculam o vencido por data de vencimento — use esses para "quanto está vencido", '
      + 'porque o rótulo de status é atualizado por batch diário e fica defasado.',
    input_schema: {
      type: 'object',
      properties: {
        sk_company: skCompany,
        as_of: { type: 'string', format: 'date', description: 'Data de referência (padrão: hoje).' },
      },
    },
  },
  {
    name: 'gasto_por_periodo',
    description:
      'Total agregado por período (série temporal). Use para "quanto paguei/devo em X", '
      + 'evolução mensal, comparação entre meses.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        date_field: dateField,
        granularity: { type: 'string', enum: GRANULARITIES, default: 'mes' },
        status: {
          type: 'array',
          items: { type: 'string', enum: STATUS_NAMES },
          description: 'Sem este filtro, cancelado é excluído. Informá-lo o inclui se pedido.',
        },
        sk_company: skCompany,
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'gasto_por_fornecedor',
    description:
      'Ranking/total por fornecedor. Use para "top fornecedores", "quanto paguei para X". '
      + 'O parâmetro supplier casa CNPJ exato ou parte do nome (sem acento/caixa). '
      + 'Com has_bank_slip=true e has_invoice=false responde "quais fornecedores têm boleto '
      + 'sem nota fiscal" (risco de compliance).',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        date_field: dateField,
        supplier: { type: 'string', description: 'Nome parcial ou CNPJ.' },
        sk_company: skCompany,
        limit: limitProp(DEFAULT_LIMIT),
        has_invoice: hasInvoice,
        has_bank_slip: hasBankSlip,
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'gasto_por_classificacao',
    description:
      'Agrega pela classificação contábil. Use para "gasto por centro de custo", '
      + '"por plano de contas", "por grupo/subgrupo" e — com group_by="tipo" — para '
      + '"quanto foi despesa FIXA vs VARIÁVEL".',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        group_by: {
          type: 'string',
          enum: CLASSIFICATION_DIMS,
          description: 'tipo = Despesas Fixas / Despesas Variáveis / Custos de Mercadorias.',
        },
        date_field: dateField,
        nature_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Natureza do GRUPO: 2 = Despesas, 8 = Custo, 4 = Passivo (tributos).',
        },
        subgroup_type_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Tipo do SUBGRUPO: 5 = Despesas Fixas, 6 = Despesas Variáveis, '
            + '7 = Custos de Mercadorias. Dimensão distinta de nature_ids — não confundir.',
        },
        sk_company: skCompany,
        limit: limitProp(DEFAULT_LIMIT),
      },
      required: ['date_from', 'date_to', 'group_by'],
    },
  },
  {
    name: 'demonstrativo_despesas',
    description:
      'Demonstrativo de Custos e Despesas do período: uma linha para Custos de Mercadorias, '
      + 'Despesas Fixas, Despesas Variáveis, Tributos e Não classificado, mais o Total de saídas. '
      + 'Use para "demonstrativo", "estrutura de custos", "para onde foi o dinheiro". '
      + 'As linhas são mutuamente exclusivas e exaustivas, então SEMPRE somam o total — NÃO '
      + 'recalcule o total, use a linha "Total de saídas" que a tool devolve. '
      + 'NÃO é um DRE: este sistema é contas a pagar e não tem receitas; se perguntarem por DRE, '
      + 'explique isso e ofereça este demonstrativo.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        date_field: dateField,
        sk_company: skCompany,
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'aging_vencidos',
    description:
      'Aging dos títulos EM ABERTO já vencidos, por faixa (1-30, 31-60, 61-90, 90+). '
      + 'Calculado por data de vencimento, não pelo rótulo de status.',
    input_schema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: AGING_GROUPS, default: 'faixa' },
        sk_company: skCompany,
        limit: limitProp(DETAIL_LIMIT),
      },
    },
  },
  {
    name: 'listar_contas',
    description:
      'Drill-down: lista as contas individuais de um recorte, paginado. Use DEPOIS de um '
      + 'agregado, quando o usuário pedir o detalhe ("quais são essas contas?"). '
      + 'Com has_bank_slip=true e has_invoice=false lista as contas com boleto e SEM nota fiscal.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        date_field: dateField,
        supplier: { type: 'string' },
        status: { type: 'array', items: { type: 'string', enum: STATUS_NAMES } },
        sk_company: skCompany,
        page: { type: 'integer', minimum: 1, default: 1 },
        limit: limitProp(DETAIL_LIMIT),
        has_invoice: hasInvoice,
        has_bank_slip: hasBankSlip,
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'buscar_emails',
    description:
      'Busca textual nos E-MAILS RECEBIDOS (assunto + corpo), não nas contas. Use quando a '
      + 'pergunta for sobre o que foi ESCRITO numa mensagem — "em qual e-mail falaram em '
      + 'reajuste?", "algum fornecedor avisou de mudança de conta bancária?". Devolve um trecho '
      + 'com o termo destacado entre << >>, não o e-mail inteiro. '
      + 'ATENÇÃO: e-mails antigos podem ter o corpo incompleto (só foi guardado por inteiro a '
      + 'partir de 31/07/2026) e e-mails fora do filtro de assunto não têm corpo algum — se a '
      + 'busca não achar, isso não prova que o assunto nunca foi mencionado.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Palavra ou expressão a procurar.' },
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        sender: { type: 'string', description: 'Parte do e-mail do remetente.' },
        status: {
          type: 'array',
          items: { type: 'string', enum: EMAIL_STATUS_NAMES },
          description: 'Situação do E-MAIL (não da conta): extraído, recebido, pendente, falha, '
            + 'ignorado, duplicidade.',
        },
        limit: { type: 'integer', maximum: 50, default: DEFAULT_LIMIT },
      },
      required: ['termo'],
    },
  },
  {
    name: 'documentos_fiscais',
    description:
      'Documentos fiscais eletrônicos RECEBIDOS por e-mail (CT-e de frete, NF-e de mercadoria, '
      + 'CF-e, NFC-e), identificados pela chave de acesso de 44 dígitos. Responde "quantos CT-e '
      + 'a transportadora X emitiu?", "recebi a NF-e número 19016?", "de quais emitentes vieram '
      + 'conhecimentos de transporte em julho?". '
      + '🔴 NÃO é conta a pagar e NÃO tem valor: o frete já entra no sistema como BOLETO e a NF-e '
      + 'é a origem da mercadoria, não a obrigação de pagamento. NUNCA misture estes documentos '
      + 'com gastos nem os apresente como despesa. '
      + 'Cada linha traz total_encontrado com a contagem REAL do filtro (antes do limite) — use '
      + 'esse número para contar, nunca o número de linhas devolvidas. '
      + 'COBERTURA PARCIAL: só documentos cujo PDF chegou por e-mail e ainda estava no bucket; '
      + 'não achar um documento não prova que ele não existiu.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'array',
          items: { type: 'string', enum: FISCAL_DOC_TYPES },
          description: 'cte → conhecimento de transporte · nfe → nota fiscal de mercadoria · '
            + 'cfe → cupom fiscal eletrônico · nfce → NFC-e. Omitir traz todos.',
        },
        emitente: {
          type: 'string',
          description: 'CNPJ (com ou sem máscara) OU parte do nome do emitente, quando ele já '
            + 'estiver cadastrado como fornecedor.',
        },
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        numero: { type: 'integer', description: 'Número do documento (não a chave de acesso).' },
        limit: limitProp(DEFAULT_LIMIT),
      },
    },
  },
  {
    name: 'auditoria_eventos',
    description:
      'Trilha de auditoria: QUEM alterou o QUÊ, e quando, em contas a pagar e fornecedores. '
      + 'Use para "quem mudou o valor desta conta?", "o que aconteceu com a conta 794?", '
      + '"alguém alterou a chave PIX de algum fornecedor?", "quem excluiu contas neste mês?". '
      + 'Devolve o DELTA de cada alteração (valor antes → depois), não a linha inteira. '
      + '🔴 A trilha COMEÇA em 11/08/2026: não encontrar evento anterior a essa data NÃO prova '
      + 'que nada mudou antes — antes disso o sistema só guardava o ÚLTIMO editor de cada conta. '
      + '🔴 ator_via="servico" significa alteração de ROTINA AUTOMÁTICA (pipeline de e-mail, '
      + 'batch diário) ou edição não atribuível — NUNCA leia como "ninguém alterou". '
      + 'O campo `usuario` tem TRÊS formas, que não devem ser confundidas: um e-mail (a pessoa), '
      + '"(automacao / nao atribuivel)" (rotina automática) e "(usuario removido: <id>)" — este '
      + 'último foi uma AÇÃO HUMANA cuja conta depois foi apagada, e não uma automação. '
      + 'O filtro por campo inclui a EXCLUSÃO do registro, porque apagar a conta destrói aquele '
      + 'campo junto: "quem mexeu no valor?" precisa mostrar também quem excluiu a conta. '
      + 'Cada linha traz total_encontrado com a contagem REAL do filtro (antes do limite) — use '
      + 'esse número para contar, nunca o número de linhas devolvidas.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        tabela: {
          type: 'string',
          enum: AUDIT_TABLES,
          description: 'financial_account_control = contas a pagar · supplier = fornecedores. '
            + 'São as únicas tabelas auditadas.',
        },
        campo: {
          type: 'string',
          description: 'Nome da coluna alterada, ex.: amount (valor), due_date (vencimento), '
            + 'status_id (situação), sk_supplier (fornecedor), barcode, pix_key1.',
        },
        usuario: {
          type: 'string',
          description: 'Parte do e-mail de quem fez a alteração. Casa também "removido" para '
            + 'achar ações de usuários cuja conta foi apagada.',
        },
        operacao: { type: 'string', enum: AUDIT_OPERATIONS },
        registro_id: {
          type: 'integer',
          description: 'Id da conta (ou sk_supplier) para ver o histórico de UM registro.',
        },
        limit: limitProp(DETAIL_LIMIT),
      },
    },
  },
  {
    name: 'auditoria_resumo',
    description:
      'Agregado da trilha de auditoria: quantas alterações por usuário, por campo, por tabela ou '
      + 'por operação. É a tool para "quais usuários vêm alterando campos sensíveis" '
      + '(group_by="usuario" + apenas_sensiveis=true), "qual campo mais muda", "quem mexeu mais '
      + 'no cadastro este mês". Prefira-a a listar eventos quando a pergunta for de VOLUME ou '
      + 'de RANKING — a lista de eventos é truncada e contá-la daria número errado. '
      + 'Campos sensíveis = valor, valor cobrado, vencimento, data de pagamento, situação, '
      + 'fornecedor, empresa, código de barras, nosso número, nº do documento, flags de NF/Boleto, '
      + 'classificação contábil e, no fornecedor, chave PIX e CNPJ/CPF. '
      + 'Mesma ressalva de cobertura da auditoria_eventos: a trilha começa em 11/08/2026.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        group_by: {
          type: 'string',
          enum: AUDIT_GROUPS,
          description: 'usuario = quem alterou — "(automacao / nao atribuivel)" agrupa as rotinas '
            + 'automáticas e "(usuario removido: <id>)" é uma pessoa cuja conta foi apagada, '
            + 'NUNCA some as duas · campo = qual coluna (só alterações de campo; a EXCLUSÃO de '
            + 'registro não aparece neste eixo — para vê-la use group_by="operacao") · tabela.',
        },
        apenas_sensiveis: {
          type: 'boolean',
          default: false,
          description: 'true = conta só as alterações que tocaram campo sensível.',
        },
        tabela: { type: 'string', enum: AUDIT_TABLES },
        limit: limitProp(DEFAULT_LIMIT),
      },
      required: ['group_by'],
    },
  },
] as const;

const TOOL_NAMES = new Set<string>(TOOL_DEFINITIONS.map((t) => t.name));

export function isToolName(name: string): name is ToolName {
  return TOOL_NAMES.has(name);
}

/**
 * Valida o input gerado pelo modelo e converte para os parâmetros nomeados da função SQL
 * (prefixo `p_`, conforme a migration 098).
 *
 * @returns `{ ok: true, params }` ou `{ ok: false, message }` — a mensagem volta ao MODELO como
 *   `tool_result` com `is_error: true`, para ele corrigir a chamada. Nunca vira exceção: um
 *   parâmetro errado do modelo é fluxo normal do loop, não falha da requisição.
 */
export function parseToolInput(
  name: ToolName,
  raw: unknown,
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  const parsed = schemas[name].safeParse(raw);
  if (!parsed.success) {
    const detalhe = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    return { ok: false, message: `Parâmetros inválidos para ${name} — ${detalhe}` };
  }
  // O Zod já removeu chaves desconhecidas (strip). Prefixa para casar a assinatura SQL.
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) params[`p_${key}`] = value;
  }
  return { ok: true, params };
}

/**
 * Executa a tool via RPC no schema `analytics`, com o JWT do PRÓPRIO usuário.
 *
 * O `client` precisa ser o anon (`getAnonClient`), nunca o service_role: é o que faz a RLS da
 * migration 076 decidir o recorte — um usuário do grupo Comercial só enxerga as contas em que é
 * dono, exatamente como na tela. Com service_role o chat veria tudo.
 *
 * `.schema(ANALYTICS_SCHEMA)` faz o supabase-js enviar `Content-Profile: analytics`, que é o
 * header que seleciona o schema em POST /rpc (o `Accept-Profile` NÃO funciona aqui — verificado
 * contra o PostgREST real, que sem ele procura a função em `public` e devolve PGRST202).
 */
export async function runTool(
  client: SupabaseClient,
  token: string,
  name: ToolName,
  params: Record<string, unknown>,
): Promise<unknown[]> {
  const { data, error } = await client
    .schema(ANALYTICS_SCHEMA)
    .rpc(name, params)
    .setHeader('Authorization', `Bearer ${token}`);

  if (error) throw new Error(`${name}: ${error.message}`);
  return Array.isArray(data) ? data : [];
}
