// src/services/emailReader.ts
// Dispara a leitura de e-mails no backend local (Flask, exposto via proxy /api).

const READ_ENDPOINT = '/api/emails/read';

// Resumo retornado por run_reader() (skills/email-reader/scripts/read_emails.py).
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

export interface TriggerEmailReadOptions {
  days?: number;
  all?: boolean;
  markSeen?: boolean;
}

interface ReadEndpointResponse {
  ok?: boolean;
  error?: string;
  summary?: ReaderSummary;
}

/**
 * Aciona a busca IMAP no backend.
 *
 * Exemplo:
 *   const summary = await triggerEmailRead({ days: 7 })
 *   console.log(summary.processed) // → 3
 */
export async function triggerEmailRead({
  days = 0,
  all = false,
  markSeen = false,
}: TriggerEmailReadOptions = {}): Promise<ReaderSummary> {
  let res: Response;
  try {
    res = await fetch(READ_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days, all, mark_seen: markSeen }),
    });
  } catch {
    // Falha de rede normalmente = backend Flask não está rodando.
    throw new Error('Backend local indisponível. Inicie o servidor: python server/app.py');
  }

  const data = (await res.json().catch(() => ({}))) as ReadEndpointResponse;
  if (!res.ok || !data.ok || !data.summary) {
    throw new Error(data.error || `Backend retornou HTTP ${res.status}`);
  }
  return data.summary;
}
