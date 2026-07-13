"""
retry_extraction.py — Re-executa extração para PDFs que falharam.

Dois modos:

1) Pendentes (padrão): e-mails com status 'pendente' (pdf_extracted=false e
   attachment_saved=true) — PDFs salvos mas nunca extraídos.

2) --from-errors: e-mails que GERARAM conta parcial ou nenhuma por falha de
   extração/validação (linhas em email_processing_errors: sem_valor,
   extracao_falhou, db_erro). Esses ficam com status 'extraído' e NÃO são
   pegos pelo modo padrão. Reprocessa o conjunto COMPLETO de PDFs do e-mail
   (via attachment_names) para preservar a ordem dos sufixos #N e deixar a
   deduplicação ignorar contas já gravadas; limpa os erros antigos só após o
   reprocessamento (se a API cair, o log de erro é preservado).

Uso:
    py -3 scripts/retry_extraction.py                  # pendentes (status pendente)
    py -3 scripts/retry_extraction.py --dry-run        # lista pendentes sem extrair
    py -3 scripts/retry_extraction.py --from-errors    # reprocessa falhas em /erros
    py -3 scripts/retry_extraction.py --from-errors --dry-run
"""

import os, sys, json, argparse, logging, urllib.request, urllib.parse, urllib.error
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")

sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
from read_emails import (
    SupabaseControl, extract_and_store_accounts, PDF_INBOX
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("retry-extraction")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _patch_email_control(ctrl: SupabaseControl, record_id: int,
                          pdf_extracted: bool, extraction_csv: str | None,
                          status: str) -> bool:
    payload = {
        "pdf_extracted":  pdf_extracted,
        "extraction_csv": extraction_csv,
        "status":         status,
    }
    try:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{ctrl.base}/rest/v1/email_control?id=eq.{record_id}",
            data=data,
            headers={**ctrl.headers, "Prefer": "return=minimal"},
            method="PATCH",
        )
        urllib.request.urlopen(req, timeout=10)
        return True
    except Exception:
        log.exception(f"Falha ao atualizar email_control id={record_id}")
        return False


def fetch_pending(ctrl: SupabaseControl) -> list:
    """Busca registros com pdf_extracted=false e attachment_saved=true."""
    try:
        req = urllib.request.Request(
            f"{ctrl.base}/rest/v1/email_control"
            "?pdf_extracted=eq.false&attachment_saved=eq.true"
            "&select=id,message_id,subject,attachment_names",
            headers=ctrl.headers,
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        log.exception("Erro ao buscar email_control")
        return []


def resolve_pdfs(attachment_names: str | None) -> list[Path]:
    """
    Converte attachment_names (pipe-separated) em lista de Paths existentes.
    Ignora arquivos não encontrados com aviso.
    """
    if not attachment_names:
        return []
    pdfs = []
    for name in attachment_names.split("|"):
        name = name.strip()
        p = PDF_INBOX / name
        if p.exists():
            pdfs.append(p)
        else:
            log.warning(f"  PDF não encontrado: {name}")
    return pdfs


def fetch_errors(ctrl: SupabaseControl) -> list:
    """Busca todas as linhas de email_processing_errors com contexto do e-mail."""
    try:
        req = urllib.request.Request(
            f"{ctrl.base}/rest/v1/email_processing_errors"
            "?select=id,gmail_message_id,sender_name,sender_email,subject,"
            "received_at,source_file,error_type&order=gmail_message_id",
            headers=ctrl.headers,
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        log.exception("Erro ao buscar email_processing_errors")
        return []


def fetch_email_control_row(ctrl: SupabaseControl, message_id: str) -> dict | None:
    """email_control (id, attachment_names, subject) por message_id."""
    try:
        q = urllib.parse.quote(message_id, safe="")
        req = urllib.request.Request(
            f"{ctrl.base}/rest/v1/email_control"
            f"?message_id=eq.{q}&select=id,attachment_names,subject&limit=1",
            headers=ctrl.headers,
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            rows = json.loads(r.read())
            return rows[0] if rows else None
    except Exception:
        log.exception(f"Erro ao buscar email_control para {message_id}")
        return None


def delete_errors_by_ids(ctrl: SupabaseControl, ids: list) -> bool:
    """Remove linhas de email_processing_errors pelos ids informados."""
    if not ids:
        return True
    try:
        id_list = ",".join(str(i) for i in ids)
        req = urllib.request.Request(
            f"{ctrl.base}/rest/v1/email_processing_errors?id=in.({id_list})",
            headers={**ctrl.headers, "Prefer": "return=minimal"},
            method="DELETE",
        )
        urllib.request.urlopen(req, timeout=10)
        return True
    except Exception:
        log.exception("Falha ao remover erros antigos")
        return False


def _group_errors_by_message(errors: list) -> dict:
    """Agrupa linhas de erro por gmail_message_id (ids + contexto + source_files)."""
    groups: dict[str, dict] = {}
    for e in errors:
        mid = e.get("gmail_message_id")
        if not mid:
            continue
        g = groups.setdefault(mid, {"ids": [], "ctx": e, "source_files": []})
        g["ids"].append(e["id"])
        if e.get("source_file"):
            g["source_files"].append(e["source_file"])
    return groups


def _resolve_email_pdfs(ec: dict | None, g: dict) -> list[Path]:
    """Conjunto completo de PDFs do e-mail (attachment_names) ou, em fallback,
    os source_files das proprias linhas de erro."""
    pdfs = resolve_pdfs(ec.get("attachment_names")) if ec else []
    if pdfs:
        return pdfs
    return [PDF_INBOX / sf for sf in dict.fromkeys(g["source_files"])
            if (PDF_INBOX / sf).exists()]


def _reprocess_one(ctrl: SupabaseControl, mid: str, g: dict, dry_run: bool) -> str:
    """Reprocessa um e-mail. Retorna 'ok' | 'failed' | 'skipped'."""
    ctx = g["ctx"]
    log.info(f"\n[{mid[:30]}] {(ctx.get('subject') or '')[:60]}")

    ec = fetch_email_control_row(ctrl, mid)
    pdfs = _resolve_email_pdfs(ec, g)
    if not pdfs:
        log.warning("  Nenhum PDF encontrado em pdfs_inbox — pulando")
        return "skipped"

    if dry_run:
        log.info(f"  dry-run: {len(g['ids'])} erro(s) → {[p.name for p in pdfs]}")
        return "skipped"

    email_ctx = {
        "message_id":   mid,
        "sender_name":  ctx.get("sender_name"),
        "sender_email": ctx.get("sender_email"),
        "subject":      ctx.get("subject"),
        "received_at":  ctx.get("received_at"),
    }
    try:
        csvs_ok, accounts_saved, _nonpayable, _att_account = extract_and_store_accounts(
            pdfs, mid, ctrl, email_rec=email_ctx
        )
        if ec and csvs_ok:
            _patch_email_control(ctrl, ec["id"], pdf_extracted=True,
                                 extraction_csv=" | ".join(csvs_ok), status="extraído")
        # Falhas persistentes sao re-logadas como linhas novas; removemos as
        # antigas (capturadas antes) para nao duplicar.
        delete_errors_by_ids(ctrl, g["ids"])
    except Exception:
        log.exception(f"  Falha ao reprocessar {mid[:30]} — erros antigos preservados")
        return "failed"

    if accounts_saved:
        log.info(f"  ✓ {accounts_saved} conta(s) gravada(s)")
        return "ok"
    log.warning("  ✗ Nenhuma conta gerada (pode ser não-pagável legítimo)")
    return "failed"


def reprocess_from_errors(ctrl: SupabaseControl, dry_run: bool) -> None:
    """Reprocessa e-mails com falhas registradas em email_processing_errors.

    Agrupa por gmail_message_id e reprocessa o conjunto COMPLETO de PDFs do
    e-mail (via attachment_names) — preserva a ordem dos sufixos #N e deixa a
    deduplicação ignorar contas já gravadas, evitando sobrescrever a conta boa
    de um e-mail parcialmente extraído. Os erros antigos só são removidos APÓS o
    reprocessamento (preserva o log se a API estiver fora).
    """
    groups = _group_errors_by_message(fetch_errors(ctrl))
    log.info(f"E-mails com falhas registradas: {len(groups)}")
    if not groups:
        log.info("Nenhuma falha em email_processing_errors. Nada a fazer.")
        return

    tally = {"ok": 0, "failed": 0, "skipped": 0}
    for mid, g in groups.items():
        tally[_reprocess_one(ctrl, mid, g, dry_run)] += 1

    log.info(f"\n{'='*50}")
    log.info(f"  E-mails com conta recuperada : {tally['ok']}")
    log.info(f"  Sem conta (revisar)          : {tally['failed']}")
    log.info(f"  Pulados                      : {tally['skipped']}")
    log.info(f"{'='*50}")


def main():
    parser = argparse.ArgumentParser(description="Reprocessa extração de PDFs pendentes")
    parser.add_argument("--dry-run", action="store_true",
                        help="Lista sem extrair")
    parser.add_argument("--from-errors", action="store_true",
                        help="Reprocessa e-mails com falhas em email_processing_errors")
    args = parser.parse_args()

    ctrl = SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponível — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        sys.exit(1)

    if args.from_errors:
        reprocess_from_errors(ctrl, args.dry_run)
        return

    pending = fetch_pending(ctrl)
    log.info(f"Registros pendentes de extração: {len(pending)}")

    if not pending:
        log.info("Nenhum registro pendente. Nada a fazer.")
        return

    ok = failed = skipped = 0

    for rec in pending:
        rec_id    = rec["id"]
        msg_id    = rec["message_id"]
        subject   = rec.get("subject", "")[:60]
        att_names = rec.get("attachment_names")

        log.info(f"\n[{rec_id}] {subject}")

        pdfs = resolve_pdfs(att_names)
        if not pdfs:
            log.warning("  Nenhum PDF encontrado em pdfs_inbox — pulando")
            skipped += 1
            continue

        if args.dry_run:
            log.info(f"  dry-run: {[p.name for p in pdfs]}")
            skipped += 1
            continue

        email_ctx = {"message_id": msg_id, "subject": subject}
        csvs_ok, accounts_saved, _nonpayable, _att_account = extract_and_store_accounts(
            pdfs, msg_id, ctrl, email_rec=email_ctx
        )

        if csvs_ok:
            extraction_csv = " | ".join(csvs_ok)
            _patch_email_control(ctrl, rec_id,
                                  pdf_extracted=True,
                                  extraction_csv=extraction_csv,
                                  status="extraído")
            log.info(f"  ✓ {accounts_saved} conta(s) gravada(s) — status → extraído")
            ok += 1
        else:
            log.warning("  ✗ Extração falhou — status mantido como 'pendente'")
            failed += 1

    log.info(f"\n{'='*50}")
    log.info(f"  Extraídos com sucesso : {ok}")
    log.info(f"  Falhas de extração    : {failed}")
    log.info(f"  Pulados               : {skipped}")
    log.info(f"{'='*50}")


if __name__ == "__main__":
    main()
