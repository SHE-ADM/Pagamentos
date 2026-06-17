// src/services/emailReader.ts
// Dispara a leitura de e-mails no backend local (Flask, exposto via proxy /api).
// Modelo assíncrono: POST /start inicia o job em background e responde na hora;
// GET /progress é consultado em poll até concluir. Evita segurar um request HTTP
// por vários minutos (o proxy derrubava a conexão e parecia "travado").

const START_ENDPOINT = '/api/emails/read/start';
const PROGRESS_ENDPOINT = '/api/emails/progress';

const BACKEND_DOWN = 'Backend local indisponível. Inicie o servidor: python server/app.py';

// Resumo retornado por run_reader() (skills/email-reader/scripts/read_emails.py).
// Interno: consumido via ReadProgress.summary (não precisa ser nomeado fora).
interface ReaderSummary {
  imap_user: string;
  supabase_ok: boolean;
  found: number;
  processed: number;
  skipped_keyword: number;
  skipped_dup: number;
  new_subjects: string[];
  dry_run: boolean;
  // true quando o run foi interrompido por indisponibilidade da API Anthropic.
  api_aborted?: boolean;
}

// Snapshot de progresso do job assíncrono (GET /api/emails/progress).
export interface ReadProgress {
  running: boolean;
  phase: string; // idle | iniciando | lendo | concluído | erro
  total: number;
  done: number;
  processed: number;
  skipped_keyword: number;
  skipped_dup: number;
  elapsed: number; // segundos
  summary: ReaderSummary | null; // preenchido ao concluir
  error: string | null; // preenchido ao falhar
}

interface TriggerEmailReadOptions {
  days?: number;
  all?: boolean;
  markSeen?: boolean;
}

/**
 * Inicia a busca IMAP em background. Retorna assim que a thread arranca.
 * `alreadyRunning` indica que já havia um job em andamento (o frontend só
 * precisa começar a fazer poll do progresso).
 */
export async function startEmailRead({
  days = 0,
  all = false,
  markSeen = false,
}: TriggerEmailReadOptions = {}): Promise<{ started: boolean; alreadyRunning: boolean }> {
  let res: Response;
  try {
    res = await fetch(START_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days, all, mark_seen: markSeen }),
    });
  } catch {
    throw new Error(BACKEND_DOWN);
  }

  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    started?: boolean;
    already_running?: boolean;
  };
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Backend retornou HTTP ${res.status}`);
  }
  return { started: Boolean(data.started), alreadyRunning: Boolean(data.already_running) };
}

/** Consulta o progresso atual do job de leitura. */
export async function getEmailReadProgress(): Promise<ReadProgress> {
  let res: Response;
  try {
    res = await fetch(PROGRESS_ENDPOINT);
  } catch {
    throw new Error(BACKEND_DOWN);
  }

  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; progress?: ReadProgress };
  if (!res.ok || !data.ok || !data.progress) {
    throw new Error(data.error || `Backend retornou HTTP ${res.status}`);
  }
  return data.progress;
}
