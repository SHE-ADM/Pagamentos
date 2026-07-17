import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do client Supabase: cada from() devolve um builder encadeável "thenable"
// que resolve para o próximo resultado da fila (na ordem das chamadas de from()).
type QueryResult = { data?: unknown; count?: number; error?: { code?: string; message: string; details?: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'neq', 'or', 'order', 'range', 'eq', 'is', 'maybeSingle', 'single', 'insert', 'update', 'delete', 'limit']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: null, error: null, count: 0 }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

const { contaService } = await import('./contas');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('contaService.list', () => {
  it('devolve data + total + page + limit', async () => {
    resultQueue.push({ data: [{ id: 2 }, { id: 1 }], count: 2, error: null });
    const r = await contaService.list({ page: 1, limit: 20 });
    expect(r).toEqual({ data: [{ id: 2 }, { id: 1 }], total: 2, page: 1, limit: 20 });
  });

  it('com search resolve sk_supplier e aplica or()', async () => {
    // from() #1 = contas (query base); from() #2 = supplier (supplierSkByTerm).
    resultQueue.push({ data: [{ id: 1 }], count: 1, error: null }); // contas
    resultQueue.push({ data: [{ sk_supplier: 5 }], error: null }); // supplier
    const r = await contaService.list({ search: 'acme' });
    expect(r.total).toBe(1);
    expect(builders[0].or).toHaveBeenCalled(); // builder de contas recebeu o filtro
  });

  it('limita o limit ao máximo de 100', async () => {
    resultQueue.push({ data: [], count: 0, error: null });
    const r = await contaService.list({ limit: 999 });
    expect(r.limit).toBe(100);
  });
});

describe('contaService.getById', () => {
  it('devolve a conta encontrada', async () => {
    resultQueue.push({ data: { id: 5 }, error: null });
    expect(await contaService.getById(5)).toEqual({ id: 5 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(contaService.getById(9)).rejects.toMatchObject({ status: 404 });
  });
});

describe('contaService.create', () => {
  it('cria a conta (sk_supplier + amount obrigatórios)', async () => {
    resultQueue.push({ data: { id: 7, sk_supplier: 1, amount: 100 }, error: null });
    expect(await contaService.create({ sk_supplier: 1, amount: 100 })).toEqual({ id: 7, sk_supplier: 1, amount: 100 });
  });

  it('ignora `status` no corpo do create — conta não nasce em estado fechado', async () => {
    resultQueue.push({ data: { id: 8, sk_supplier: 1, amount: 100 }, error: null });
    await contaService.create({ sk_supplier: 1, amount: 100, status: 'pago' });
    // O schema de criação omite `status`: o campo é descartado antes do insert,
    // então a conta nasce no default do banco ('pendente'), não como 'pago'.
    const insertArg = builders[0].insert.mock.calls[0][0] as Record<string, unknown>;
    expect(insertArg).not.toHaveProperty('status');
  });

  it('422 sem fornecedor (sk_supplier) — não toca o banco', async () => {
    await expect(contaService.create({ amount: 100 })).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('S3-2: descarta colunas de pipeline/auditoria enviadas no corpo do create', async () => {
    resultQueue.push({ data: { id: 11, sk_supplier: 1, amount: 100 }, error: null });
    await contaService.create({
      sk_supplier: 1,
      amount: 100,
      // Campos de pipeline/auditoria que o CRUD manual NÃO deve gravar:
      gmail_message_id: 'forjado',
      extraction_source: 'pdf_text',
      processing_notes: 'injetado',
      sender_email: 'atacante@x.com',
      subject: 'forjado',
      payer_cnpj: '00000000000191',
      nosso_numero: '999',
    });
    const insertArg = builders[0].insert.mock.calls[0][0] as Record<string, unknown>;
    for (const k of ['gmail_message_id', 'extraction_source', 'processing_notes', 'sender_email', 'subject', 'payer_cnpj', 'nosso_numero']) {
      expect(insertArg).not.toHaveProperty(k);
    }
    expect(insertArg).toMatchObject({ sk_supplier: 1, amount: 100 });
  });

  it('grava a EMPRESA escolhida pelo usuário (carve-out da S3-2 — o trigger respeita o valor)', async () => {
    // sk_company é o ÚNICO campo de pagador gravável pelo CRUD manual; payer_cnpj/payer_name
    // seguem bloqueados (teste acima). O trigger da 084 só resolve quando o valor não vem.
    resultQueue.push({ data: { id: 12, sk_supplier: 1, sk_company: 2 }, error: null });
    await contaService.create({ sk_supplier: 1, amount: 100, sk_company: 2 });
    const insertArg = builders[0].insert.mock.calls[0][0] as Record<string, unknown>;
    expect(insertArg).toMatchObject({ sk_company: 2 });
  });

  it('carimba created_by = userId no insert (autoria — visibilidade por dono)', async () => {
    resultQueue.push({ data: { id: 12, sk_supplier: 1, amount: 100 }, error: null });
    await contaService.create({ sk_supplier: 1, amount: 100 }, 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e');
    const insertArg = builders[0].insert.mock.calls[0][0] as Record<string, unknown>;
    expect(insertArg).toMatchObject({ sk_supplier: 1, amount: 100, created_by: 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e' });
  });

  it('sem userId NÃO envia created_by (DEFAULT do banco assume)', async () => {
    resultQueue.push({ data: { id: 13, sk_supplier: 1, amount: 100 }, error: null });
    await contaService.create({ sk_supplier: 1, amount: 100 });
    const insertArg = builders[0].insert.mock.calls[0][0] as Record<string, unknown>;
    expect(insertArg).not.toHaveProperty('created_by');
  });

  it('422 com amount <= 0', async () => {
    await expect(contaService.create({ sk_supplier: 1, amount: 0 })).rejects.toMatchObject({ status: 422 });
  });

  it('409 em violação UNIQUE (23505)', async () => {
    resultQueue.push({ data: null, error: { code: '23505', message: 'duplicate', details: 'barcode' } });
    await expect(contaService.create({ sk_supplier: 1, amount: 100 })).rejects.toMatchObject({ status: 409 });
  });

  it('write-back: grava a classificação no fornecedor quando cost_center_id e chart_account_id > 0', async () => {
    resultQueue.push(
      { data: { id: 7, sk_supplier: 3, cost_center_id: 5, chart_account_id: 10 }, error: null }, // insert conta
      { data: null, error: null }, // update supplier (write-back)
    );
    await contaService.create({ sk_supplier: 3, amount: 100, cost_center_id: 5, chart_account_id: 10 });
    // 2 from(): insert da conta + update do fornecedor.
    expect(fromMock).toHaveBeenCalledTimes(2);
    const supplierBuilder = builders[1];
    expect(supplierBuilder.update).toHaveBeenCalledWith({ cost_center_id: 5, chart_account_id: 10 });
    expect(supplierBuilder.eq).toHaveBeenCalledWith('sk_supplier', 3);
  });

  it('write-back: NÃO grava no fornecedor quando algum id é 0 (sentinela)', async () => {
    resultQueue.push({ data: { id: 8, sk_supplier: 3, cost_center_id: 5, chart_account_id: 0 }, error: null });
    await contaService.create({ sk_supplier: 3, amount: 100, cost_center_id: 5 });
    expect(fromMock).toHaveBeenCalledTimes(1); // só o insert da conta
  });

  it('write-back é best-effort: falha ao gravar no fornecedor não derruba a criação', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resultQueue.push(
      { data: { id: 9, sk_supplier: 3, cost_center_id: 5, chart_account_id: 10 }, error: null }, // insert conta
      { data: null, error: { message: 'boom' } }, // update supplier falha
    );
    const conta = await contaService.create({ sk_supplier: 3, amount: 100, cost_center_id: 5, chart_account_id: 10 });
    expect(conta).toMatchObject({ id: 9 }); // a conta retorna mesmo com falha no write-back
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('contaService.update', () => {
  it('cancela a conta (PATCH status) → 200', async () => {
    resultQueue.push({ data: { id: 5, status: 'cancelado' }, error: null });
    expect(await contaService.update(5, { status: 'cancelado' })).toEqual({ id: 5, status: 'cancelado' });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(contaService.update(9, { status: 'cancelado' })).rejects.toMatchObject({ status: 404 });
  });

  it('carimba updated_by = userId no update (autoria — quem editou)', async () => {
    resultQueue.push({ data: { id: 5, amount: 200 }, error: null });
    await contaService.update(5, { amount: 200 }, 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e');
    const updateArg = builders[0].update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg).toMatchObject({ amount: 200, updated_by: 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e' });
  });

  it('sem userId NÃO envia updated_by (trigger/DEFAULT assume)', async () => {
    resultQueue.push({ data: { id: 5, amount: 200 }, error: null });
    await contaService.update(5, { amount: 200 });
    const updateArg = builders[0].update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg).not.toHaveProperty('updated_by');
  });

  it('422 com document_type fora do enum', async () => {
    await expect(contaService.update(5, { document_type: 'xxx' })).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('S3-2: descarta colunas de pipeline/auditoria enviadas no corpo do PATCH', async () => {
    resultQueue.push({ data: { id: 5, amount: 200 }, error: null });
    await contaService.update(5, {
      amount: 200,
      gmail_message_id: 'forjado',
      extracted_at: '2026-01-01',
      email_body_excerpt: 'injetado',
      processing_notes: 'injetado',
    });
    const updateArg = builders[0].update.mock.calls[0][0] as Record<string, unknown>;
    for (const k of ['gmail_message_id', 'extracted_at', 'email_body_excerpt', 'processing_notes']) {
      expect(updateArg).not.toHaveProperty(k);
    }
    expect(updateArg).toMatchObject({ amount: 200 });
  });

  it('NÃO grava has_invoice/has_bank_slip no PATCH — preserva a curadoria NF/BOL (não regredir)', async () => {
    // Bug: o ContaForm (editar conta) não envia essas flags; o .default(false) + .partial()
    // do Zod injetava `false` e o UPDATE APAGAVA a curadoria (editada por outra rota inline).
    // Agora elas ficam FORA do manualEditSchema → nunca chegam ao UPDATE, mesmo se enviadas.
    resultQueue.push({ data: { id: 5, amount: 200 }, error: null });
    await contaService.update(5, { amount: 200, has_invoice: false, has_bank_slip: false });
    const updateArg = builders[0].update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg).not.toHaveProperty('has_invoice');
    expect(updateArg).not.toHaveProperty('has_bank_slip');
    expect(updateArg).toMatchObject({ amount: 200 });
  });

  it('PATCH sem sk_company NÃO toca a empresa — não há default Zod a injetar (não regredir)', async () => {
    // Espelha o guard de has_invoice acima: `sk_company` entrou no manualEditSchema (o
    // usuário escolhe a empresa), mas NÃO tem `.default()` — então, omitido, o `.partial()`
    // não injeta valor e o UPDATE preserva a empresa atual da conta.
    resultQueue.push({ data: { id: 5, amount: 200 }, error: null });
    await contaService.update(5, { amount: 200 });
    const updateArg = builders[0].update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg).not.toHaveProperty('sk_company');
  });

  it('PATCH grava a empresa escolhida pelo usuário', async () => {
    resultQueue.push({ data: { id: 5, sk_company: 2 }, error: null });
    await contaService.update(5, { sk_company: 2 });
    const updateArg = builders[0].update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg).toMatchObject({ sk_company: 2 });
  });

  it('sk_company null/0 → 422 (o trigger o resolveria em silêncio; o override exige id válido)', async () => {
    await expect(contaService.update(5, { sk_company: null })).rejects.toMatchObject({ status: 422 });
    await expect(contaService.update(5, { sk_company: 0 })).rejects.toMatchObject({ status: 422 });
  });
});

describe('contaService.remove (hard delete)', () => {
  it('devolve o id removido em caso de sucesso', async () => {
    resultQueue.push({ data: { id: 5 }, error: null });
    expect(await contaService.remove(5)).toEqual({ id: 5 });
    expect(builders[0].delete).toHaveBeenCalled();
    expect(builders[0].eq).toHaveBeenCalledWith('id', 5);
  });

  it('404 quando a conta não existe (nada removido)', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(contaService.remove(9)).rejects.toMatchObject({ status: 404 });
  });

  it('409 quando uma FK RESTRICT bloqueia a exclusão (23503)', async () => {
    resultQueue.push({ data: null, error: { code: '23503', message: 'FK violation' } });
    await expect(contaService.remove(5)).rejects.toMatchObject({ status: 409 });
  });

  it('500 em erro inesperado do banco', async () => {
    resultQueue.push({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(contaService.remove(5)).rejects.toMatchObject({ status: 500 });
  });
});
