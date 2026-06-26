import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// Mock da ponte Python — nenhuma chamada real ao Flask nos testes.
// PythonBridgeError precisa ser uma classe real (a rota usa `instanceof`),
// compartilhada entre o mock e o SUT por vir do mesmo módulo mockado.
vi.mock('@/lib/python-bridge', () => {
  class PythonBridgeError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'PythonBridgeError';
      this.status = status;
    }
  }
  return { triggerReader: vi.fn(), PythonBridgeError };
});

// Mock do guard de auth — por padrão libera (null); um teste força o 401.
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(async () => null) }));

import { POST } from './route';
import { triggerReader, PythonBridgeError } from '@/lib/python-bridge';
import { requireAuth } from '@/lib/auth';
import { fail } from '@/lib/response';

const triggerReaderMock = vi.mocked(triggerReader);
const requireAuthMock = vi.mocked(requireAuth);

// Constrói um NextRequest mínimo: a rota só chama `await req.json()`.
function makeRequest(jsonImpl: () => Promise<unknown>): NextRequest {
  return { json: jsonImpl } as unknown as NextRequest;
}

const sampleSummary = {
  imap_user: 'teste@otimotex.com.br',
  supabase_ok: true,
  found: 5,
  processed: 3,
  skipped_keyword: 1,
  skipped_dup: 1,
  new_subjects: ['Boleto X'],
  dry_run: false,
};

describe('POST /api/emails/read', () => {
  beforeEach(() => {
    triggerReaderMock.mockReset();
    requireAuthMock.mockReset();
    requireAuthMock.mockResolvedValue(null); // por padrão: autenticado
  });

  it('retorna 401 quando não autenticado (requireAuth nega) — não dispara a leitura', async () => {
    requireAuthMock.mockResolvedValue(fail('Autenticação necessária', 401));
    const res = await POST(makeRequest(async () => ({ days: 7 })));
    expect(res.status).toBe(401);
    expect(triggerReaderMock).not.toHaveBeenCalled();
  });

  it('retorna 422 quando o corpo é inválido (days fora de 0–365)', async () => {
    const res = await POST(makeRequest(async () => ({ days: 999 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(triggerReaderMock).not.toHaveBeenCalled();
  });

  it('retorna 200 com o summary no sucesso', async () => {
    triggerReaderMock.mockResolvedValue(sampleSummary);
    const res = await POST(makeRequest(async () => ({ days: 7 })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: sampleSummary });
    expect(triggerReaderMock).toHaveBeenCalledWith({ days: 7 });
  });

  it('mapeia PythonBridgeError para o status correspondente (502)', async () => {
    triggerReaderMock.mockRejectedValue(new PythonBridgeError('IMAP falhou', 502));
    const res = await POST(makeRequest(async () => ({})));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'IMAP falhou' });
  });

  it('corpo não-JSON é tratado como vazio e dispara a leitura', async () => {
    triggerReaderMock.mockResolvedValue(sampleSummary);
    const res = await POST(makeRequest(async () => {
      throw new Error('invalid json');
    }));
    expect(res.status).toBe(200);
    expect(triggerReaderMock).toHaveBeenCalledWith({});
  });
});
