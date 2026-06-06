// src/services/emailReader.js
// Dispara a leitura de e-mails no backend local (Flask, exposto via proxy /api).

const READ_ENDPOINT = '/api/emails/read'

/**
 * Aciona a busca IMAP no backend.
 * @param {object}  opts
 * @param {number}  opts.days      - últimos N dias (0 = apenas não lidos).
 * @param {boolean} opts.markSeen  - marcar como lidos após processar.
 * @returns {Promise<object>} resumo da execução (processed, found, etc.).
 *
 * Exemplo:
 *   const summary = await triggerEmailRead({ days: 7 })
 *   console.log(summary.processed) // → 3
 */
export async function triggerEmailRead({ days = 0, markSeen = false } = {}) {
  let res
  try {
    res = await fetch(READ_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ days, mark_seen: markSeen }),
    })
  } catch {
    // Falha de rede normalmente = backend Flask não está rodando.
    throw new Error(
      'Backend local indisponível. Inicie o servidor: python server/app.py'
    )
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Backend retornou HTTP ${res.status}`)
  }
  return data.summary
}
