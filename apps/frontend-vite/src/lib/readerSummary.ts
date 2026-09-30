// src/lib/readerSummary.ts
// Aviso da leitura de e-mails quando a API de extração (Anthropic) recusou no meio do run.
//
// O run NÃO é interrompido (read_emails.run_reader, desde 2026-09-29): os e-mails
// financeiros ficam ADIADOS — sem registro, voltam sozinhos na próxima leitura — e os
// demais seguem registrados. A frase antiga ("Processamento interrompido… rode novamente
// para continuar") descrevia o `break` de antes e mandava o usuário repetir à mão o que a
// próxima execução já faz.

interface ApiDeferralSummary {
  api_aborted?: boolean;
  deferred?: number;
}

/** Sufixo do aviso de leitura concluída; vazio quando a API respondeu normalmente. */
export function apiDeferralNotice(summary: ApiDeferralSummary): string {
  if (!summary.api_aborted) return '';
  // `deferred` ausente = backend anterior ao campo: aviso sem número, nunca "0 adiados".
  const { deferred } = summary;
  const adiados =
    typeof deferred === 'number' && deferred > 0
      ? `${deferred} e-mail(s) financeiro(s) adiado(s)`
      : 'e-mails financeiros adiados';
  return ` ⚠️ API de extração indisponível: ${adiados} — serão lidos na próxima execução; os demais foram registrados.`;
}
