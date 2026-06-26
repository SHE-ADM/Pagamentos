import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/banks', () => {
  class BankServiceError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  }
  return { bankService: { getById: vi.fn(), update: vi.fn(), remove: vi.fn() }, BankServiceError };
});

import { GET, PATCH, DELETE } from './route';
import { requireAuth } from '@/lib/auth';
import { bankService, BankServiceError } from '@/lib/banks';

const requireAuthMock = vi.mocked(requireAuth);
const getByIdMock = vi.mocked(bankService.getById);
const updateMock = vi.mocked(bankService.update);
const removeMock = vi.mocked(bankService.remove);

const req = () => ({}) as unknown as NextRequest;
const jsonReq = (json: () => Promise<unknown>) => ({ json }) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  getByIdMock.mockReset();
  updateMock.mockReset();
  removeMock.mockReset();
});

describe('/api/banks/:id', () => {
  it('GET 400 para id inválido (0)', async () => {
    expect((await GET(req(), ctx('0'))).status).toBe(400);
    expect(getByIdMock).not.toHaveBeenCalled();
  });

  it('GET 200 encontrado', async () => {
    getByIdMock.mockResolvedValue({ bank_id: 5, bank_code: '001', bank_name: 'BB' });
    expect((await GET(req(), ctx('5'))).status).toBe(200);
  });

  it('PATCH 200 no sucesso', async () => {
    updateMock.mockResolvedValue({ bank_id: 5, bank_code: '001', bank_name: 'Novo' });
    expect((await PATCH(jsonReq(async () => ({ bank_name: 'Novo' })), ctx('5'))).status).toBe(200);
  });

  it('DELETE 409 quando em uso', async () => {
    removeMock.mockRejectedValue(new BankServiceError('Banco em uso e não pode ser excluído', 409));
    expect((await DELETE(req(), ctx('5'))).status).toBe(409);
  });

  it('DELETE 200 no sucesso', async () => {
    removeMock.mockResolvedValue({ bank_id: 5 });
    expect((await DELETE(req(), ctx('5'))).status).toBe(200);
  });
});
