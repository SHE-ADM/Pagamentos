# Prompt de correção — Pipeline Python (robustez / não-regressão)

> Gerado pela revisão pré-produção de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/RELATORIO-CODE-REVIEW.md` §4. As 8 proteções não-regressão estão OK — não regredir.

```xml
<objetivo>
  Uniformizar a abertura de conexão IMAP nos 3 scripts de reprocessamento manual que ainda abrem o socket
  cru (sem timeout/retry), reusando o helper canônico read_emails._connect_imap() — como os outros
  reprocessadores já fazem.
</objetivo>

<read_first>
  - skills/email-reader/scripts/read_emails.py (_connect_imap :3549, _connect_and_search :3566, IMAP_TIMEOUT_SECONDS :3530)
  - scripts/reprocess_ignored_emails.py:133 (padrão CORRETO: R._connect_imap())
  - scripts/backfill_received_at.py:104 (padrão CORRETO)
  - scripts/reprocess_body_emails.py:146 (alvo)
  - scripts/reprocess_link_emails.py:150 (alvo)
  - scripts/reprocess_message.py:116 (alvo)
</read_first>

<achados>
  - [BAIXO] A4-1 — reprocess_body_emails.py:146, reprocess_link_emails.py:150, reprocess_message.py:116 abrem
    imaplib.IMAP4_SSL(host, port) cru, sem timeout=IMAP_TIMEOUT_SECONDS nem retry/backoff. Um fetch que
    estanca trava o reprocessamento manual indefinidamente. (Ferramentas de operador, não o pipeline agendado.)
</achados>

<mudancas_exigidas>
  1. Nos 3 scripts, substituir a abertura crua `mail = imaplib.IMAP4_SSL(host, port)` (+ login) pelo helper
     `mail = R._connect_imap()` (import de read_emails como R já presente nesses scripts — confirmar), idêntico
     ao já feito em reprocess_ignored_emails.py:133. Garantir logout em try/finally (padrão dos demais).
  2. Confirmar que esses scripts continuam usando R._rfc822_from_fetch (não data[0][1] direto) — não regredir.
</mudancas_exigidas>

<restricoes>
  - NÃO tocar em run_reader() nem em nenhuma das 8 proteções não-regressão (todas OK no relatório).
  - NÃO introduzir subprocess de extract_pdf.py (proibido — a extração é in-process).
  - Não alterar a lógica de reprocessamento em si, só a criação do socket IMAP.
</restricoes>

<validacao>
  - py -3 -m pytest tests/ -q
  - py -3 -m vulture server/ skills/ scripts/ --min-confidence 60  (só os 7 FPs de rota Flask)
  - Dry-run de cada script alterado: `py -3 scripts\reprocess_body_emails.py --dry-run` (idem link/message) —
    conexão IMAP abre com timeout e o script roda.
</validacao>

<criterio_de_aceite>
  Os 3 reprocessadores abrem IMAP via R._connect_imap() (timeout + retry), com logout em try/finally. pytest
  verde; nenhuma regressão das 8 proteções. Dry-runs completam sem travar.
</criterio_de_aceite>
```
