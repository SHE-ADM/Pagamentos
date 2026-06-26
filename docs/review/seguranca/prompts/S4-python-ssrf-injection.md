# S4 — Pipeline Python: SSRF, injeção de e-mail, CSRF do Flask

> Base: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §4. Os 2 CRÍTICOS e 3 ALTOS vivem aqui.

```xml
<objetivo>
  Fechar o SSRF do download de boleto por link (incl. redirects e cookies), escapar o HTML do
  e-mail de cobrança e validar Cc/Subject contra CRLF, e endurecer os endpoints de disparo do Flask —
  sem quebrar o download legítimo (BRASPRESS, página HTML intermediária) nem o pressuposto de rede LAN.
</objetivo>

<read_first>
  - CLAUDE.md ("Boleto por link", "Robustez da leitura", "Pipeline de cobrança de vencidos")
  - skills/email-reader/scripts/read_emails.py (_fetch_url, download_pdf_from_url, _braspress_download_url, _is_suspicious_link, extract_pdf_links, save_attachments, safe_filename)
  - skills/cobranca-vencidos/scripts/template.py, email_sender.py, run.py, send_core.py, db_firebird.py, failure_notify.py (padrão html.escape correto)
  - server/app.py (endpoints /api/emails/read*, /api/cobranca/resend/*)
  - tests/test_link_extraction.py
</read_first>

<achados>
  - CRÍTICO C-1: SSRF — _fetch_url/download_pdf_from_url fazem GET sem allowlist de host/scheme/IP. read_emails.py:1543/1584/1602/1644. Alvos internos: 169.254.169.254 (metadata), localhost/127.0.0.1, IP privado, portas internas.
  - CRÍTICO C-2: redirect seguido sem revalidar destino + cookiejar compartilhado vaza cookie entre domínios. read_emails.py:1551-1559/1599/1644.
  - ALTO A-1: HTML injection no e-mail de cobrança — template.py:15/18 interpola customer_name/document_id (Firebird) sem html.escape.
  - ALTO A-2: CRLF em Cc — cc_email (db_firebird.py:88) nunca validado; email_sender.py:89/108.
  - ALTO A-3: CRLF em Subject — email_sender.py:85 (PK.EP_NO).
  - MÉDIO M-1: endpoints de disparo do Flask sem auth/Content-Type check → CSRF; server/app.py:171/213/234.
  - MÉDIO M-2: path traversal mitigado por ordem de ops (sem resolve()+contenção) — read_emails.py:635/1409/1574.
  - BAIXO B-1: download sem deadline global (cap 50MB). BAIXO B-2: texto livre sem truncagem antes do INSERT.
</achados>

<correcao>
  1. SSRF (C-1 + C-2) — criar um guard `_is_safe_download_url(url)` e um redirect-handler:
     - Rejeitar scheme != http/https; resolver o host (socket.getaddrinfo) e rejeitar se QUALQUER IP for
       `ipaddress.ip_address(ip).is_private/.is_loopback/.is_link_local/.is_reserved/.is_multicast`; rejeitar IP-literal; porta ∉ {80,443,None}.
     - Aplicar o guard ao URL inicial E a cada redirect: instalar um `urllib.request.HTTPRedirectHandler` subclasse que revalida `newurl` (levanta se inseguro) e limita redirects (ex.: 5).
     - Cookiejar: NÃO reusar o mesmo jar entre hosts de domínios distintos — escopar por host de origem (ou desabilitar cookies fora do fluxo BRASPRESS, que é o único que precisa de sessão).
     - Manter os caminhos legítimos (BRASPRESS, página HTML 1-nível) funcionando — eles batem em hosts públicos, que passam no guard.
     - (Recomendado) flag de ambiente `LINK_DOWNLOAD_ENABLED` (default true em dev) para desligar o download-por-link em produção sem mexer no código.
  2. A-1 — `from html import escape`; aplicar escape em customer_name/document_id (e nos campos formatados) em template.py (espelhar failure_notify.py).
  3. A-2/A-3 — em run.py/send_core.py, validar cc_email com validate_email (ou rejeitar \r/\n) ANTES de montar a mensagem;
     normalizar subject (`subject.replace('\r',' ').replace('\n',' ')`) em email_sender.py antes do header. Linha sem Cc válido segue (Cc vazio), não derruba o envio do To.
  4. M-1 — nos endpoints de disparo do Flask: exigir header de token compartilhado (env, ex. FLASK_TRIGGER_TOKEN) e
     validar `Content-Type: application/json` (rejeitar com 415 se ausente — quebra o CSRF simples). Manter bind 127.0.0.1.
  5. M-2 — após montar dest_path, validar `PDF_INBOX.resolve() in dest_path.resolve().parents` (rejeitar fora da pasta).
  6. B-1/B-2 — reduzir o cap de download para ~10MB + deadline total; truncar os campos de texto livre antes do INSERT (defesa em profundidade).
  7. Testes (pytest): _is_safe_download_url bloqueia 127.0.0.1/169.254.169.254/IP privado/porta interna/scheme file; redirect para alvo interno é barrado; template.py escapa HTML; cc/subject com CRLF são rejeitados/normalizados; dest_path fora de PDF_INBOX é rejeitado.
</correcao>

<restricoes>
  - NÃO quebrar BRASPRESS nem o scan de página HTML intermediária (hosts públicos legítimos passam no guard).
  - NÃO regredir as 8 proteções de robustez (timeouts/retry/in-process). NÃO alterar o pressuposto de rede LAN (manter bind localhost); a auth do Flask é defesa adicional, não substitui o bind.
  - NÃO transcrever segredo; o token do Flask vem do .env.
</restricoes>

<validacao>
  - py -3 -m pytest tests/ -q
  - py -3 -m vulture server/ skills/ scripts/ --min-confidence 60
  - py -3 skills\cobranca-vencidos\scripts\run.py --dry-run (valida imports + Firebird, sem enviar)
  - Vetor (descrever, NÃO executar contra alvo real): e-mail de teste com link http://169.254.169.254/ e http://127.0.0.1:8000/ → download recusado e logado.
</validacao>

<criterio_de_aceite>
  - Download recusa IP privado/loopback/link-local/metadata, scheme não-http e porta interna, inclusive após redirect; cookie não cruza domínio.
  - E-mail de cobrança escapa HTML; Cc/Subject sem CRLF. Endpoints do Flask exigem token + JSON.
  - BRASPRESS/HTML legítimos seguem funcionando; pytest verde com os testes novos.
</criterio_de_aceite>
```
