import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startEmailRead, getEmailReadProgress } from './emailReader';

const fetchMock = vi.fn();

describe('emailReader', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('startEmailRead dispara o job e encaminha days/all/mark_seen', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, started: true }) });

    const r = await startEmailRead({ days: 7 });

    expect(r).toEqual({ started: true, alreadyRunning: false });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/emails/read/start',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ days: 7, all: false, mark_seen: false });
  });

  it('startEmailRead sinaliza already_running', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, started: false, already_running: true }),
    });
    expect(await startEmailRead()).toEqual({ started: false, alreadyRunning: true });
  });

  it('startEmailRead lança mensagem amigável quando o backend está fora', async () => {
    fetchMock.mockRejectedValue(new Error('conn refused'));
    await expect(startEmailRead()).rejects.toThrow(/Backend local indispon/);
  });

  it('getEmailReadProgress retorna o snapshot de progresso', async () => {
    const prog = {
      running: true, phase: 'lendo', total: 10, done: 3,
      processed: 2, skipped_keyword: 1, skipped_dup: 0,
      elapsed: 4.5, summary: null, error: null,
    };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, progress: prog }) });

    expect(await getEmailReadProgress()).toEqual(prog);
    expect(fetchMock).toHaveBeenCalledWith('/api/emails/progress');
  });

  it('getEmailReadProgress lança em resposta inválida', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ ok: false, error: 'boom' }) });
    await expect(getEmailReadProgress()).rejects.toThrow('boom');
  });
});
