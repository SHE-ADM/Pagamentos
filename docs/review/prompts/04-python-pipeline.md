# Prompt de correção — Pipeline Python (robustez / não-regressão)

> Rodar na raiz do monorepo `pagamentos`, branch `Features`. Base: `docs/review/RELATORIO-CODE-REVIEW.md` §4.
> Escopo: `server/`, `skills/`, `scripts/`. Endurecer fechamento de conexão sem regredir as 8 proteções.

```xml
<objetivo>
  Tornar o fechamento da conexão IMAP do run principal à prova de exceção (try/finally) e harmonizar os scripts
  manuais de reprocess com o parse robusto de FETCH, sem regredir NENHUMA das 8 proteções de robustez. Manter pytest verde.
</objetivo>

<read_first>
  - CLAUDE.md (seção "Robustez da leitura e da extração (não regredir)"; exit code da cobrança)
  - skills/email-reader/scripts/read_emails.py (run_reader:2366-2457, mail.logout:2457; _rfc822_from_fetch:2058-2071)
  - scripts/reprocess_link_emails.py (md[0][1] direto:117; logout fora de finally:148)
  - scripts/reprocess_body_emails.py (md[0][1] direto:59; logout:132)
  - scripts/reprocess_ignored_emails.py (try/finally de referência:137-141)
  - skills/cobranca-vencidos/scripts/email_sender.py (catch de queda:174-179 — referência, NÃO mexer)
  - tests/test_rfc822_fetch.py, tests/test_imap_timeout.py, tests/test_imap_retry.py, tests/test_status_for_result.py
</read_first>

<achados>
  - MÉDIO  mail.logout() fora de finally em run_reader — read_emails.py:2366-2457 (conexão IMAP não fechada se exceção não-ApiUnavailableError escapar).
  - BAIXO  md[0][1] direto nos scripts manuais — reprocess_link_emails.py:117, reprocess_body_emails.py:59 (mesma classe que _rfc822_from_fetch resolve).
  - BAIXO  logout fora de finally nesses scripts — reprocess_link_emails.py:148, reprocess_body_emails.py:132.
</achados>

<mudancas_exigidas>
  1. run_reader: envolver o uso da conexão IMAP em try/finally garantindo mail.logout() no finally (espelhar o padrão de
     reprocess_ignored_emails.py:137-141). NÃO alterar a semântica de break em ApiUnavailableError nem o callback on_progress.
  2. Scripts de reprocess (manuais): trocar `md[0][1]` por _rfc822_from_fetch (import do módulo read_emails, já no sys.path)
     e colocar o logout em finally. São ferramentas offline — mudança conservadora, sem alterar a lógica de reprocessamento.
  3. Adicionar/ajustar teste cobrindo o fechamento em caminho de erro do run_reader (mock que faz o loop levantar; asserir
     que logout foi chamado). Não exigir rede.
</mudancas_exigidas>

<restricoes>
  - NÃO regredir as 8 proteções: extração IN-PROCESS (proibido subprocess.run([... extract_pdf.py])), IMAP timeout+retry,
    Claude API timeout (3 clients), _rfc822_from_fetch, dedup message_id, dedup sk_supplier + _finalize_supplier antes do INSERT,
    bloqueio de domínio interno (guarda SQL).
  - NÃO mexer no catch de queda do SMTP (email_sender.py:174 usa (SMTPServerDisconnected, ConnectionError, TimeoutError), NUNCA OSError).
  - NÃO mexer no exit code da cobrança (DADO não reprova, OPERACIONAL reprova — run.py:81-93/346/354).
  - Falsos positivos (não "corrigir"): 7 rotas Flask do vulture; except silenciosos cosméticos (reconfigure stdout, decode MIME, close()).
</restricoes>

<validacao>
  - py -3 -m pytest tests/ -q
  - py -3 -m vulture server/ skills/ scripts/ --min-confidence 60   (não deve surgir achado novo)
  - py -3 skills\cobranca-vencidos\scripts\run.py --dry-run         (valida imports + Firebird, sem enviar e-mail)
  - npm run lint / typecheck / test / prune   (não devem ser afetados — confirmar)
</validacao>

<criterio_de_aceite>
  - pytest verde (incl. novo teste de fechamento em erro).
  - run_reader fecha o IMAP mesmo em caminho de exceção.
  - Scripts de reprocess usam o parse robusto e fecham conexão em finally.
  - Nenhuma das 8 proteções regrediu; vulture sem achado novo.
</criterio_de_aceite>
```
