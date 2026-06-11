"""
retry_extraction.py — Re-executa extração para e-mails com status 'baixado'.

Útil quando extract_pdf.py falhou durante a leitura automática mas os PDFs
já estão em data/pdfs_inbox/ e os registros estão em email_control.

Uso:
    py -3 scripts/retry_extraction.py            # todos com status baixado
    py -3 scripts/retry_extraction.py --dry-run  # lista sem extrair
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
    except Exception as e:
        log.error(f"Falha ao atualizar email_control id={record_id}: {e}")
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
    except Exception as e:
        log.error(f"Erro ao buscar email_control: {e}")
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


def main():
    parser = argparse.ArgumentParser(description="Reprocessa extração de PDFs pendentes")
    parser.add_argument("--dry-run", action="store_true",
                        help="Lista pendentes sem extrair")
    args = parser.parse_args()

    ctrl = SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponível — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        sys.exit(1)

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
        csvs_ok, accounts_saved = extract_and_store_accounts(
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
            log.warning("  ✗ Extração falhou — status mantido como 'baixado'")
            failed += 1

    log.info(f"\n{'='*50}")
    log.info(f"  Extraídos com sucesso : {ok}")
    log.info(f"  Falhas de extração    : {failed}")
    log.info(f"  Pulados               : {skipped}")
    log.info(f"{'='*50}")


if __name__ == "__main__":
    main()
