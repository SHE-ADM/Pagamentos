"""
backfill_received_at.py — Corrige email_control.received_at para a CHEGADA real
na caixa postal (INTERNALDATE do IMAP), alinhando a ordem de /emails a do webmail.

Contexto: antes, e-mails 'ignorado' gravavam received_at a partir do header Date
do remetente (relogio nao confiavel), enquanto os processados usavam INTERNALDATE
— o que desalinhava /emails da caixa postal. O pipeline ja foi corrigido (ambos
os caminhos usam _received_at_from); este script reescreve o historico ja gravado,
rebuscando o INTERNALDATE no IMAP (uma varredura unica da INBOX) e atualizando as
linhas cujo valor difere.

Uso:
    py -3 scripts/backfill_received_at.py --dry-run   # so lista o que mudaria
    py -3 scripts/backfill_received_at.py             # aplica
"""

import argparse
import email
import json
import logging
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("backfill-received-at")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

PAGE = 1000


def _build_internaldate_map(mail) -> dict:
    """Varre a INBOX e mapeia Message-ID -> received_at (INTERNALDATE ISO)."""
    _, uids_data = mail.uid("search", None, "ALL")
    uids = uids_data[0].split() if uids_data and uids_data[0] else []
    log.info("IMAP: %d mensagens na caixa", len(uids))
    mapping: dict[str, str] = {}
    for uid in uids:
        try:
            _, data = mail.uid("fetch", uid,
                               "(INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID DATE)])")
            meta, raw = R._rfc822_from_fetch(data)
            msg = email.message_from_bytes(raw)
            mid = (msg.get("Message-ID", "") or "").strip()
            if mid:
                mapping[mid] = R._received_at_from(meta, msg.get("Date", ""))
        except Exception as e:
            log.warning("  UID %s — falha ao ler INTERNALDATE: %s", uid, e)
    return mapping


def _fetch_rows(ctrl) -> list:
    """Todas as linhas de email_control (id, message_id, received_at), paginado."""
    rows, offset = [], 0
    while True:
        req = urllib.request.Request(
            ctrl.base + "/rest/v1/email_control?select=id,message_id,received_at"
                        f"&order=id&offset={offset}&limit={PAGE}",
            headers=ctrl.headers)
        chunk = json.loads(urllib.request.urlopen(req, timeout=30).read())
        rows.extend(chunk)
        if len(chunk) < PAGE:
            return rows
        offset += PAGE


def _patch_received_at(ctrl, ec_id: int, received_at: str) -> None:
    body = json.dumps({"received_at": received_at}).encode()
    req = urllib.request.Request(
        ctrl.base + f"/rest/v1/email_control?id=eq.{ec_id}",
        data=body, method="PATCH",
        headers={**ctrl.headers, "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15)


def _same_instant(a: "str | None", b: "str | None") -> bool:
    """Compara dois ISO timestamps como o MESMO instante (tolera offset distinto)."""
    if not a or not b:
        return a == b
    try:
        return datetime.fromisoformat(a) == datetime.fromisoformat(b)
    except Exception:
        return a == b


def main(dry_run: bool) -> None:
    ctrl = R.SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponivel — abortando.")
        sys.exit(1)

    mail = R._connect_imap()
    try:
        id_map = _build_internaldate_map(mail)
    finally:
        R._safe_logout(mail)

    rows = _fetch_rows(ctrl)
    log.info("email_control: %d linhas", len(rows))

    changed = missing = unchanged = 0
    for r in rows:
        new = id_map.get(r.get("message_id") or "")
        if not new:
            missing += 1
            continue
        if _same_instant(r.get("received_at"), new):
            unchanged += 1
            continue
        changed += 1
        log.info("  id=%s  %s -> %s", r["id"], r.get("received_at"), new)
        if not dry_run:
            _patch_received_at(ctrl, r["id"], new)

    log.info("-" * 60)
    log.info("Resumo: alterados=%d | inalterados=%d | sem match no IMAP=%d%s",
             changed, unchanged, missing, "  (DRY-RUN)" if dry_run else "")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Backfill de received_at (INTERNALDATE) no email_control")
    ap.add_argument("--dry-run", action="store_true", help="lista as mudancas sem gravar")
    main(ap.parse_args().dry_run)
