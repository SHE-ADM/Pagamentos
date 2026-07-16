"""
reprocess_beneficiario_final.py — Aplica RETROATIVAMENTE a regra "Beneficiário Final
SEMPRE vence Beneficiário/Cedente" (boleto securitizado): o fornecedor da conta deve ser
o BENEFICIÁRIO FINAL (credor real), não a securitizadora/empresa de cobrança (cedente).

Varre as contas com PDF disponível (`extraction_source='pdf_text'` + `source_file`), baixa
o PDF do bucket, extrai o "Beneficiário Final" (mesmo extractor da extração:
extract_pdf.extract_beneficiario_final) e, quando o CNPJ do beneficiário final DIFERE do
fornecedor atual, resolve/cria esse fornecedor (RPC de resolução, mesma da extração) e
re-aponta `financial_account_control.sk_supplier`.

Conservador: só corrige quando o beneficiário final tem **CNPJ** (chave forte); casos
name-only são apenas LOGADOS para revisão manual. Idempotente (rodar de novo → 0 mudanças).

Uso:
    py -3 scripts/reprocess_beneficiario_final.py --dry-run   # só lista o que faria
    py -3 scripts/reprocess_beneficiario_final.py             # aplica
"""

import sys, re, json, argparse, logging, tempfile, urllib.parse, urllib.request
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(BASE_DIR / "skills" / "pdf-contas-pagar" / "scripts"))
import read_emails as R      # noqa: E402  (SupabaseControl: base/headers/resolve_supplier)
import extract_pdf as E      # noqa: E402  (extract_beneficiario_final — fonte única)
import pdfplumber            # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("reprocess-beneficiario-final")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_PAGE = 1000
_SELECT = "id,sk_supplier,source_file,supplier(cnpj,trade_name)"


def _get_all(ctrl, path: str) -> list:
    rows, offset = [], 0
    sep = "&" if "?" in path else "?"
    while True:
        req = urllib.request.Request(ctrl.base + "/rest/v1/" + f"{path}{sep}limit={_PAGE}&offset={offset}",
                                     headers=ctrl.headers)
        page = json.loads(urllib.request.urlopen(req, timeout=30).read())
        rows.extend(page)
        if len(page) < _PAGE:
            return rows
        offset += _PAGE


def _download_text(ctrl, storage_key: str) -> "str | None":
    """Baixa o objeto do bucket `attachments` e devolve o texto (pdfplumber). None em
    qualquer falha (objeto ausente, PDF cifrado ilegível, etc.) — não é fatal."""
    try:
        url = f"{ctrl.base}/storage/v1/object/attachments/{urllib.parse.quote(storage_key)}"
        req = urllib.request.Request(url, headers={"apikey": ctrl.key,
                                                   "Authorization": f"Bearer {ctrl.key}"})
        data = urllib.request.urlopen(req, timeout=30).read()
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
            tf.write(data)
            tmp = tf.name
        try:
            with pdfplumber.open(tmp) as pdf:
                return "\n".join((p.extract_text() or "") for p in pdf.pages)
        finally:
            Path(tmp).unlink(missing_ok=True)
    except Exception as e:
        log.info(f"  (pulado) falha ao baixar/ler {storage_key}: {e}")
        return None


def _patch_sk(ctrl, fac_id: int, new_sk: int) -> None:
    body = json.dumps({"sk_supplier": new_sk}).encode()
    req = urllib.request.Request(
        ctrl.base + f"/rest/v1/financial_account_control?id=eq.{fac_id}",
        data=body, method="PATCH",
        headers={**ctrl.headers, "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15)


def main() -> int:
    ap = argparse.ArgumentParser(description="Corrige fornecedor = Beneficiário Final do boleto.")
    ap.add_argument("--dry-run", action="store_true", help="Só lista o que faria, sem PATCH.")
    ap.add_argument("--ids", help="Restringe a estes ids (CSV), ex.: 561,562.")
    args = ap.parse_args()

    ctrl = R.SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponivel — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        return 1

    path = f"financial_account_control?select={_SELECT}&extraction_source=eq.pdf_text&source_file=not.is.null&order=id"
    if args.ids:
        ids = ",".join(str(int(x)) for x in args.ids.split(","))
        path += f"&id=in.({ids})"
    contas = _get_all(ctrl, path)
    log.info(f"Contas com PDF a inspecionar: {len(contas)}")

    changed = review = 0
    for c in contas:
        text = _download_text(ctrl, c["source_file"])
        if not text:
            continue
        bname, bcnpj = E.extract_beneficiario_final(text)
        if not (bname or bcnpj):
            continue
        cur = c.get("supplier") or {}
        cur_cnpj = re.sub(r"\D", "", cur.get("cnpj") or "")
        cur_name = cur.get("trade_name") or f"sk={c['sk_supplier']}"
        if not bcnpj:
            review += 1
            log.info(f"(revisar) id={c['id']}: beneficiário final SEM CNPJ '{bname}' (atual: {cur_name})")
            continue
        if bcnpj == cur_cnpj:
            continue  # já é o beneficiário final
        changed += 1
        if args.dry_run:
            log.info(f"(dry-run) id={c['id']}: {cur_name} ({cur_cnpj or '—'}) → {bname} ({bcnpj})")
        else:
            new_sk = ctrl.resolve_supplier({"supplier_cnpj": bcnpj, "supplier_name": bname})
            if new_sk and new_sk != c["sk_supplier"]:
                _patch_sk(ctrl, c["id"], new_sk)
                log.info(f"id={c['id']}: sk {c['sk_supplier']} ({cur_name}) → {new_sk} ({bname} / {bcnpj})")
            else:
                log.info(f"id={c['id']}: resolução não mudou o fornecedor (sk={new_sk}) — pulado")
                changed -= 1

    verb = "corrigiria" if args.dry_run else "corrigiu"
    log.info(f"Resumo: {verb} {changed} conta(s); {review} para revisão manual (benef. final sem CNPJ).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
