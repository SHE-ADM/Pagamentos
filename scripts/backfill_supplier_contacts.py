"""
backfill_supplier_contacts.py — Varre TODAS as contas (financial_account_control) em
busca de chave PIX, telefone e WhatsApp no texto ja gravado (assunto + descricao +
corpo do e-mail) e grava no cadastro do fornecedor (supplier), com a MESMA logica de
2 slots da extracao (read_emails.parse_supplier_contacts + _contact_slot_update /
_phone_slot_update). Fonte unica do parser: nao ha logica duplicada aqui.

  - Chave PIX: so com rotulo "pix" por perto (anti-falso-positivo).
  - Telefone: formato "(DD) NNNNN-NNNN" ou rotulado; DDD default 11 quando ausente.
  - WhatsApp: so rotulado (whats/zap).

Lógica de slot (por fornecedor, dentro do run): preenche o slot 1 se vazio; o slot 2
so quando o 1 ja tem OUTRO valor; no-op se ja presente ou ambos cheios. Idempotente
(rodar de novo reporta 0 mudancas). Pula a OTIMOTEX (sk_supplier=1).

Uso:
    py -3 scripts/backfill_supplier_contacts.py --dry-run   # so lista o que gravaria
    py -3 scripts/backfill_supplier_contacts.py             # aplica
"""

import sys, re, json, argparse, logging, urllib.request
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("backfill-supplier-contacts")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_PAGE = 1000  # PostgREST devolve no maximo ~1000 linhas por request; pagina por offset.
_OTIMOTEX = getattr(R, "OTIMOTEX_SK_SUPPLIER", 1)


def _get(ctrl, path: str) -> list:
    req = urllib.request.Request(ctrl.base + "/rest/v1/" + path, headers=ctrl.headers)
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def _get_all(ctrl, path: str) -> list:
    """GET paginado por offset (une 'path' com &limit/&offset)."""
    rows, offset = [], 0
    sep = "&" if "?" in path else "?"
    while True:
        page = _get(ctrl, f"{path}{sep}limit={_PAGE}&offset={offset}")
        rows.extend(page)
        if len(page) < _PAGE:
            return rows
        offset += _PAGE


def _patch_supplier(ctrl, sk: int, updates: dict) -> None:
    body = json.dumps(updates).encode()
    req = urllib.request.Request(
        ctrl.base + f"/rest/v1/supplier?sk_supplier=eq.{int(sk)}",
        data=body, method="PATCH",
        headers={**ctrl.headers, "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15)


def _dedup_append(seq: list, value) -> None:
    if value and value not in seq:
        seq.append(value)


def collect_contacts_by_supplier(accounts: list, exclude_pix: set) -> dict:
    """Agrupa por sk_supplier os contatos detectados (preservando a ordem de 1a
    aparicao, para o slot 1 receber o mais antigo). Pula OTIMOTEX e contas sem sk.
    `exclude_pix` = digitos que nunca viram chave PIX (CNPJ da propria empresa)."""
    by_sk: dict[int, dict] = {}
    for acc in accounts:
        sk = acc.get("sk_supplier")
        if not sk or sk == _OTIMOTEX:
            continue
        text = "\n".join(str(acc.get(k) or "") for k in ("subject", "description", "email_body_excerpt"))
        c = R.parse_supplier_contacts(text, exclude_pix=exclude_pix)
        if not any(c.values()):
            continue
        bucket = by_sk.setdefault(sk, {"pix": [], "phone": [], "whatsapp": []})
        _dedup_append(bucket["pix"], c["pix"])
        _dedup_append(bucket["phone"], c["phone"])
        _dedup_append(bucket["whatsapp"], c["whatsapp"])
    return by_sk


def compute_updates(supplier_row: dict, detected: dict) -> dict:
    """Aplica a logica de slot (reusa os helpers de read_emails) sobre uma COPIA da
    linha do fornecedor, acumulando as deteccoes em ordem. Retorna o dict de colunas
    a gravar (vazio => nada muda)."""
    working = dict(supplier_row)
    updates: dict = {}
    for pix in detected["pix"]:
        u = R._contact_slot_update(working.get("pix_key1"), working.get("pix_key2"),
                                   "pix_key1", "pix_key2", pix)
        working.update(u); updates.update(u)
    for wa in detected["whatsapp"]:
        u = R._contact_slot_update(working.get("whatsapp1"), working.get("whatsapp2"),
                                   "whatsapp1", "whatsapp2", wa)
        working.update(u); updates.update(u)
    for ddd, fone in detected["phone"]:
        u = R._phone_slot_update(working, ddd, fone)
        working.update(u); updates.update(u)
    return updates


_SELECT_SUPPLIER = ("sk_supplier,pix_key1,pix_key2,phone_ddd1,phone1,phone_ddd2,"
                    "phone2,whatsapp1,whatsapp2")


def _own_cnpj_exclusion(ctrl) -> set:
    """CNPJ da propria empresa (pagador) — nunca vira chave PIX do fornecedor."""
    own = ctrl.company_cnpj() if hasattr(ctrl, "company_cnpj") else None
    return {re.sub(r"\D", "", own)} if own else set()


def _load_suppliers(ctrl, sks: list) -> dict:
    """Carrega as linhas dos fornecedores afetados (uma pagina por lote de 100 sks)."""
    suppliers: dict[int, dict] = {}
    for i in range(0, len(sks), 100):
        ids = ",".join(str(s) for s in sks[i:i + 100])
        for row in _get(ctrl, f"supplier?select={_SELECT_SUPPLIER}&sk_supplier=in.({ids})"):
            suppliers[row["sk_supplier"]] = row
    return suppliers


def _apply_supplier(ctrl, sk: int, row: "dict | None", detected: dict, dry_run: bool) -> bool:
    """Calcula e grava (ou simula) o update de um fornecedor. Retorna True se mudou."""
    if row is None:
        log.warning(f"Fornecedor sk={sk} nao encontrado — pulando")
        return False
    updates = compute_updates(row, detected)
    if not updates:
        return False
    detail = ", ".join(f"{k}={v}" for k, v in updates.items())
    if dry_run:
        log.info(f"(dry-run) supplier sk={sk} -> {detail}")
    else:
        _patch_supplier(ctrl, sk, updates)
        log.info(f"supplier sk={sk} -> {detail}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill de contatos do fornecedor a partir das contas.")
    ap.add_argument("--dry-run", action="store_true", help="So lista o que gravaria, sem PATCH.")
    args = ap.parse_args()

    ctrl = R.SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponivel — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        return 1

    accounts = _get_all(
        ctrl, "financial_account_control?select=id,sk_supplier,subject,description,email_body_excerpt&order=id")
    log.info(f"Contas lidas: {len(accounts)}")

    by_sk = collect_contacts_by_supplier(accounts, _own_cnpj_exclusion(ctrl))
    log.info(f"Fornecedores com contato detectado: {len(by_sk)}")
    if not by_sk:
        return 0

    sks = sorted(by_sk.keys())
    suppliers = _load_suppliers(ctrl, sks)
    changed = sum(_apply_supplier(ctrl, sk, suppliers.get(sk), by_sk[sk], args.dry_run) for sk in sks)

    verb = "gravaria" if args.dry_run else "gravou"
    log.info(f"Resumo: {verb} em {changed} fornecedor(es); {len(sks) - changed} sem mudanca / nao encontrado.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
