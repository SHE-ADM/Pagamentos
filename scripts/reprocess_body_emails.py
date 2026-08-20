"""
reprocess_body_emails.py — Reprocessa e-mails 'falha' cuja conta a pagar está no
CORPO do e-mail (sem anexo/sem link). Para cada candidato: rebusca o corpo no
IMAP e chama try_extract_from_body (extract_from_email_body), que agora aplica a
regra de valor por 'Total'/'Valor Total' e tolera 'R$:'. Gravou conta →
financial_account_control + email_control (falha -> recebido). Não gravou →
registra o motivo em email_processing_errors (TODA falha gera log).

Complementa reprocess_link_emails.py (que cobre boleto por link). Use os dois
ao retomar a fila de 'falha': primeiro o de link, depois este (corpo).

Uso:
    py -3 scripts/reprocess_body_emails.py --dry-run   # só lista o que faria
    py -3 scripts/reprocess_body_emails.py             # extrai e grava
"""

import sys, json, argparse, logging, urllib.request, email
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("reprocess-body")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def fetch_falha_rows(ctrl) -> list:
    """E-mails em 'falha' — candidatos a ter a conta no corpo."""
    q = ("?status=eq.falha&select=id,message_id,received_at,sender_email,"
         "sender_name,subject,has_attachment&order=received_at.desc")
    req = urllib.request.Request(ctrl.base + "/rest/v1/email_control" + q, headers=ctrl.headers)
    return json.loads(urllib.request.urlopen(req, timeout=20).read())


def set_email_status(ctrl, ec_id: int, status: str, notes: str) -> None:
    """Atualiza status + notes de um e-mail (ex.: falha -> recebido / duplicidade)."""
    body = json.dumps({"status": status, "notes": notes}).encode()
    req = urllib.request.Request(ctrl.base + f"/rest/v1/email_control?id=eq.{ec_id}",
                                 data=body, method="PATCH",
                                 headers={**ctrl.headers, "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15)


def save_body_full(ctrl, ec_id: int, body_text: str) -> None:
    """Persiste o corpo COMPLETO rebuscado do IMAP (migration 105 / Onda 2).

    POR QUE ISTO EXISTE: este script ja baixava o corpo inteiro do IMAP para reprocessar e o
    DESCARTAVA — gravava so os 500 chars do preview. Era a mesma perda que a Onda 2 corrigiu no
    reader, sobrevivendo por outro caminho, e logo nos e-mails em 'falha', que sao os que mais
    precisam de analise.

    Chamada ANTES de decidir o desfecho, de proposito: o corpo interessa em TODOS os casos
    (resolvido, duplicado, ignorado ou 'sem conta'), e amarra-la a um ramo especifico deixaria os
    demais sem corpo.

    Best-effort — o reprocessamento nao pode falhar por causa disto. Reusa `_body_full_for_storage`
    do reader para aplicar o MESMO teto, em vez de duplicar a regra.
    """
    corpo = R._body_full_for_storage(body_text)
    if not corpo:
        return
    try:
        body = json.dumps({"body_full": corpo}).encode()
        req = urllib.request.Request(ctrl.base + f"/rest/v1/email_control?id=eq.{ec_id}",
                                     data=body, method="PATCH",
                                     headers={**ctrl.headers, "Prefer": "return=minimal"})
        urllib.request.urlopen(req, timeout=15)
    except Exception:
        log.exception(f"    (nao foi possivel gravar body_full do e-mail {ec_id})")


def fetch_body_from_imap(mail, mid: str) -> "str | None":
    """Rebusca o corpo (texto) do e-mail no IMAP pelo Message-ID. None se ausente."""
    _, data = mail.uid("search", None, "HEADER", "Message-ID", mid)
    uids = (data[0] or b"").split()
    if not uids:
        return None
    _, md = mail.uid("fetch", uids[-1], "(RFC822)")
    # _rfc822_from_fetch tolera respostas IMAP intercaladas (evita o crash 'int'
    # do md[0][1] direto) — mesma regra do pipeline servido.
    return R.get_body_text(email.message_from_bytes(R._rfc822_from_fetch(md)[1]))


def _make_rec(ec: dict, body_text: str) -> dict:
    return {"message_id": ec["message_id"], "received_at": ec["received_at"],
            "sender_email": ec.get("sender_email"), "sender_name": ec.get("sender_name"),
            "subject": ec.get("subject"),
            "body_preview": (body_text or "")[:500].replace("\n", " "),
            "keyword_matched": None, "has_attachment": False}


def inspect_one(ctrl, ec: dict, body_text: str) -> str:
    """Dry-run: simula o caminho real (guardas de comprovante/NF-e + dedup) sem
    gravar. Retorna a chave do tally."""
    payload = R.extract_from_email_body(
        body_text or "", ec["received_at"], ec["message_id"], sender_email=ec.get("sender_email"))
    dtype  = (payload.get("document_type") or "").strip().lower() if payload else ""
    amount = payload.get("amount") if payload else None
    if not (payload and amount and dtype not in R.SKIP_ACCOUNT_TYPES):
        motivo = f"{dtype} não gera conta" if (payload and amount) else "sem valor/sinal no corpo"
        log.info(f"[{ec['id']}] {ec['subject'][:55]} — não gravaria ({motivo})")
        return "sem_conta"
    # CT-e/transporte SEM boleto → 'ignorado' (não é conta a pagar).
    if (R._is_transport_context(ec.get("subject"), payload.get("supplier_name"),
                                payload.get("document_type"))
            and not R._is_boleto_barcode(payload.get("barcode"))):
        log.info(f"[{ec['id']}] {ec['subject'][:55]} — CT-e/transporte sem boleto → ignoraria")
        return "ignorado"
    # A dedup casa por sk_supplier, entao resolve o fornecedor antes (mesmo no
    # dry-run). resolve_supplier_id e idempotente — so cria cadastro novo se o
    # fornecedor ainda nao existir (o mesmo que o run real faria).
    # 🔴 `body_text` E' OBRIGATORIO: e' o que habilita o fallback 1b (fornecedor pelo
    # e-mail do remetente ORIGINAL encaminhado). O modo real o passa via
    # try_extract_from_body; omiti-lo aqui faria o dry-run resolver OUTRO sk_supplier —
    # e como find_financial_duplicate casa POR sk_supplier, a previsao divergiria do que
    # o run real grava, que e' exatamente o que um dry-run existe para impedir.
    payload["sender_email"] = ec.get("sender_email")
    R._finalize_supplier(ctrl, payload, body_text or "")
    dup = ctrl.find_financial_duplicate(payload)
    if dup:
        log.info(f"[{ec['id']}] {ec['subject'][:55]} — DUPLICIDADE (conta id {dup.get('id')} já existe)")
        return "duplicado"
    log.info(f"[{ec['id']}] {ec['subject'][:55]} — gravaria R$ {amount} ({dtype})")
    return "resolvido"


def process_one(ctrl, ec: dict, body_text: str) -> str:
    """Modo real: extrai do corpo e grava/classifica. Retorna a chave do tally."""
    # O corpo veio inteiro do IMAP — persiste ANTES de qualquer desfecho, para que ele seja
    # guardado mesmo quando o reprocessamento nao gera conta (o caso 'sem_conta' abaixo).
    save_body_full(ctrl, ec["id"], body_text)
    rec = _make_rec(ec, body_text)
    outcome = R.try_extract_from_body(
        rec, body_text or "", ec["received_at"], ec["message_id"], ctrl,
        sender_email=ec.get("sender_email"))
    if outcome == R.BODY_CREATED:
        set_email_status(ctrl, ec["id"], "recebido", "Conta extraída do corpo (reprocessamento)")
        log.info(f"    ✓ conta gravada do corpo; email_control {ec['id']} -> recebido")
        return "resolvido"
    if outcome == R.BODY_DUPLICATE:
        # Pagável já registrado por outro e-mail — vira 'duplicidade', não 'falha'.
        set_email_status(ctrl, ec["id"], "duplicidade",
                         rec.get("notes") or "Duplicata — conta já registrada")
        log.info(f"    ⊘ duplicidade ({rec.get('notes')}); email_control {ec['id']} -> duplicidade")
        return "duplicado"
    if outcome == R.BODY_IGNORED:
        # CT-e/transporte sem boleto — documento fiscal, não é conta a pagar.
        set_email_status(ctrl, ec["id"], "ignorado",
                         rec.get("notes") or "CT-e/transporte sem boleto — não gera conta a pagar")
        log.info(f"    ⊘ ignorado ({rec.get('notes')}); email_control {ec['id']} -> ignorado")
        return "ignorado"
    # BODY_NONE → mantém 'falha' e registra o motivo (TODA falha gera log).
    ctrl.register_error(
        rec, "falha_processamento",
        rec.get("notes") or "Corpo do e-mail não gerou conta a pagar",
        raw_payload={"subject": rec.get("subject"), "body_preview": rec.get("body_preview")})
    log.info(f"    – sem conta no corpo ({rec.get('notes') or 'sem sinal'}); mantém falha")
    return "sem_conta"


def main():
    ap = argparse.ArgumentParser(description="Reprocessa e-mails 'falha' com conta no corpo")
    ap.add_argument("--dry-run", action="store_true", help="Lista sem extrair/gravar de verdade")
    args = ap.parse_args()

    ctrl = R.SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponível — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        sys.exit(1)

    rows = fetch_falha_rows(ctrl)
    log.info(f"E-mails status=falha a inspecionar: {len(rows)}")

    # A4-1: conexão pelo helper canônico (timeout de socket + login + select) — um
    # fetch que estanca não congela o reprocessamento manual.
    mail = R._connect_imap()

    tally = {"resolvido": 0, "duplicado": 0, "ignorado": 0, "sem_conta": 0, "imap_ausente": 0}
    try:
        for ec in rows:
            body_text = fetch_body_from_imap(mail, ec["message_id"])
            if body_text is None:
                log.info(f"[{ec['id']}] IMAP não encontrado — {ec['subject'][:50]}")
                tally["imap_ausente"] += 1
                continue
            try:
                key = inspect_one(ctrl, ec, body_text) if args.dry_run else process_one(ctrl, ec, body_text)
            except R.ApiUnavailableError:
                log.exception("    API Anthropic indisponível — interrompendo")
                break
            tally[key] += 1
    finally:
        try:
            mail.logout()
        except Exception:  # noqa: BLE001 — logout best-effort
            pass

    log.info("=" * 60)
    pre = "(dry-run) " if args.dry_run else ""
    log.info(f"  {pre}Resolvidos (corpo→conta) : {tally['resolvido']}")
    log.info(f"  Duplicidade (conta já existe): {tally['duplicado']}")
    log.info(f"  Ignorado (CT-e/transp. s/ boleto): {tally['ignorado']}")
    log.info(f"  Sem conta no corpo        : {tally['sem_conta']}")
    log.info(f"  IMAP ausente              : {tally['imap_ausente']}")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
