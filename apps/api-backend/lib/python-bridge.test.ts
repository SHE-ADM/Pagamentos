import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { triggerReader, probePythonHealth, PythonBridgeError } from './python-bridge';

const fetchMock = vi.fn();

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

describe('python-bridge', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('triggerReader retorna o summary em caso de sucesso', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, summary: sampleSummary }),
    });

    const summary = await triggerReader({ days: 7 });

    expect(summary.processed).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/emails/read',
      expect.objectContaining({ method: 'POST' }),
    );
    // O corpo encaminha days e mapeia markSeen -> mark_seen.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ days: 7, mark_seen: false });
  });

  it('mapeia falha do Flask (5xx) para PythonBridgeError 502', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'IMAP falhou' }),
    });

    await expect(triggerReader()).rejects.toMatchObject({
      name: 'PythonBridgeError',
      status: 502,
      message: 'IMAP falhou',
    });
  });

  it('lança PythonBridgeError 502 quando o serviço está indisponível', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const err = await triggerReader().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PythonBridgeError);
    expect((err as PythonBridgeError).status).toBe(502);
  });

  it('probePythonHealth retorna true/false conforme a disponibilidade', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect(await probePythonHealth()).toBe(true);

    fetchMock.mockRejectedValue(new Error('down'));
    expect(await probePythonHealth()).toBe(false);
  });
});
