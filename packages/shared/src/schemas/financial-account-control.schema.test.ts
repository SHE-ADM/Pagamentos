import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_TYPES,
  EXTRACTION_CONFIDENCES,
  extractionConfidenceSchema,
  financialAccountControlCreateSchema,
  financialAccountControlInputSchema,
  financialAccountControlUpdateSchema,
  STATUS_ID_A_VENCER,
  STATUS_ID_CANCELADO,
  STATUS_NAME_BY_ID,
} from './financial-account-control.schema';

/**
 * Contrato de ESCRITA de conta a pagar.
 *
 * Este pacote é a fonte de verdade única entre a Next API e os dois frontends, e até aqui não
 * tinha teste nenhum: `typecheck` prova que os TIPOS casam, não que o schema DESCARTA o que
 * precisa descartar. A diferença importa porque os invariantes abaixo falham em SILÊNCIO —
 * nenhum deles produz erro de compilação, e o sintoma aparece como dado errado no banco.
 *
 * Cada bloco corresponde a um invariante 🔴 do CLAUDE.md.
 */

// As 5 colunas GENERATED da Onda 6 (migrations 112/114).
const COLUNAS_GERADAS = [
  'competence_month',
  'days_late',
  'extraction_confidence',
  'installment_number',
  'installment_base',
] as const;

// Colunas escritas pelo PIPELINE ou pelo servidor — nunca pelo cliente (achado S3-2).
const COLUNAS_NAO_CLIENTE = [
  'gmail_message_id',
  'source_file',
  'extraction_source',
  'extracted_at',
  'processing_notes',
  'email_body_excerpt',
  'sender_email',
  'subject',
  'payer_cnpj',
  'payer_name',
  'nosso_numero',
  'created_by',
  'updated_by',
  'status_changed_by',
  'payment_date',
] as const;

const CONTA_MINIMA = { sk_supplier: 1, amount: 10 };

describe('colunas GERADAS nunca chegam ao banco (SQLSTATE 428C9)', () => {
  // O PostgreSQL RECUSA qualquer INSERT/UPDATE que CITE uma coluna gerada. Não é "o valor é
  // ignorado": é o comando inteiro falhando. Se uma delas escapasse do schema, a gravação
  // quebraria — inclusive a do pipeline.
  it('o create descarta as 5', () => {
    const out = financialAccountControlCreateSchema.parse({
      ...CONTA_MINIMA,
      competence_month: '2026-08-01',
      days_late: 5,
      extraction_confidence: 'alta',
      installment_number: 2,
      installment_base: '962148',
    });
    for (const coluna of COLUNAS_GERADAS) {
      expect(out, `'${coluna}' sobreviveu ao create`).not.toHaveProperty(coluna);
    }
  });

  it('o update descarta as 5', () => {
    const out = financialAccountControlUpdateSchema.parse(
      Object.fromEntries(COLUNAS_GERADAS.map((c) => [c, 'x'])),
    );
    for (const coluna of COLUNAS_GERADAS) {
      expect(out, `'${coluna}' sobreviveu ao update`).not.toHaveProperty(coluna);
    }
  });

  it('o inputSchema não as tem na FORMA — é o que protege um write path FUTURO', () => {
    // 🔴 Guarda distinta das duas acima, e não é redundância: create/update derivam de um
    // `.pick()`, que já as excluiria mesmo se o `.omit()` do inputSchema sumisse. Quem depende do
    // omit é quem gravar por `financialAccountControlInputSchema` direto — inclusive o pipeline.
    // Sem este caso, apagar uma entrada do omit passa com a suíte verde.
    //
    // Olha a FORMA, não um parse: o inputSchema tem dezenas de campos obrigatórios (é o contrato
    // do pipeline), então montar um payload válido só para provar uma ausência seria frágil — e
    // qualquer campo novo obrigatório quebraria o teste por um motivo que não é o dele.
    const campos = Object.keys(financialAccountControlInputSchema.shape);
    expect(campos.length, 'a forma do inputSchema veio vazia (o parser do teste quebrou?)').toBeGreaterThan(10);
    for (const coluna of COLUNAS_GERADAS) {
      expect(campos, `'${coluna}' saiu do .omit() — o INSERT quebraria com 428C9`).not.toContain(coluna);
    }
  });
});

describe('curadoria NF/Boleto não pode ser apagada por um PATCH que a omite', () => {
  // 🔴 O bug real: has_invoice/has_bank_slip têm `.default(false)` no inputSchema, e o
  // `.partial()` do Zod NÃO remove default. Se estivessem no `.pick()` do manualEdit, um PATCH
  // do ContaForm (que não edita essas flags) injetaria `false` e APAGARIA a curadoria feita a
  // mão em /consulta. Ficarem FORA do pick é o que torna isso impossível por construção.
  it('o update não injeta as flags quando elas são omitidas', () => {
    const out = financialAccountControlUpdateSchema.parse({ amount: 99 });
    expect(out).not.toHaveProperty('has_invoice');
    expect(out).not.toHaveProperty('has_bank_slip');
  });

  it('o update descarta as flags mesmo quando o cliente as envia', () => {
    const out = financialAccountControlUpdateSchema.parse({
      amount: 99,
      has_invoice: true,
      has_bank_slip: true,
    });
    expect(out).not.toHaveProperty('has_invoice');
    expect(out).not.toHaveProperty('has_bank_slip');
  });

  it('o create também não as aceita — nascem no DEFAULT FALSE do banco', () => {
    const out = financialAccountControlCreateSchema.parse({
      ...CONTA_MINIMA,
      has_invoice: true,
      has_bank_slip: true,
    });
    expect(out).not.toHaveProperty('has_invoice');
    expect(out).not.toHaveProperty('has_bank_slip');
  });
});

describe('mass assignment: colunas de pipeline e auditoria não são graváveis (S3-2)', () => {
  it('o create descarta todas elas', () => {
    const out = financialAccountControlCreateSchema.parse({
      ...CONTA_MINIMA,
      ...Object.fromEntries(COLUNAS_NAO_CLIENTE.map((c) => [c, 'forjado'])),
    });
    for (const coluna of COLUNAS_NAO_CLIENTE) {
      expect(out, `'${coluna}' virou gravável — trilha de auditoria/dedup comprometida`).not.toHaveProperty(coluna);
    }
  });

  it('o update descarta todas elas', () => {
    const out = financialAccountControlUpdateSchema.parse(
      Object.fromEntries(COLUNAS_NAO_CLIENTE.map((c) => [c, 'forjado'])),
    );
    for (const coluna of COLUNAS_NAO_CLIENTE) {
      expect(out, `'${coluna}' virou gravável no PATCH`).not.toHaveProperty(coluna);
    }
  });
});

describe('sk_company — o carve-out consciente da S3-2', () => {
  // A empresa pagadora é escolha do usuário no ContaForm. Ela chega do schema de LEITURA como
  // nullable (a coluna é NOT NULL no banco), então o override exige id positivo: um `null` não
  // daria erro e o trigger da 084 o resolveria SILENCIOSAMENTE para OTIMOTEX, ignorando a
  // intenção do cliente.
  it('rejeita null explícito', () => {
    expect(
      financialAccountControlCreateSchema.safeParse({ ...CONTA_MINIMA, sk_company: null }).success,
    ).toBe(false);
  });

  it('rejeita 0 (não existe empresa 0)', () => {
    expect(
      financialAccountControlCreateSchema.safeParse({ ...CONTA_MINIMA, sk_company: 0 }).success,
    ).toBe(false);
  });

  it('aceita um id positivo', () => {
    const out = financialAccountControlCreateSchema.parse({ ...CONTA_MINIMA, sk_company: 2 });
    expect(out.sk_company).toBe(2);
  });

  it('omiti-lo num PATCH preserva a empresa atual — não há default injetado', () => {
    // Se `sk_company` ganhasse `.default()`, todo PATCH passaria a reescrever a empresa.
    const out = financialAccountControlUpdateSchema.parse({ amount: 1 });
    expect(out).not.toHaveProperty('sk_company');
  });
});

describe('valor e situação na criação', () => {
  it('exige amount maior que zero', () => {
    expect(financialAccountControlCreateSchema.safeParse({ sk_supplier: 1, amount: 0 }).success).toBe(false);
    expect(financialAccountControlCreateSchema.safeParse({ sk_supplier: 1, amount: -5 }).success).toBe(false);
  });

  it('exige amount e sk_supplier', () => {
    expect(financialAccountControlCreateSchema.safeParse({ sk_supplier: 1 }).success).toBe(false);
    expect(financialAccountControlCreateSchema.safeParse({ amount: 10 }).success).toBe(false);
  });

  it('coage valor vindo como string (formulário HTML devolve texto)', () => {
    const out = financialAccountControlCreateSchema.parse({ sk_supplier: 1, amount: '1234.56' });
    expect(out.amount).toBe(1234.56);
  });

  it('NÃO aceita status_id — a conta nasce no default do banco (3 = a vencer)', () => {
    // O cliente não pode criar uma conta já em estado fechado (pago/cancelado/baixado).
    const out = financialAccountControlCreateSchema.parse({
      ...CONTA_MINIMA,
      status_id: STATUS_ID_CANCELADO,
    });
    expect(out).not.toHaveProperty('status_id');
  });

  it('o update aceita status_id (é por ele que se dá baixa ou cancela)', () => {
    const out = financialAccountControlUpdateSchema.parse({ status_id: STATUS_ID_CANCELADO });
    expect(out.status_id).toBe(STATUS_ID_CANCELADO);
  });

  it('o update não injeta status_id quando ele é omitido', () => {
    // Com default, todo PATCH reabriria/fecharia a conta sem ninguém pedir.
    expect(financialAccountControlUpdateSchema.parse({ amount: 1 })).not.toHaveProperty('status_id');
  });
});

describe('domínios que espelham CHECK do banco', () => {
  it('`pix` NÃO é tipo de documento — é forma de pagamento (migration 075)', () => {
    expect(DOCUMENT_TYPES).not.toContain('pix');
  });

  it('a confiança da extração é textual, nunca numérica', () => {
    // Um 0.85 sugeriria uma calibração que ninguém mediu e convidaria a tirar média.
    for (const valor of EXTRACTION_CONFIDENCES) {
      expect(Number.isNaN(Number(valor)), `'${valor}' parece número`).toBe(true);
    }
    expect(extractionConfidenceSchema.safeParse(0.85).success).toBe(false);
    expect(extractionConfidenceSchema.safeParse('alta').success).toBe(true);
  });

  it('cobre os dois casos que NÃO vêm de extraction_source', () => {
    // `manual` = extraction_source NULL (digitado no CRUD); `desconhecida` = o ELSE do CASE da
    // migration 112. Sem eles a coluna gerada deixaria de ser total.
    expect(EXTRACTION_CONFIDENCES).toContain('manual');
    expect(EXTRACTION_CONFIDENCES).toContain('desconhecida');
  });

  it('STATUS_NAME_BY_ID resolve os ids usados como constante', () => {
    expect(STATUS_NAME_BY_ID[STATUS_ID_A_VENCER]).toBe('a vencer');
    expect(STATUS_NAME_BY_ID[STATUS_ID_CANCELADO]).toBe('cancelado');
  });
});
