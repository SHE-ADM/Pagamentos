// lib/python-bridge.ts
// Ponte para o serviço Python interno (Flask, server/app.py), que expõe a
// leitura IMAP via run_reader(). A API Next encaminha por HTTP em vez de
// spawnar Python — preserva a lógica única de run_reader() e evita problemas
// de descoberta de interpretador no Windows.

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000';

// S3-1: um Flask travado (IMAP pendurado) não pode pendurar o handler Next junto —
// o fetch é abortado no teto e vira 504. A leitura síncrona LEGÍTIMA demora minutos
// (IMAP + extração), então o teto é generoso e configurável; o probe de health, curto.
const BRIDGE_TIMEOUT_MS = Number(process.env.PYTHON_BRIDGE_TIMEOUT_MS ?? 300_000);
const HEALTH_TIMEOUT_MS = 5_000;

const isTimeoutError = (e: unknown): boolean => e instanceof Error && e.name === 'TimeoutError';

// Resumo retornado por run_reader() (skills/email-reader/scripts/read_emails.py).
// Tipo público (retorno de triggerReader) — consumido via inferência.
// ts-prune-ignore-next
export interface ReaderSummary {
  imap_user: string;
  supabase_ok: boolean;
  found: number;
  processed: number;
  skipped_keyword: number;
  skipped_dup: number;
  new_subjects: string[];
  dry_run: boolean;
}

// ts-prune-ignore-next
export interface TriggerReaderOptions {
  days?: number;
  markSeen?: boolean;
}

interface FlaskReadResponse {
  ok?: boolean;
  error?: string;
  summary?: ReaderSummary;
}

// Erro de domínio da ponte — carrega o status HTTP a propagar ao cliente.
export class PythonBridgeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PythonBridgeError';
  }
}

export async function triggerReader({ days = 0, markSeen = false }: TriggerReaderOptions = {}): Promise<ReaderSummary> {
  let res: Response;
  try {
    res = await fetch(`${PYTHON_SERVICE_URL}/api/emails/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days, mark_seen: markSeen }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      throw new PythonBridgeError('Serviço Python não respondeu dentro do tempo limite.', 504);
    }
    throw new PythonBridgeError('Serviço Python indisponível. Inicie o backend: python server/app.py', 502);
  }

  const data = (await res.json().catch(() => ({}))) as FlaskReadResponse;
  if (!res.ok || !data.ok || !data.summary) {
    throw new PythonBridgeError(data.error || `Serviço Python retornou HTTP ${res.status}`, res.status >= 500 ? 502 : 400);
  }
  return data.summary;
}

export async function probePythonHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${PYTHON_SERVICE_URL}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
