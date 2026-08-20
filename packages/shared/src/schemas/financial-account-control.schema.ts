import { z } from 'zod';
import { chartAccountGroupEmbeddedSchema } from './chart-account-group.schema';
import { chartAccountSubgroupEmbeddedSchema } from './chart-account-subgroup.schema';
import { financialAccountAttachmentEmbeddedSchema } from './financial-account-attachment.schema';

// Schema da tabela `financial_account_control` — controle central de contas a
// pagar. Uma linha por documento financeiro, alimentada por duas origens:
// o pipeline de extração de e-mail e o CRUD manual (baixas, consolidações,
// dashboards). Reflete o estado das migrations 018 (criação + domínios pt-BR),
// além de 005 (campos de boleto), 007/009 (company_id/supplier_id), 042/083
// (surrogate keys sk_supplier/sk_company) e o
// email_body_excerpt. Campos monetários chegam como string ou número pela REST
// do Supabase — `z.coerce.number()` normaliza ambos.

// ── Enums de domínio (espelham os CHECK constraints da migration 018) ────────

export const DOCUMENT_TYPES = [
  'boleto',
  'cte',
  'nfe',
  'nfse',
  'seguro',
  'fatura',
  'recibo',
  'contrato',
  'outro',
  'darf',
  'gps',
  'das',
  'gru',
  'dae',
  // DAR / DARE — Documento de Arrecadação estadual. Entrada ÚNICA para os dois acrônimos
  // (mesmo instrumento, nomes diferentes por estado), no mesmo padrão de 'dam / duam'.
  // Substituiu o antigo 'dare' na migration 133, com backfill das 26 contas existentes.
  // 🔴 `dar` é PREFIXO de `darf` E verbo comum do português ("dar baixa", "padaria"), então
  // é auto-classificado APENAS por RÓTULO EXPLÍCITO — `_DOC_TYPE_NORM` em extract_pdf.py,
  // que é lookup EXATO. Nos classificadores por substring/palavra-inteira só entram FRASES
  // ("dar modelo 1", "dar-1"…) e a forma inequívoca "dare".
  'dar / dare',
  'gnre',
  'ipva',
  'iptu',
  'dam / duam',
  'iss',
  'itbi',
  'gare',
  'tributo',
  'multa',
  // `pix` NÃO é tipo de documento — é só forma de pagamento (PAYMENT_METHODS). Um
  // pagamento PIX sem outro indício de tipo fica `outro` (migration 075). Removido
  // em 2026-07-10.
  'honorários',
  'container',
  // Cartório — pagamento de/em cartório (custas de tabelionato/registro/protesto);
  // classificado pelo contexto "cartório"/"cartorio" no assunto/fornecedor (migration 066).
  'cartório',
  // Cheque — o cheque como documento da conta (migration 086). Selecionável no cadastro
  // manual; NÃO auto-classificado pela palavra "cheque" (que já é payment_method).
  'cheque',
  // Comprovante — comprovante/recibo como documento da conta (migration 087). Selecionável
  // no cadastro manual; NÃO auto-classificado pela palavra "comprovante" (evita conflito
  // com subject_is_payment_confirmation, que já IGNORA "comprovante de pagamento").
  'comprovante',
  // Contas de concessionária — classificadas por frase do assunto/corpo (migration 043).
  'conta de água',
  'conta de luz',
  'conta de telefone / internet',
] as const;

export const EXTRACTION_SOURCES = [
  'email_body',
  'pdf_text',
  'pdf_vision',
  'image_vision',
  // Anexo .docx (Word) — migration 131. `docx_text` sai do XML do documento (zipfile + regex,
  // determinístico); `docx_vision` é a leitura VISUAL da imagem embutida.
  'docx_text',
  'docx_vision',
  'falha',
] as const;

/**
 * Confiança ORDINAL da extração, derivada de `extraction_source` pela coluna gerada
 * `extraction_confidence` (migration 112). O eixo é PROVENIÊNCIA, não probabilidade:
 *
 *   alta         `pdf_text`      — texto digital do PDF, determinístico, sem OCR no caminho
 *                `docx_text`     — XML do Word (zipfile + regex), e só aceito quando o texto traz
 *                                instrumento de pagamento com DV válido: oráculo mais forte que o
 *                                do PDF, que é aceito por volume de texto
 *   media        `email_body`    — parsing de texto livre; o layout varia por remetente
 *   baixa        `pdf_vision` / `image_vision` / `docx_vision` — leitura VISUAL (origem dos 18
 *                                barcodes corrompidos achados em 2026-08-07)
 *   manual       `extraction_source` NULL — digitado por pessoa no CRUD
 *   desconhecida `falha` e qualquer valor futuro que o CASE da 112 não mapeie
 *
 * Nunca virar número: um `0.85` sugeriria uma calibração que ninguém mediu e convidaria a
 * tirar média de uma escala inventada. `desconhecida` acima de zero significa que
 * `EXTRACTION_SOURCES` ganhou valor novo e o CASE da migration não acompanhou — a guarda G5
 * de tests/test_onda6_campos_derivados.py trava essa correspondência.
 */
export const EXTRACTION_CONFIDENCES = [
  'alta',
  'media',
  'baixa',
  'manual',
  'desconhecida',
] as const;

export const PAYMENT_METHODS = [
  'boleto',
  'pix',
  'ted',
  'cartão',
  'depósito',
  'duplicata',
  'bancário',
  'carteira',
  'vale',
  'crédito',
  'débito',
  'débito automático',
  'dinheiro',
  'transferência',
  'cheque',
  'outro',
] as const;

// Situação/ciclo de vida da conta — coluna única `status` (migration 034 fundiu o
// antigo `due_status` aqui). A trigger `fn_set_status_from_due_date` grava
// 'a vencer'/'vencido' a partir de `due_date` quando o status está em aberto
// (pendente/a vencer/vencido); 'falha' e baixas/CRUD manual (pago/baixado/cancelado/…)
// são preservados. Domínio (10 valores) = tabela de dimensão `status` (migration 035,
// que também resolve `status_id` por `status_name`):
export const ACCOUNT_STATUSES = [
  'pendente',
  'vencido',
  'a vencer',
  'prorrogado',
  'baixado',
  'protestado',
  'cartório',
  'pago',
  'cancelado',
  'falha',
] as const;

export const documentTypeSchema = z.enum(DOCUMENT_TYPES);
export const extractionSourceSchema = z.enum(EXTRACTION_SOURCES);
export const extractionConfidenceSchema = z.enum(EXTRACTION_CONFIDENCES);
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
// ACCOUNT_STATUSES/AccountStatus (nomes) seguem para labels/mapa id↔nome; a situação da
// conta é gravada/lida por status_id (fonte única — a coluna `status` texto foi removida
// na FASE 3, migration 069). Não há mais `accountStatusSchema` (o campo texto não existe).

// IDs da dimensão `status` (= financial_account_control.status_id). status_id é a
// FONTE ÚNICA da situação; estes ids nomeados evitam magic number em filtros/KPIs
// (ex.: excluir cancelado = status_id != STATUS_ID_CANCELADO). Espelham a tabela
// `status` (nomes em ACCOUNT_STATUSES).
export const STATUS_IDS = {
  pendente: 1,
  vencido: 2,
  'a vencer': 3,
  prorrogado: 4,
  baixado: 5,
  protestado: 6,
  cartório: 7,
  pago: 8,
  cancelado: 9,
  falha: 10,
} as const satisfies Record<(typeof ACCOUNT_STATUSES)[number], number>;

export const STATUS_ID_A_VENCER = STATUS_IDS['a vencer']; // 3 — default da conta
export const STATUS_ID_VENCIDO = STATUS_IDS.vencido; // 2
export const STATUS_ID_PAGO = STATUS_IDS.pago; // 8
export const STATUS_ID_CANCELADO = STATUS_IDS.cancelado; // 9

// Nome da situação por id (id→nome) — para exibir/mapear quando só se tem o id.
export const STATUS_NAME_BY_ID: Record<number, (typeof ACCOUNT_STATUSES)[number]> =
  Object.fromEntries(
    (Object.entries(STATUS_IDS) as [(typeof ACCOUNT_STATUSES)[number], number][]).map(
      ([name, id]) => [id, name],
    ),
  );

// Valor monetário: aceita number ou string numérica vinda da REST.
const money = z.coerce.number();

// ── Fornecedor embutido (JOIN via supplier_id) ──────────────────────────────
// Retornado pelo PostgREST quando se usa select=*,supplier(...).
// Campos do cadastro canônico (tabela `supplier`) — fonte de verdade única do
// nome/CNPJ/CPF do fornecedor desde que as colunas denormalizadas foram dropadas.

export const supplierEmbeddedSchema = z.object({
  trade_name: z.string().nullable(),
  legal_name: z.string().nullable(),
  cnpj: z.string().nullable(),
  cpf: z.string().nullable(),
}).nullable();

export type SupplierEmbedded = z.infer<typeof supplierEmbeddedSchema>;

// Empresa pagadora embutida (tabela `company`, via a FK sk_company — migrations 083/084).
// Presente quando o select inclui company(...). Exibida no grid e no card de /consulta.
export const companyEmbeddedSchema = z.object({
  trade_name: z.string().nullable(),
}).nullable();

export type CompanyEmbedded = z.infer<typeof companyEmbeddedSchema>;

// ── Classificação contábil embutida (JOIN via cost_center_id / chart_account_id) ─
// Retornado pelo PostgREST quando o select inclui os aliases
// cost_center:financial_cost_center(...) e chart_account:financial_chart_of_account(...).

export const costCenterEmbeddedSchema = z.object({
  cost_center_code: z.string().nullable(),
  cost_center_description: z.string().nullable(),
}).nullable();

// Plano de contas embutido + sua HIERARQUIA (grupo/subgrupo, embeds aninhados) —
// exibida concatenada na célula "Plano de contas" do grid de /consulta. Os embeds de
// grupo/subgrupo reusam os schemas dos cadastros (chart-account-group/-subgroup) para
// não divergir. group via a FK direta chart_account_group_id (migration 058); subgroup
// via chart_account_subgroup_id.
export const chartAccountEmbeddedSchema = z.object({
  account_code: z.string().nullable(),
  account_description: z.string().nullable(),
  group: chartAccountGroupEmbeddedSchema.optional(),
  subgroup: chartAccountSubgroupEmbeddedSchema.optional(),
}).nullable();

export type CostCenterEmbedded = z.infer<typeof costCenterEmbeddedSchema>;
export type ChartAccountEmbedded = z.infer<typeof chartAccountEmbeddedSchema>;

// ── Dimensão `status` embutida (JOIN via status_id) ─────────────────────────
// Retornada pelo PostgREST quando o select inclui o alias status_dim:status(...).
// FONTE do NOME da situação para exibição — o texto vem da dimensão, não da linha
// (a coluna `status` texto está sendo removida; status_id é a fonte única).
export const statusDimEmbeddedSchema = z
  .object({
    status_name: z.string(),
    status_short_name: z.string().nullable(),
  })
  .nullable();

export type StatusDimEmbedded = z.infer<typeof statusDimEmbeddedSchema>;

// ── Linha completa (leitura) ────────────────────────────────────────────────

export const financialAccountControlSchema = z.object({
  id: z.number().int(),

  // Identificação / deduplicação
  gmail_message_id: z.string().nullable(),
  source_file: z.string().nullable(),

  // Classificação
  document_type: documentTypeSchema.nullable(),
  extraction_source: extractionSourceSchema.nullable(),

  // Fornecedor — referenciado APENAS pela FK sk_supplier (surrogate key snowflake,
  // NOT NULL no banco). supplier_id é chave de negócio e fica só na tabela `supplier`
  // (migration 042). Os dados denormalizados (nome/CNPJ/CPF) foram removidos
  // (migrations 040/041); a fonte de verdade é `supplier`, lida via JOIN (campo `supplier`).
  sk_supplier: z.number().int(),

  // Classificação contábil (FKs para os cadastros — migrations 047/048). NOT NULL
  // DEFAULT 0: "não informado" grava o id 0 (linha-sentinela existente em ambos os
  // cadastros), nunca NULL. cost_center_id → financial_cost_center,
  // chart_account_id → financial_chart_of_account.
  cost_center_id: z.number().int().default(0),
  chart_account_id: z.number().int().default(0),

  // Documento
  invoice_number: z.string().nullable(),
  competence_date: z.string().nullable(), // YYYY-MM
  issue_date: z.string().nullable(), // DATE (ISO)
  due_date: z.string().nullable(), // DATE (ISO)
  // Data em que a conta foi paga (DATE ISO, migration 096). Carimbada pela trigger
  // `trg_fac_payment_date`: preenche com a data corrente ao entrar em status_id 8 (a
  // menos que já venha informada no mesmo comando) e limpa ao sair de 8. Só LEITURA —
  // deliberadamente FORA do .pick() de manualEdit (logo, fora de create/update): quem a
  // grava é a trigger, não o cliente, e `authenticated` não tem grant nesta coluna.
  // ATENÇÃO: nas contas pagas ANTES da 096 o valor é o VENCIMENTO (backfill aproximado)
  // e nas baixas automáticas é o dia do RECONHECIMENTO — ver a ressalva das três
  // semânticas no CLAUDE.md antes de usá-la como caixa realizado.
  payment_date: z.string().nullable(),

  // ── Derivadas (Onda 6) — colunas GERADAS no banco, SÓ LEITURA ───────────────────
  // Todas são `GENERATED ALWAYS AS ... STORED`: o PostgreSQL RECUSA qualquer INSERT/UPDATE
  // que as cite (SQLSTATE 428C9). Por isso estão no .omit() do inputSchema — ali não é
  // higiene, é o que impede um write path futuro de quebrar a gravação. A guarda G1 de
  // tests/test_onda6_campos_derivados.py trava essa correspondência lendo as migrations.

  // Primeiro dia do mês de competência, derivado de competence_date (TEXT 'YYYY-MM',
  // migration 112). NULL quando a competência é nula ou não casa o padrão — hoje ~13% das
  // contas têm competência preenchida. NUNCA cai para due_date: competência é declaração
  // contábil, vencimento é caixa.
  competence_month: z.string().nullable(), // DATE (ISO)

  // payment_date - due_date, em dias (migration 112). NULL enquanto não paga. NEGATIVO é
  // pagamento antecipado — 13 contas na medição de 2026-08-10 — e não deve ser normalizado
  // para zero. NÃO é DPO: nas contas pagas antes da 096 o payment_date veio do backfill
  // (= vencimento) e produz 0 artificial.
  days_late: z.number().int().nullable(),

  // Confiança ORDINAL derivada de extraction_source (migration 112). Texto, nunca número:
  // o eixo é proveniência, não probabilidade calibrada.
  extraction_confidence: extractionConfidenceSchema,

  // Ordinal da parcela e documento-base do carnê (migrations 113/114). NULL quando o
  // invoice_number não é INEQUIVOCAMENTE parcela — 21 dos 40 candidatos da base são
  // nosso-número. NÃO existe "total de parcelas": o total não está na origem; para isso
  // use analytics.parcelamentos(), que devolve o observado e as parcelas faltando.
  installment_number: z.number().int().nullable(),
  installment_base: z.string().nullable(),

  // Financeiro
  amount: money.nullable(),
  currency: z.string().default('BRL'),
  payment_method: paymentMethodSchema.nullable(),
  barcode: z.string().nullable(),
  description: z.string().nullable(),

  // Texto livre escrito pelo USUÁRIO no cadastro de contas (ContaForm) — exibido no
  // card de detalhe de /consulta (migration 064). Distinto de processing_notes
  // (auditoria/pipeline); este nunca é tocado pela extração.
  additional_info: z.string().nullable(),

  // Campos de boleto (NOT NULL DEFAULT 0 no banco)
  nosso_numero: z.string().nullable(),
  discount: money.default(0),
  other_deductions: money.default(0),
  fine_interest: money.default(0),
  other_additions: money.default(0),
  amount_charged: money.default(0),

  // Situação/ciclo de vida — FONTE ÚNICA: status_id (FK → dimensão `status`), NOT NULL
  // DEFAULT 3 ('a vencer'). A antiga coluna `status` (texto) foi REMOVIDA (FASE 3,
  // migration 069); o NOME de exibição vem do embed status_dim.
  status_id: z.number().int(),

  // Flags de curadoria manual (checkbox em /consulta — migration 033).
  // NOT NULL DEFAULT FALSE no banco; editados pelo usuário, não pelo pipeline.
  has_invoice: z.boolean().default(false),
  has_bank_slip: z.boolean().default(false),

  // Pagador (sacado) — sk_company: surrogate key snowflake da empresa pagadora
  // (migration 083; substitui company_id). 1 = OTIMOTEX TECIDOS (default), 2 = LEBIANCO,
  // 3 = OTIMOTEX FARDOS.
  // DUAS origens: no pipeline vem da regra LEBIANCO (referência a "lebianco" no assunto/
  // corpo/anexo/remetente); no CRUD manual é ESCOLHA do usuário (select do ContaForm).
  // O trigger só resolve por payer_cnpj/name quando o valor não vem (migration 084).
  // `nullable` reflete a leitura; na ESCRITA é exigido um id válido (ver manualEdit).
  sk_company: z.number().int().nullable(),
  payer_cnpj: z.string().nullable(),
  payer_name: z.string().nullable(),

  // Remetente do e-mail — alinha supplier.email no trigger (migration 023)
  sender_email: z.string().nullable(),

  // Assunto do e-mail — exibido no card e buscável em /consulta (migration 025)
  subject: z.string().nullable(),

  // Corpo do e-mail (quando extraction_source = 'email_body')
  email_body_excerpt: z.string().nullable(),

  // Auditoria
  processing_notes: z.string().nullable(),
  extracted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  // Autoria (migrations 076/077) — UUIDs carimbados pelo servidor/trigger; nunca vêm do input.
  // created_by = DONO (base da visibilidade por dono); updated_by = último editor;
  // status_changed_by/at = quem/quando mudou a situação.
  created_by: z.string().nullable(),
  updated_by: z.string().nullable(),
  status_changed_by: z.string().nullable(),
  status_changed_at: z.string().nullable(),

  // Fornecedor embutido — presente quando o select inclui supplier(...).
  // Fonte de verdade única para exibição (nome/CNPJ/CPF vêm daqui via JOIN).
  supplier: supplierEmbeddedSchema.optional(),

  // Empresa pagadora embutida — presente quando o select inclui company(...).
  // Fonte do nome exibido (coluna "Empresa" do grid + card de detalhe); a FK é sk_company.
  company: companyEmbeddedSchema.optional(),

  // Classificação contábil embutida — presente quando o select inclui os aliases
  // cost_center:financial_cost_center(...) / chart_account:financial_chart_of_account(...).
  cost_center: costCenterEmbeddedSchema.optional(),
  chart_account: chartAccountEmbeddedSchema.optional(),

  // Dimensão `status` embutida — presente quando o select inclui status_dim:status(...).
  // Fonte do nome da situação para exibição (badge/CSV/detalhe).
  status_dim: statusDimEmbeddedSchema.optional(),

  // Anexos embutidos (1:N — migration 079) — presentes quando o select inclui o alias
  // attachments:financial_account_attachment(...). Reúne as DUAS origens: o documento que
  // veio do e-mail (origin='pipeline', espelha source_file) e os arquivos enviados pelo
  // usuário ('manual'). Só de LEITURA: anexo é gravado pelas rotas dedicadas
  // (/api/contas/:id/attachments), nunca pelo corpo do POST/PATCH da conta.
  attachments: z.array(financialAccountAttachmentEmbeddedSchema).optional(),
});

// ── Entrada (gravação pelo pipeline/API) ────────────────────────────────────
// Omite os campos gerados pelo banco e o recurso embutido `supplier` (leitura).
// `sk_supplier` agora é entrada OBRIGATÓRIA — o pipeline resolve o fornecedor
// (RPC resolve_supplier_for_account, que devolve o surrogate sk_supplier) antes de
// persistir; não há mais trigger de resolução nem colunas denormalizadas (migrations
// 040/041/042).

export const financialAccountControlInputSchema = financialAccountControlSchema.omit({
  id: true,
  // `sk_company` PERMANECE gravável: é a empresa pagadora escolhida pelo usuário no
  // ContaForm (carve-out consciente da S3-2 — as demais colunas de pagador, payer_cnpj/
  // payer_name, e as de pipeline/auditoria seguem fora). No pipeline quem a define é a
  // regra LEBIANCO; o trigger (084) respeita o valor explícito e só resolve quando ausente.
  // A situação é escrita por `status_id` (a coluna `status` texto foi removida — FASE 3).
  // `status_id` PERMANECE no input (entrada de escrita da situação — baixa/cancelamento via PATCH).
  created_at: true,
  updated_at: true,
  // Autoria carimbada pelo servidor/trigger — nunca entra pelo corpo do cliente.
  created_by: true,
  updated_by: true,
  status_changed_by: true,
  status_changed_at: true,
  // Mesma categoria: quem grava payment_date é a trigger trg_fac_payment_date (096),
  // derivando-a de status_id. O .pick() de manualEdit já a deixaria de fora, mas omitir
  // aqui garante que ela siga não-gravável em qualquer write path futuro que use este
  // schema direto. `authenticated` também não tem grant de coluna nela.
  payment_date: true,
  // Derivadas da Onda 6 (migrations 112/114). Aqui o omit NÃO é só higiene: as cinco são
  // colunas GENERATED, e o PostgreSQL RECUSA com 428C9 qualquer INSERT/UPDATE que as cite.
  // O .pick() de manualEdit já as deixaria de fora, mas quem gravar por este schema direto
  // no futuro quebraria a escrita — inclusive a do pipeline.
  competence_month: true,
  days_late: true,
  extraction_confidence: true,
  installment_number: true,
  installment_base: true,
  supplier: true,
  company: true,
  cost_center: true,
  chart_account: true,
  status_dim: true,
  // Anexos entram só pelas rotas dedicadas (/api/contas/:id/attachments) — o embed é de
  // leitura e nunca é gravável pelo corpo da conta (mesma razão de supplier/status_dim).
  attachments: true,
});

// ── Edição MANUAL (base do CRUD — POST/PATCH /api/contas) ────────────────────
// S3-2 (auditoria de segurança): o CRUD manual só expõe os campos do formulário
// (ContaForm) + situação/flags de curadoria. Colunas de PIPELINE/AUDITORIA
// (gmail_message_id, source_file, extraction_source, extracted_at, processing_notes,
// email_body_excerpt, sender_email, subject, payer_cnpj/payer_name, nosso_numero e os
// componentes de boleto) NÃO são graváveis pela API manual — protege a trilha de
// auditoria/dedup. O pipeline Python grava via service_role (REST direto), fora
// destes schemas; o Zod default (strip) descarta silenciosamente campos extras.
// NOTA (não regredir): has_invoice/has_bank_slip NÃO entram aqui de propósito. Elas têm
// `.default(false)` no inputSchema e o `.partial()` do Zod NÃO remove o default — então,
// omitidas no PATCH (o ContaForm não as edita), o parse injetaria `false` e o UPDATE
// APAGARIA a curadoria NF/Boleto. A curadoria é feita EXCLUSIVAMENTE pela rota inline de
// /consulta (setFinancialAccountFlag, REST direto com grants por coluna — migration 033),
// nunca pela Next API. Fora do pick, o Zod as descarta (strip) — o manual CRUD não pode
// tocar NF/Boleto por construção. status_id NÃO tem default Zod, então não é injetado.
const financialAccountControlManualEditSchema = financialAccountControlInputSchema
  .pick({
    sk_supplier: true,
    sk_company: true,
    cost_center_id: true,
    chart_account_id: true,
    invoice_number: true,
    issue_date: true,
    due_date: true,
    amount: true,
    document_type: true,
    payment_method: true,
    barcode: true,
    description: true,
    additional_info: true,
    status_id: true,
  })
  // `sk_company` chega do schema de LEITURA como `nullable` (a coluna é NOT NULL no banco).
  // Na ESCRITA exigimos um id válido: um `null` explícito NÃO daria erro — o trigger da 084
  // o resolveria silenciosamente para OTIMOTEX, ignorando a intenção do cliente. Com o
  // override, `null`/0 vira 422. Não tem `.default()` → o `.partial()` não injeta valor,
  // então omiti-lo num PATCH preserva a empresa atual (mesma garantia do status_id).
  .extend({ sk_company: z.number().int().positive('Empresa inválida') });

// ── Criação manual (CRUD — POST /api/contas) ─────────────────────────────────
// O pipeline de extração pode gravar uma conta sem valor (vira erro 'sem_valor',
// não cria conta — ver read_emails). Já a criação manual via API EXIGE fornecedor
// (sk_supplier) e valor positivo; os demais campos são OPCIONAIS (o banco aplica
// DEFAULT/NULL nas colunas omitidas), para um formulário de lançamento rápido.
// `status_id` é OMITIDO: a conta sempre nasce no default do banco (3 = 'a vencer') e a
// trigger fn_set_status_from_due_date assume 'a vencer'/'vencido' por vencimento — o
// cliente não pode criar uma conta já em estado fechado (pago/cancelado/baixado). A
// baixa/edição de situação é feita depois via PATCH (financialAccountControlUpdateSchema).
export const financialAccountControlCreateSchema = financialAccountControlManualEditSchema
  .omit({ status_id: true })
  .partial()
  .extend({
    sk_supplier: z.number().int(),
    amount: money.positive('O valor deve ser maior que zero'),
  });

// ── Atualização parcial (PATCH /api/contas/:id) ──────────────────────────────
// Todos os campos opcionais; permite alterar a situação por status_id (ex.: cancelar =
// status_id do 'cancelado'). Restrita aos campos de edição manual (S3-2).
export const financialAccountControlUpdateSchema = financialAccountControlManualEditSchema.partial();

export type FinancialAccountControl = z.infer<typeof financialAccountControlSchema>;
export type FinancialAccountControlInput = z.infer<typeof financialAccountControlInputSchema>;
export type FinancialAccountControlCreate = z.infer<typeof financialAccountControlCreateSchema>;
export type FinancialAccountControlUpdate = z.infer<typeof financialAccountControlUpdateSchema>;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type ExtractionSource = (typeof EXTRACTION_SOURCES)[number];
// ts-prune-ignore-next
export type ExtractionConfidence = (typeof EXTRACTION_CONFIDENCES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
