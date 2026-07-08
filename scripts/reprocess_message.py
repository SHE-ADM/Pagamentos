"""
reprocess_message.py — Reprocessa UM e-mail (pelo Message-ID) rodando o PIPELINE
COMPLETO (read_emails.process_message): baixa anexos PDF, anexos de IMAGEM e imagem
INLINE (via Claude Vision), PDF por link e, por fim, o corpo — grava em
financial_account_control e reconcilia email_control + limpa o erro antigo em
email_processing_errors.

Por que existe (complementa os outros reprocessadores):
  - reprocess_body_emails.py  → só o CORPO do e-mail.
  - reprocess_link_emails.py  → só BOLETO por link.
  - reprocess_ignored_emails.py → reclassifica 'ignorado'/NF-e.
  - ESTE                      → pipeline COMPLETO de um e-mail, único que cobre
    ANEXO e IMAGEM INLINE (recibo/comprovante colado no corpo, lido via Vision).

A leitura normal (read_emails) NÃO reprocessa: a deduplicação por message_id pula
e-mails já registrados em email_control. Este script ignora essa dedup de propósito,
para um único e-mail explicitamente informado.

Uso:
    py -3 scripts/reprocess_message.py --message-id "<...>" --dry-run   # só inspeciona o IMAP
    py -3 scripts/reprocess_message.py --message-id "<...>"             # processa e grava

Pré-requisitos: .env na raiz (IMAP_* + ANTHROPIC_API_KEY + SUPABASE_*). A extração de
imagem/PDF faz chamada real ao Claude (consome crédito) e grava na Supabase configurada.
"""

import os, sys, json, argparse, logging, urllib.request, urllib.parse, email
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("reprocess-msg")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _find_uid(mail, mid: str):
    """UID da mensagem pelo Message-ID (último, se houver mais de um). None se ausente."""
    _, data = mail.uid("search", None, "HEADER", "Message-ID", mid)
    uids = (data[0] or b"").split()
    return uids[-1] if uids else None


def _describe_candidates(msg) -> list:
    """Dry-run (read-only): descreve o que o pipeline salvaria — anexos PDF/imagem
    (Content-Disposition: attachment) e a MAIOR imagem inline >= limiar. Não escreve
    nada. Espelha as regras de save_attachments / save_inline_images."""
    out, inline = [], []
    for part in msg.walk():
        cd = str(part.get("Content-Disposition", ""))
        ct = part.get_content_type()
        fn = R.decode_str(part.get_filename() or "")
        fl = fn.lower()
        is_pdf = (ct == "application/pdf" or fl.endswith(".pdf")
                  or ("attachment" in cd and "pdf" in fl))
        is_img_att = ("attachment" in cd.lower()
                      and (ct in R._IMAGE_ATTACHMENT_CTS or fl.endswith(R._IMAGE_ATTACHMENT_EXTS)))
        if is_pdf or is_img_att:
            out.append(f"anexo: {ct} | {fn or '(sem nome)'}")
            continue
        if ct.startswith("image/") and "attachment" not in cd.lower():
            payload = part.get_payload(decode=True) or b""
            if len(payload) >= R._IMAGE_INLINE_MIN_BYTES:
                inline.append((len(payload), fn or "(sem nome)", ct))
    if inline:
        inline.sort(reverse=True)
        size, fn, ct = inline[0]
        out.append(f"imagem inline (MAIOR, {size} bytes): {ct} | {fn}"
                   + (f" — +{len(inline) - 1} inline menor(es) ignorada(s)" if len(inline) > 1 else ""))
    return out


def _patch_email_control(ctrl, mid: str, status: str, notes: str, has_att: bool) -> None:
    """Atualiza status/notes/has_attachment do e-mail (register usa ignore-duplicates
    e NÃO atualiza linha existente — daí o PATCH explícito)."""
    q = "?message_id=eq." + urllib.parse.quote(mid, safe="")
    body = json.dumps({"status": status, "notes": notes, "has_attachment": has_att}).encode()
    req = urllib.request.Request(ctrl.base + "/rest/v1/email_control" + q,
                                 data=body, method="PATCH",
                                 headers={**ctrl.headers, "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15)


def _delete_errors(ctrl, mid: str) -> None:
    """Remove o(s) erro(s) antigo(s) deste e-mail (resolvido → some de /erros)."""
    q = "?gmail_message_id=eq." + urllib.parse.quote(mid, safe="")
    req = urllib.request.Request(ctrl.base + "/rest/v1/email_processing_errors" + q,
                                 method="DELETE",
                                 headers={**ctrl.headers, "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15)


def main():
    ap = argparse.ArgumentParser(description="Reprocessa um e-mail (Message-ID) pelo pipeline completo")
    ap.add_argument("--message-id", required=True, help="Message-ID do e-mail (com os < >)")
    ap.add_argument("--dry-run", action="store_true", help="Só inspeciona o IMAP, sem extrair/gravar")
    args = ap.parse_args()
    mid = args.message_id.strip()

    ctrl = R.SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponível — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        sys.exit(1)

    kw_env = os.getenv("EMAIL_KEYWORDS", "")
    keywords = [k.strip() for k in kw_env.split(",")] if kw_env else R.KEYWORDS_DEFAULT

    # A4-1: conexão pelo helper canônico (timeout de socket + login + select) — um
    # fetch que estanca não congela o reprocessamento manual.
    mail = R._connect_imap()
    try:
        uid = _find_uid(mail, mid)
        if not uid:
            log.error(f"Message-ID não encontrado no IMAP: {mid}")
            sys.exit(2)
        log.info(f"UID encontrado: {uid.decode()}")

        if args.dry_run:
            _, md = mail.uid("fetch", uid, "(RFC822)")
            msg = email.message_from_bytes(R._rfc822_from_fetch(md)[1])
            log.info(f"Assunto: {R.decode_str(msg.get('Subject', ''))}")
            cands = _describe_candidates(msg)
            log.info(f"Documentos que o pipeline usaria ({len(cands)}):")
            for c in cands:
                log.info(f"  - {c}")
            if not cands:
                log.info("  (nenhum anexo/imagem — cairia no corpo do e-mail)")
            return

        rec = R.process_message(mail, uid, keywords, dry_run=False, mark_seen=False, ctrl=ctrl)
        status  = (rec or {}).get("status")
        notes   = (rec or {}).get("notes") or "Reprocessado pelo pipeline completo"
        has_att = bool((rec or {}).get("has_attachment"))
        log.info(f"process_message → status={status} | has_attachment={has_att} | notes={notes}")

        _patch_email_control(ctrl, mid, status, notes, has_att)
        log.info(f"email_control atualizado → status={status}")

        # Erro resolvido: remove o log antigo se não está mais em 'falha'.
        if status and status != "falha":
            _delete_errors(ctrl, mid)
            log.info("email_processing_errors: erro(s) antigo(s) removido(s)")
    finally:
        try:
            mail.logout()
        except Exception:  # noqa: BLE001 — logout best-effort
            pass


if __name__ == "__main__":
    main()
