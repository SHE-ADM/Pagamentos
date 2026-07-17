"""
reprocess_cte_accounts.py — Alinha os dados JA gravados a nova regra de CT-e/
transporte (ver regras 1-5 do plano CTe): o CT-e (documento fiscal) NAO e conta a
pagar; so o BOLETO de frete e. Um boleto de transporte fica rotulado 'cte'.

Duas fases (executar A antes de B):

  A) RE-ROTULAR boletos de transporte (regra 4 retroativa): contas com
     document_type='boleto' cujo FORNECEDOR e transportadora (nome com
     transporte(s)/transportadora/logistica/cargas/encomendas/frete(s)) viram
     document_type='cte'. Assim a Fase B nao as apaga (elas SAO boleto).

  B) EXCLUIR CT-e nao-boleto (regra 3): contas com document_type='cte' que NAO
     sejam boleto (sem codigo de barras de boleto valido e payment_method != 'boleto')
     sao um CT-e fiscal que nao deveria ter virado conta — HARD DELETE. Depois, o
     e-mail correspondente que ficar SEM nenhuma conta vira status='ignorado'
     (espelha a Fase B de reprocess_ignored_emails.py).

Reusa read_emails._is_boleto_barcode e _is_transport_supplier (fonte unica da regra).

Uso:
    py -3 scripts/reprocess_cte_accounts.py --dry-run   # so lista o que faria
    py -3 scripts/reprocess_cte_accounts.py             # aplica (re-rotula + exclui)
"""

import sys, json, argparse, logging, urllib.parse, urllib.request
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402

_PREFER_MINIMAL = "return=minimal"  # header PostgREST reutilizado (S1192)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("reprocess-cte")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_PAGE = 1000  # PostgREST devolve no maximo ~1000 linhas por request; pagina por offset.


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


def _patch_account_doc_type(ctrl, fac_id: int, document_type: str) -> None:
    body = json.dumps({"document_type": document_type}).encode()
    req = urllib.request.Request(
        ctrl.base + f"/rest/v1/financial_account_control?id=eq.{fac_id}",
        data=body, method="PATCH",
        headers={**ctrl.headers, "Prefer": _PREFER_MINIMAL})
    urllib.request.urlopen(req, timeout=15)


def _delete_account(ctrl, fac_id: int) -> None:
    req = urllib.request.Request(
        ctrl.base + f"/rest/v1/financial_account_control?id=eq.{fac_id}",
        method="DELETE", headers={**ctrl.headers, "Prefer": _PREFER_MINIMAL})
    urllib.request.urlopen(req, timeout=15)


def _patch_email_ignored(ctrl, message_id: str, note: str) -> None:
    mid = urllib.parse.quote(message_id, safe="")
    body = json.dumps({"status": "ignorado", "notes": note}).encode()
    req = urllib.request.Request(
        ctrl.base + f"/rest/v1/email_control?message_id=eq.{mid}",
        data=body, method="PATCH",
        headers={**ctrl.headers, "Prefer": _PREFER_MINIMAL})
    urllib.request.urlopen(req, timeout=15)


def _base_message_id(gmail_message_id: "str | None") -> "str | None":
    """gmail_message_id de conta pode ter sufixo '#N' (multiplos PDFs no mesmo
    e-mail). O email_control.message_id e a parte antes do '#'."""
    if not gmail_message_id:
        return None
    return gmail_message_id.split("#", 1)[0]


def _account_count_for(ctrl, message_id: str) -> int:
    """Quantas contas ainda existem para um e-mail (base message_id + sufixos #N)."""
    like = urllib.parse.quote(message_id + "*", safe="")
    rows = _get(ctrl, f"financial_account_control?gmail_message_id=like.{like}&select=id")
    return len(rows)


def _is_boleto_account(acc: dict) -> bool:
    """Conta e um BOLETO pagavel: codigo de barras de boleto valido OU
    payment_method='boleto' (conservador — na duvida, preserva)."""
    return (R._is_boleto_barcode(acc.get("barcode"))
            or (acc.get("payment_method") or "").strip().lower() == "boleto")


def phase_a_relabel(ctrl, dry_run: bool) -> int:
    """Re-rotula boletos de fornecedor de transporte -> document_type='cte'."""
    rows = _get_all(ctrl, "financial_account_control?document_type=eq.boleto"
                          "&select=id,supplier(trade_name,legal_name)")
    log.info(f"[A] contas document_type='boleto': {len(rows)}")
    changed = 0
    for acc in rows:
        sup = acc.get("supplier") or {}
        trade, legal = sup.get("trade_name"), sup.get("legal_name")
        # Casa transportadora tanto pelo nome fantasia QUANTO pela razao social.
        if not (R._is_transport_supplier(trade) or R._is_transport_supplier(legal)):
            continue
        name = trade or legal
        changed += 1
        if dry_run:
            log.info(f"[A] (dry-run) id={acc['id']} boleto -> cte (fornecedor: {name!r})")
        else:
            _patch_account_doc_type(ctrl, acc["id"], "cte")
            log.info(f"[A] id={acc['id']} boleto -> cte (fornecedor: {name!r})")
    return changed


def phase_b_delete(ctrl, dry_run: bool) -> "tuple[int, int]":
    """Exclui CT-e nao-boleto e marca o e-mail orfao como 'ignorado'."""
    rows = _get_all(ctrl, "financial_account_control?document_type=eq.cte"
                          "&select=id,barcode,payment_method,amount,gmail_message_id,"
                          "supplier(trade_name,legal_name)")
    log.info(f"[B] contas document_type='cte': {len(rows)}")
    to_delete = [a for a in rows if not _is_boleto_account(a)]
    kept = len(rows) - len(to_delete)
    log.info(f"[B] mantidas (sao boleto): {kept} · a excluir (CT-e fiscal): {len(to_delete)}")

    affected_mids: set[str] = set()
    for acc in to_delete:
        mid = _base_message_id(acc.get("gmail_message_id"))
        if mid:
            affected_mids.add(mid)
        sup = acc.get("supplier") or {}
        name = sup.get("trade_name") or sup.get("legal_name")
        if dry_run:
            log.info(f"[B] (dry-run) DELETE id={acc['id']} cte R$ {acc.get('amount')} "
                     f"({name!r})")
        else:
            _delete_account(ctrl, acc["id"])
            log.info(f"[B] DELETE id={acc['id']} cte R$ {acc.get('amount')} ({name!r})")

    # E-mails que ficaram sem nenhuma conta -> 'ignorado'.
    ignored = 0
    for mid in sorted(affected_mids):
        remaining = 0 if dry_run else _account_count_for(ctrl, mid)
        # No dry-run nao apagamos, entao estimamos: sobra so o que NAO sera apagado.
        if dry_run:
            remaining = _account_count_for(ctrl, mid) - sum(
                1 for a in to_delete if _base_message_id(a.get("gmail_message_id")) == mid)
        if remaining <= 0:
            ignored += 1
            note = "CT-e/transporte sem boleto — nao gera conta a pagar (limpeza)"
            if dry_run:
                log.info(f"[B] (dry-run) email {mid} -> ignorado")
            else:
                _patch_email_ignored(ctrl, mid, note)
                log.info(f"[B] email {mid} -> ignorado")
    return len(to_delete), ignored


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Alinha contas CT-e/transporte a nova regra (re-rotula boletos + exclui CT-e fiscal)")
    ap.add_argument("--dry-run", action="store_true", help="Lista sem alterar/excluir")
    args = ap.parse_args()

    ctrl = R.SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponivel — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        sys.exit(1)

    log.info("=" * 60)
    log.info("Fase A — re-rotular boletos de transporte -> cte")
    relabeled = phase_a_relabel(ctrl, args.dry_run)

    log.info("=" * 60)
    log.info("Fase B — excluir CT-e nao-boleto + e-mails orfaos -> ignorado")
    deleted, ignored = phase_b_delete(ctrl, args.dry_run)

    log.info("=" * 60)
    pre = "(dry-run) " if args.dry_run else ""
    log.info(f"  {pre}Boletos re-rotulados p/ cte : {relabeled}")
    log.info(f"  CT-e fiscais excluidas       : {deleted}")
    log.info(f"  E-mails -> ignorado          : {ignored}")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
