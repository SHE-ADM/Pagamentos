"""
reprocess_link_emails.py — Reprocessa e-mails 'falha' cujo boleto vem por LINK
(sem anexo direto). Para cada candidato: rebusca o corpo no IMAP, extrai os links
(extract_pdf_links — já filtra suspeitos e reconhece portais como BRASPRESS),
baixa o PDF (download_pdf_from_url, com sessão de cookie), extrai e grava em
financial_account_control e atualiza email_control (falha -> extraído).

Boletos obtidos via link sobem ao Storage normalmente (extract_and_store_accounts
-> upload_attachment). Dedup de conteúdo evita gravar a mesma fatura duas vezes.

Uso:
    py -3 scripts/reprocess_link_emails.py --dry-run   # só lista o que faria
    py -3 scripts/reprocess_link_emails.py             # baixa, extrai e grava
"""

import os, sys, json, argparse, logging, urllib.request, imaplib, email
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("reprocess-link")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _decode_part(part) -> str:
    """Decodifica o payload de uma parte MIME (string vazia se ausente)."""
    payload = part.get_payload(decode=True)
    if not payload:
        return ""
    return payload.decode(part.get_content_charset() or "utf-8", "replace")


def _get_body(msg) -> "tuple[str, str]":
    """Retorna (texto, html) do e-mail (multipart ou simples)."""
    if not msg.is_multipart():
        return _decode_part(msg), ""

    text = html = ""
    for part in msg.walk():
        ct = part.get_content_type()
        if ct == "text/plain" and not text:
            text = _decode_part(part)
        elif ct == "text/html" and not html:
            html = _decode_part(part)
    return text, html


def fetch_falha_rows(ctrl) -> list:
    q = ("?status=eq.falha&select=id,message_id,received_at,sender_email,"
         "sender_name,subject,has_attachment&order=received_at.desc")
    req = urllib.request.Request(ctrl.base + "/rest/v1/email_control" + q, headers=ctrl.headers)
    return json.loads(urllib.request.urlopen(req, timeout=20).read())


def mark_extraido(ctrl, ec_id: int) -> None:
    body = json.dumps({"status": "extraído", "has_attachment": True,
                       "notes": "Boleto baixado via link e extraído"}).encode()
    req = urllib.request.Request(ctrl.base + f"/rest/v1/email_control?id=eq.{ec_id}",
                                 data=body, method="PATCH",
                                 headers={**ctrl.headers, "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15)


def _first_pdf(links, ec):
    """Baixa o primeiro link que retorna um PDF; None se nenhum baixou."""
    for url in links:
        p = R.download_pdf_from_url(
            url, ec.get("sender_email") or "", ec.get("subject") or "",
            (ec.get("received_at") or "")[:10])
        if p:
            return p
    return None


def _store_pdf(pdf, ec, ctrl) -> str:
    """Extrai/grava o PDF e marca o email_control; retorna a chave do tally.
    Propaga ApiUnavailableError para o chamador interromper o lote."""
    mid = ec["message_id"]
    rec = {"message_id": mid, "received_at": ec["received_at"],
           "sender_email": ec.get("sender_email"), "sender_name": ec.get("sender_name"),
           "subject": ec.get("subject")}
    csvs, saved, _nonpayable = R.extract_and_store_accounts([Path(pdf)], mid, ctrl, email_rec=rec)
    if saved > 0:
        mark_extraido(ctrl, ec["id"])
        log.info(f"    ✓ {saved} conta(s) nova(s); email_control {ec['id']} -> extraído")
        return "resolvido"
    if csvs:
        # CSV gerado mas sem conta nova = mesma fatura já registrada (duplicata de
        # e-mail irmão: original + encaminhado). O PDF foi lido → extraído.
        mark_extraido(ctrl, ec["id"])
        log.info(f"    ↻ fatura já registrada (duplicata); email_control {ec['id']} -> extraído")
        return "resolvido"
    log.warning("    PDF baixado mas extração não gerou CSV (ver email_processing_errors)")
    return "extracao_zero"


def _process_row(ec, mail, ctrl, dry_run: bool) -> str:
    """Processa um e-mail 'falha' e devolve a chave do tally correspondente.
    Pode lançar ApiUnavailableError (o chamador interrompe o lote)."""
    mid = ec["message_id"]
    _, data = mail.uid("search", None, "HEADER", "Message-ID", mid)
    uids = (data[0] or b"").split()
    if not uids:
        log.info(f"[{ec['id']}] IMAP não encontrado — {ec['subject'][:50]}")
        return "imap_ausente"

    _, md = mail.uid("fetch", uids[-1], "(RFC822)")
    # _rfc822_from_fetch tolera respostas IMAP intercaladas (evita o crash 'int'
    # do md[0][1] direto) — mesma regra do pipeline servido.
    msg = email.message_from_bytes(R._rfc822_from_fetch(md)[1])
    links = R.extract_pdf_links(*_get_body(msg))
    if not links:
        return "sem_link"

    log.info(f"[{ec['id']}] {ec['subject'][:55]} — {len(links)} link(s) candidato(s)")
    pdf = _first_pdf(links, ec)
    if not pdf:
        log.warning("    link presente, mas nenhum PDF baixado")
        return "link_sem_pdf"

    if dry_run:
        log.info(f"    (dry-run) baixaria + extrairia + gravaria a partir de {Path(pdf).name}")
        return "resolvido"

    return _store_pdf(pdf, ec, ctrl)


def main():
    ap = argparse.ArgumentParser(description="Reprocessa e-mails 'falha' com boleto por link")
    ap.add_argument("--dry-run", action="store_true", help="Lista sem baixar/gravar de verdade")
    args = ap.parse_args()

    ctrl = R.SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponível — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        sys.exit(1)

    rows = fetch_falha_rows(ctrl)
    log.info(f"E-mails status=falha a inspecionar: {len(rows)}")

    mail = imaplib.IMAP4_SSL(os.getenv("IMAP_HOST"), int(os.getenv("IMAP_PORT", 993)))
    mail.login(os.getenv("IMAP_USER"), os.getenv("IMAP_PASS"))
    mail.select(os.getenv("IMAP_MAILBOX", "INBOX"))

    tally = {"sem_link": 0, "resolvido": 0, "link_sem_pdf": 0, "imap_ausente": 0, "extracao_zero": 0}
    try:
        for ec in rows:
            try:
                tally[_process_row(ec, mail, ctrl, args.dry_run)] += 1
            except R.ApiUnavailableError:
                log.exception("    API Anthropic indisponível — interrompendo")
                break
    finally:
        try:
            mail.logout()
        except Exception:  # noqa: BLE001 — logout best-effort
            pass

    log.info("=" * 60)
    pre = "(dry-run) " if args.dry_run else ""
    log.info(f"  {pre}Resolvidos (link→PDF)   : {tally['resolvido']}")
    log.info(f"  Sem link (fora do escopo) : {tally['sem_link']}")
    log.info(f"  Link sem PDF              : {tally['link_sem_pdf']}")
    log.info(f"  Extração sem conta        : {tally['extracao_zero']}")
    log.info(f"  IMAP ausente              : {tally['imap_ausente']}")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
