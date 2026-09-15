"""
reprocess_document_number.py — Corrige RETROATIVAMENTE o "Nº Documento" dos boletos que
gravaram o NOSSO NÚMERO em `invoice_number` (prompt de extração anterior a 2026-09-15).

Varre as contas com PDF (`source_file`) cujo `invoice_number` é a CÓPIA do `nosso_numero`,
baixa o PDF do bucket, localiza a PÁGINA do título (a que imprime o nosso número da conta —
um PDF de carnê guarda N boletos, e ler o documento inteiro devolveria o número de outro) e lê
o "Nº do Documento" com o MESMO extractor da extração
(`extract_pdf.extract_boleto_document_number`). Só grava quando a leitura é inequívoca; o resto
é LOGADO com o motivo, para revisão manual.

PDF escaneado (sem texto) não é lido aqui — não há texto de onde tirar o número sem chamar o
modelo, e este script não gasta API.

Idempotente: a conta corrigida deixa de ter invoice_number == nosso_numero e sai da varredura.

Uso:
    py -3 scripts/reprocess_document_number.py --dry-run                 # lista o que faria
    py -3 scripts/reprocess_document_number.py --dry-run --supplier 936  # só um fornecedor
    py -3 scripts/reprocess_document_number.py --ids 1499,1506           # aplica a estes ids
"""

import argparse
import json
import logging
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(BASE_DIR / "skills" / "pdf-contas-pagar" / "scripts"))
import extract_pdf as E  # extract_boleto_document_number — fonte única
import pdfplumber
import read_emails as R  # SupabaseControl: base/headers/key

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("reprocess-document-number")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass  # stdout redirecionado sem reconfigure — o log segue no encoding padrão

_PAGE = 1000
_SELECT = "id,sk_supplier,source_file,invoice_number,nosso_numero"
# Mesmo piso de `read_emails._is_real_nosso_numero`: abaixo disso a igualdade não prova cópia.
_MIN_NOSSO_DIGITS = 8
_HTTP_TIMEOUT = 30


# --- Regras puras (testáveis sem rede) ------------------------------------------------------

def _digits(value) -> str:
    return re.sub(r"\D", "", str(value or ""))


def is_legacy_invoice(conta: dict) -> bool:
    """`invoice_number` é a cópia do nosso número — o defeito que este script corrige."""
    nosso = _digits(conta.get("nosso_numero"))
    return len(nosso) >= _MIN_NOSSO_DIGITS and _digits(conta.get("invoice_number")) == nosso


def page_of_title(pages: list, nosso) -> "str | None":
    """Texto da ÚNICA página que imprime o nosso número da conta, ou None.

    Casa por LINHA (dígitos da linha contêm os do nosso número), nunca pela página inteira
    concatenada — juntar os dígitos de linhas distintas poderia forjar a sequência."""
    alvo = _digits(nosso)
    if len(alvo) < _MIN_NOSSO_DIGITS:
        return None
    hits = [p for p in pages if any(alvo in _digits(line) for line in (p or "").splitlines())]
    return hits[0] if len(hits) == 1 else None


def resolve_document_number(pages: list, conta: dict) -> "tuple[str | None, str]":
    """(novo Nº do Documento, motivo). Número None ⇒ não grava; o motivo vai ao log."""
    page = page_of_title(pages, conta.get("nosso_numero"))
    if page is None:
        return None, "página do título não localizada pelo nosso número"
    doc = E.extract_boleto_document_number(page)
    if not doc:
        return None, "Nº do Documento não lido na ficha"
    if _digits(doc) == _digits(conta.get("nosso_numero")):
        return None, "a ficha imprime o próprio nosso número como Nº do Documento (já correto)"
    return doc, "ok"


# --- I/O (Supabase REST + Storage) ----------------------------------------------------------

def _get_all(ctrl, path: str) -> list:
    rows, offset = [], 0
    sep = "&" if "?" in path else "?"
    while True:
        req = urllib.request.Request(
            f"{ctrl.base}/rest/v1/{path}{sep}limit={_PAGE}&offset={offset}", headers=ctrl.headers)
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as r:
            page = json.loads(r.read())
        rows.extend(page)
        if len(page) < _PAGE:
            return rows
        offset += _PAGE


def _download_pages(ctrl, storage_key: str) -> "list | None":
    """Texto de cada página do PDF no bucket `attachments`. None em falha (não é fatal)."""
    url = f"{ctrl.base}/storage/v1/object/attachments/{urllib.parse.quote(storage_key)}"
    req = urllib.request.Request(url, headers={"apikey": ctrl.key,
                                               "Authorization": f"Bearer {ctrl.key}"})
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as r:
            data = r.read()
    except (urllib.error.URLError, TimeoutError) as e:
        log.warning(f"  (pulado) falha ao baixar {storage_key}: {e}")
        return None
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "doc.pdf"
        tmp.write_bytes(data)
        try:
            with pdfplumber.open(tmp) as pdf:
                return [(p.extract_text() or "") for p in pdf.pages]
        except Exception:  # PDF cifrado/corrompido: loga com traceback e segue com os demais
            log.exception(f"  (pulado) PDF ilegível: {storage_key}")
            return None


def _patch_invoice(ctrl, fac_id: int, invoice: str) -> None:
    req = urllib.request.Request(
        f"{ctrl.base}/rest/v1/financial_account_control?id=eq.{int(fac_id)}",
        data=json.dumps({"invoice_number": invoice}).encode(), method="PATCH",
        headers={**ctrl.headers, "Prefer": "return=minimal"})
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT):
        pass


# --- Orquestração -----------------------------------------------------------------------------

def _parse_args(argv):
    ap = argparse.ArgumentParser(description="Corrige invoice_number = Nº do Documento do boleto.")
    ap.add_argument("--dry-run", action="store_true", help="Só lista o que faria, sem PATCH.")
    ap.add_argument("--ids", help="Restringe a estes ids (CSV), ex.: 1499,1506.")
    ap.add_argument("--supplier", type=int, help="Restringe a um sk_supplier.")
    args = ap.parse_args(argv)
    if args.ids:
        try:
            args.ids = [int(x) for x in args.ids.split(",") if x.strip()]
        except ValueError:
            ap.error("--ids aceita só inteiros separados por vírgula")
    return args


def main(argv=None) -> int:
    args = _parse_args(argv)
    ctrl = R.SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponivel — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        return 1

    path = (f"financial_account_control?select={_SELECT}"
            "&source_file=not.is.null&nosso_numero=not.is.null&order=id")
    if args.ids:
        path += f"&id=in.({','.join(str(i) for i in args.ids)})"
    if args.supplier is not None:
        path += f"&sk_supplier=eq.{args.supplier}"
    contas = [c for c in _get_all(ctrl, path) if is_legacy_invoice(c)]
    log.info(f"Contas com nosso número em invoice_number: {len(contas)}")

    pages_cache: dict = {}
    changed = review = failed = 0
    for c in contas:
        key = c["source_file"]
        if key not in pages_cache:
            pages_cache[key] = _download_pages(ctrl, key)
        pages = pages_cache[key]
        if not pages:
            review += 1
            continue
        doc, motivo = resolve_document_number(pages, c)
        if doc is None:
            review += 1
            log.info(f"(revisar) id={c['id']} sk={c['sk_supplier']}: {motivo}")
            continue
        if args.dry_run:
            changed += 1
            log.info(f"(dry-run) id={c['id']} sk={c['sk_supplier']}: {c['invoice_number']!r} → {doc!r}")
            continue
        try:
            _patch_invoice(ctrl, c["id"], doc)
        except (urllib.error.URLError, TimeoutError):
            failed += 1
            log.exception(f"id={c['id']}: falha ao gravar {doc!r}")
            continue
        changed += 1
        log.info(f"id={c['id']} sk={c['sk_supplier']}: {c['invoice_number']!r} → {doc!r}")

    verb = "corrigiria" if args.dry_run else "corrigiu"
    log.info(f"Resumo: {verb} {changed}; {review} sem leitura inequívoca (revisar); {failed} falha(s).")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
