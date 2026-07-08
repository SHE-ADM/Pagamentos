# S4 — Pipeline Python: SSRF (rebinding), CSRF do Flask, header From

> Gerado pela auditoria de segurança de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §4. As defesas SSRF/CRLF/CSRF existentes estão OK — não regredir.

```xml
<objetivo>
  Fechar o SSRF residual por DNS rebinding (fixar o IP validado), tornar o token de disparo do Flask
  obrigatório fora de loopback, normalizar IPv6 mapeado e sanitizar o header From da cobrança.
</objetivo>

<read_first>
  - skills/email-reader/scripts/read_emails.py:2633-2668 (_host_is_safe, _is_safe_download_url),
    :2671-2684 (_SafeRedirectHandler, _build_safe_opener), :2696-2701 (_fetch_url)
  - server/app.py:55,60-77,242-314 (FLASK_TRIGGER_TOKEN, _reject_trigger_request, app.run bind)
  - skills/cobranca-vencidos/scripts/email_sender.py:81-95 (_strip_crlf/_safe_address), :103 (_build_message From)
  - tests/test_ssrf_guard.py, tests/test_flask_csrf_guard.py, tests/test_email_security.py (não regredir)
</read_first>

<achados>
  - [MÉDIO] S4-1 — _host_is_safe (read_emails.py:2639-2650): valida IPs de getaddrinfo, mas urllib re-resolve o
    nome ao conectar (TOCTOU/DNS rebinding). IP validado não é fixado no socket.
  - [MÉDIO] S4-2 — server/app.py:55: FLASK_TRIGGER_TOKEN opcional (default vazio). Única barreira é o bind
    127.0.0.1; disparo de leitura/cobrança fica aberto a qualquer origem local (ou se exposto em 0.0.0.0).
  - [BAIXO] S4-3 — read_emails.py:2642-2649: IPv6 IPv4-mapeado pode furar em Python <3.13 (prod é 3.14 → mitigado).
  - [BAIXO] S4-4 — email_sender.py:103: from_name no From sem _strip_crlf.
  - [INFO] _is_internal_email citado na doc não existe (bloqueio via RPC/migration 046) — ajustar CLAUDE.md.
</achados>

<correcao>
  1. S4-1: pinning de IP. Resolver o host uma vez (getaddrinfo), validar com _host_is_safe, e conectar ao IP
     fixado preservando o header Host — via um custom opener/HTTPConnection que usa o IP resolvido, ou
     reutilizando a resolução validada no _SafeRedirectHandler. Revalidar o IP a cada redirect (já feito) E
     fixá-lo. Manter todas as demais checagens (scheme/porta/suspeito) intactas.
  2. S4-2: em server/app.py, exigir FLASK_TRIGGER_TOKEN quando o bind NÃO for 127.0.0.1/localhost — falhar no
     boot (raise) se o token estiver vazio nesse caso. Manter o bind loopback como default. Documentar o
     pressuposto no CLAUDE.md e no scheduler.
  3. S4-3: normalizar `if ip.ipv4_mapped: ip = ip.ipv4_mapped` antes das checagens em _host_is_safe (defesa em
     profundidade, independe da versão do Python).
  4. S4-4: aplicar _strip_crlf em from_name (e from_addr) na composição do From em _build_message.
  5. INFO: corrigir a menção a _is_internal_email no CLAUDE.md para "bloqueio na RPC resolve_supplier_for_account
     (migration 046)".
</correcao>

<restricoes>
  - NÃO enfraquecer nenhuma defesa existente: _is_safe_download_url, _SafeRedirectHandler, contenção em
    PDF_INBOX, _is_suspicious_link, guarda CSRF _reject_trigger_request, bind loopback.
  - NÃO quebrar os caminhos legítimos (BRASPRESS, página HTML intermediária) — hosts públicos devem passar.
  - Manter os testes existentes (test_ssrf_guard, test_flask_csrf_guard, test_email_security) verdes.
</restricoes>

<validacao>
  - py -3 -m pytest tests/ -q  (incluir novos casos: rebinding simulado com IP interno na 2ª resolução deve ser
    bloqueado; from_name com CRLF é limpo).
  - Teste de vetor (NÃO contra produção): URL de host que resolve interno na 2ª chamada → download bloqueado.
    Subir o Flask com bind 0.0.0.0 sem token → boot falha.
  - py -3 skills\cobranca-vencidos\scripts\run.py --dry-run  (From sanitizado; envio não regride).
</validacao>

<criterio_de_aceite>
  Download de boleto imune a DNS rebinding (IP fixado). Flask recusa subir sem token fora de loopback. IPv6
  mapeado normalizado. From da cobrança sanitizado. pytest verde; defesas existentes intactas.
</criterio_de_aceite>
```
