# S3 — Next API (mass assignment / bridge / timeout)

> Gerado pela auditoria de segurança de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §3. Superfície sólida — só hardening BAIXO.

```xml
<objetivo>
  Reduzir a superfície de escrita manual da conta (campos de pipeline/auditoria hoje graváveis via PATCH) e
  adicionar timeout ao fetch da ponte Python.
</objetivo>

<read_first>
  - packages/shared/src/schemas/financial-account-control.schema.ts:292-325 (Input/Create schemas)
  - apps/api-backend/lib/contas.ts (create/update — o que é persistido)
  - apps/api-backend/lib/python-bridge.ts:49-67 (fetch ao Flask; probePythonHealth)
  - apps/api-backend/app/api/emails/read/route.ts:37, app/api/users/route.ts:26 (fail(e.message,500) residual)
  - apps/api-backend/lib/response.ts (failFromError)
</read_first>

<achados>
  - [BAIXO] S3-1 — python-bridge.ts:49-53 (e :67): fetch ao Flask sem AbortController/timeout → handler pendura
    se o Flask travar.
  - [BAIXO] S3-2 — financial-account-control.schema.ts:292-325: PATCH/CREATE de conta expõem gmail_message_id,
    extraction_source, extracted_at, processing_notes, email_body_excerpt, nosso_numero, payer_*, sender_email,
    subject à escrita manual (dentro do tenant; corrompe auditoria/dedup).
  - [INFO] users/route.ts:26 e emails/read/route.ts:37: ramo fail(e.message,500) residual.
</achados>

<correcao>
  1. S3-1: adicionar `signal: AbortSignal.timeout(30_000)` no fetch de triggerReader e no probePythonHealth;
     tratar AbortError como PythonBridgeError(..., 504). Manter o envelope de erro atual.
  2. S3-2: criar financialAccountControlManualEditSchema com `.pick()` só dos campos de UI (sk_supplier,
     amount, due_date, issue_date, document_type, payment_method, invoice_number, barcode, cost_center_id,
     chart_account_id, status_id, additional_info, has_invoice, has_bank_slip, subject se editável). Usar esse
     schema em POST/PATCH /api/contas em vez de `.partial()` sobre todo o Input. Os campos de pipeline
     (gmail_message_id/extraction_source/extracted_at/processing_notes/email_body_excerpt/nosso_numero/payer_*/
     sender_email) deixam de ser aceitos no corpo — só o pipeline Python os grava (service_role).
  3. INFO: trocar os dois ramos fail(e.message,500) por failFromError(e, '<tag>') (o de users é o A1-2 do code
     review — fazer uma vez).
</correcao>

<restricoes>
  - Não quebrar o CRUD manual de contas — os campos de UI legítimos continuam editáveis.
  - Não alterar o comportamento do pipeline Python (grava via service_role, fora desses schemas).
  - Manter o modelo single-org (IDOR intra-tenant é aceito por design; não introduzir escopo por usuário aqui).
</restricoes>

<validacao>
  - npm run lint && npm run typecheck && npm test
  - Teste de vetor (NÃO contra produção): PATCH /api/contas/:id com { extraction_source: 'falha',
    gmail_message_id: 'x' } → o campo é IGNORADO (não persiste) após a correção. Verificar que a edição normal
    (fornecedor/valor/vencimento/classificação/status) segue funcionando.
  - Simular Flask travado (parar o serviço) e chamar POST /api/emails/read → 504 após ~30s (não pendura).
</validacao>

<criterio_de_aceite>
  Campos de pipeline/auditoria não são mais graváveis via /api/contas. Ponte Python com timeout (504 em vez de
  pendurar). Nenhum fail(e.message,500) residual. Gate verde; testes de contrato dos CRUDs seguem passando.
</criterio_de_aceite>
```
