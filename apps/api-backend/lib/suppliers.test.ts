import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supplierCreateSchema, supplierUpdateSchema } from '@sheild/shared/schemas';

// Mock do client Supabase: cada from() devolve um builder encadeável e "thenable"
// que resolve para o próximo resultado da fila (resultQueue), na ordem das chamadas.
type QueryResult = { data?: unknown; count?: number; error?: { code?: string; message: string; details?: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'is', 'or', 'order', 'range', 'eq', 'insert', 'update', 'maybeSingle', 'single']) {
    b[m] = vi.fn(() => b);
  }
  // Torna o builder aguardável: await <chain> resolve o resultado pré-configurado.
  b.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: null, error: null, count: 0 }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

// Validação do par de classificação DEFAULT mockada (tem teste próprio em classification.test.ts).
vi.mock('./classification', () => ({ checkClassificationPair: vi.fn() }));
import { checkClassificationPair } from './classification';

const { supplierService } = await import('./suppliers');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
  vi.mocked(checkClassificationPair).mockReset();
  vi.mocked(checkClassificationPair).mockResolvedValue(null);
});

describe('supplierService.list', () => {
  it('devolve data + total + page + limit', async () => {
    resultQueue.push({ data: [{ sk_supplier: 2 }, { sk_supplier: 1 }], count: 2, error: null });
    const r = await supplierService.list({ page: 1, limit: 20 });
    expect(r).toEqual({ data: [{ sk_supplier: 2 }, { sk_supplier: 1 }], total: 2, page: 1, limit: 20 });
  });

  it('aplica filtro or() quando há search', async () => {
    resultQueue.push({ data: [], count: 0, error: null });
    await supplierService.list({ search: 'acme' });
    expect(builders[0].or).toHaveBeenCalled();
  });

  it('limita o limit ao máximo de 100', async () => {
    resultQueue.push({ data: [], count: 0, error: null });
    const r = await supplierService.list({ limit: 999 });
    expect(r.limit).toBe(100);
  });
});

describe('supplierService.getBySk', () => {
  it('devolve o fornecedor encontrado', async () => {
    resultQueue.push({ data: { sk_supplier: 5 }, error: null });
    expect(await supplierService.getBySk(5)).toEqual({ sk_supplier: 5 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(supplierService.getBySk(9)).rejects.toMatchObject({ status: 404 });
  });
});

describe('supplierService.create', () => {
  it('devolve o fornecedor criado', async () => {
    resultQueue.push({ data: { sk_supplier: 7, trade_name: 'ACME' }, error: null });
    expect(await supplierService.create({ trade_name: 'ACME' })).toEqual({ sk_supplier: 7, trade_name: 'ACME' });
  });

  it('409 em CNPJ duplicado (23505)', async () => {
    resultQueue.push({
      data: null,
      error: { code: '23505', message: 'duplicate', details: 'Key (cnpj)=(12345678000199) already exists' },
    });
    await expect(supplierService.create({ cnpj: '12345678000199' })).rejects.toMatchObject({ status: 409 });
  });

  it('422 sem identificador (Zod) — não toca o banco', async () => {
    await expect(supplierService.create({})).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('422 quando o par de classificação default é inválido — não chega ao insert', async () => {
    vi.mocked(checkClassificationPair).mockResolvedValueOnce('Informe o centro de custo e o plano de contas juntos.');
    await expect(
      supplierService.create({ trade_name: 'ACME', cost_center_id: 5, chart_account_id: 0 }),
    ).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('supplierService.update', () => {
  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(supplierService.update(9, { trade_name: 'X' })).rejects.toMatchObject({ status: 404 });
  });

  it('422 quando o par de classificação é inválido no PATCH — não chega ao update', async () => {
    vi.mocked(checkClassificationPair).mockResolvedValueOnce('O centro de custo informado não pertence ao plano de contas selecionado.');
    await expect(supplierService.update(5, { cost_center_id: 5, chart_account_id: 10 })).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('PATCH sem classificação NÃO valida o par', async () => {
    resultQueue.push({ data: { sk_supplier: 5, trade_name: 'X' }, error: null });
    await supplierService.update(5, { trade_name: 'X' });
    expect(vi.mocked(checkClassificationPair)).not.toHaveBeenCalled();
  });
});

describe('supplierService.remove', () => {
  it('409 quando há contas vinculadas', async () => {
    resultQueue.push({ data: { sk_supplier: 5 }, error: null }); // findBySk
    resultQueue.push({ count: 3, error: null }); // countLinkedAccounts
    await expect(supplierService.remove(5, 'NOW')).rejects.toMatchObject({ status: 409 });
  });

  it('soft delete quando não há contas vinculadas', async () => {
    resultQueue.push({ data: { sk_supplier: 5 }, error: null }); // findBySk
    resultQueue.push({ count: 0, error: null }); // countLinkedAccounts
    resultQueue.push({ data: { sk_supplier: 5, deleted_at: 'NOW' }, error: null }); // softDelete
    expect(await supplierService.remove(5, 'NOW')).toEqual({ sk_supplier: 5 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(supplierService.remove(9, 'NOW')).rejects.toMatchObject({ status: 404 });
  });
});

describe('supplierCreateSchema / supplierUpdateSchema', () => {
  it('strip de máscara no CNPJ → 14 dígitos', () => {
    const r = supplierCreateSchema.safeParse({ cnpj: '12.345.678/0001-99' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cnpj).toBe('12345678000199');
  });

  it('CNPJ de tamanho errado após strip → falha', () => {
    expect(supplierCreateSchema.safeParse({ cnpj: '123' }).success).toBe(false);
  });

  it('sem nenhum identificador → falha', () => {
    expect(supplierCreateSchema.safeParse({}).success).toBe(false);
  });

  it('update vazio (todos opcionais) → ok', () => {
    expect(supplierUpdateSchema.safeParse({}).success).toBe(true);
  });

  it('aceita a classificação contábil (cost_center_id / chart_account_id)', () => {
    const r = supplierUpdateSchema.safeParse({ cost_center_id: 5, chart_account_id: 9 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.cost_center_id).toBe(5);
      expect(r.data.chart_account_id).toBe(9);
    }
  });

  it('aceita 0 (sentinela "não informado") na classificação', () => {
    const r = supplierCreateSchema.safeParse({ trade_name: 'ACME', cost_center_id: 0, chart_account_id: 0 });
    expect(r.success).toBe(true);
  });

  it('rejeita classificação negativa', () => {
    expect(supplierUpdateSchema.safeParse({ cost_center_id: -1 }).success).toBe(false);
  });

  it('strip de máscara no telefone/WhatsApp → só dígitos', () => {
    const r = supplierUpdateSchema.safeParse({
      phone_ddd1: '(11)', phone1: '99999-9999', whatsapp1: '(11) 98888-7777',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.phone_ddd1).toBe('11');
      expect(r.data.phone1).toBe('999999999');
      expect(r.data.whatsapp1).toBe('11988887777');
    }
  });

  it('aceita chave PIX (e-mail/UUID) sem strip', () => {
    const r = supplierUpdateSchema.safeParse({ pix_key1: 'financeiro@acme.com.br' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.pix_key1).toBe('financeiro@acme.com.br');
  });

  it('rejeita telefone com dígitos demais', () => {
    expect(supplierUpdateSchema.safeParse({ phone1: '1234567890' }).success).toBe(false);
  });
});
