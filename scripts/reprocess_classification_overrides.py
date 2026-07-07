"""
reprocess_classification_overrides.py — Aplica RETROATIVAMENTE as regras de classificacao
contabil FORCADA por tipo de documento (mesma logica da extracao de e-mail):

  IRRF                       -> cost_center_id=3,  chart_account_id=28   (NAO grava no supplier)
  DUIMP / ICMS Importacao    -> cost_center_id=3,  chart_account_id=11   (grava no supplier)
  Transporte/transportadora/cte -> cost_center_id=4, chart_account_id=339 (grava no supplier)
  DAM / DUAM                 -> classificacao do plano de contas 4.1.06   (NAO grava no supplier)
  GNRE ICMS Subst. Tributaria -> classificacao do plano de contas 4.1.02  (NAO grava no supplier)
    (gatilho: frase de ST no texto OU remetente do dominio @lebianco)

Deteccao por ASSUNTO + DESCRICAO do documento + REMETENTE (via
read_emails.resolve_forced_classification — fonte unica; DAM/DUAM e GNRE-ST resolvem a
classificacao da tabela financial_chart_of_account pelos codigos 4.1.06 e 4.1.02). O write-back
no supplier NUNCA ocorre para a OTIMOTEX (sk_supplier=1).

Uso:
    py -3 scripts/reprocess_classification_overrides.py --dry-run   # so lista o que faria
    py -3 scripts/reprocess_classification_overrides.py             # aplica
"""

import sys, json, argparse, logging, urllib.request
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("reprocess-classification")
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


def _patch_account_classification(ctrl, fac_id: int, cost_center_id: int, chart_account_id: int) -> None:
    body = json.dumps({"cost_center_id": cost_center_id,
                       "chart_account_id": chart_account_id}).encode()
    req = urllib.request.Request(
        ctrl.base + f"/rest/v1/financial_account_control?id=eq.{fac_id}",
        data=body, method="PATCH",
        headers={**ctrl.headers, "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15)


def reclassify_accounts(ctrl, dry_run: bool) -> "tuple[int, dict]":
    """Reclassifica as contas cujo assunto/descricao casa uma regra. Retorna (contas
    alteradas, write-backs pendentes {sk_supplier: (cc, ca)})."""
    rows = _get_all(ctrl, "financial_account_control?select=id,document_type,subject,"
                          "description,sender_email,cost_center_id,chart_account_id,sk_supplier")
    log.info(f"contas avaliadas: {len(rows)}")

    changed = 0
    writebacks: "dict[int, tuple[int, int]]" = {}
    for acc in rows:
        # sender_email alimenta a regra GNRE @lebianco -> ICMS-ST (mesma logica da extracao).
        override = R.resolve_forced_classification(
            ctrl, acc.get("document_type"), acc.get("subject"), acc.get("description"),
            sender_email=acc.get("sender_email"))
        if not override:
            continue
        cc, ca, write_back = override
        fac_id = acc["id"]

        # Conta: so grava se divergir da classificacao atual.
        if acc.get("cost_center_id") != cc or acc.get("chart_account_id") != ca:
            changed += 1
            if dry_run:
                log.info(f"(dry-run) conta id={fac_id} [{acc.get('document_type')}] "
                         f"cc {acc.get('cost_center_id')}->{cc} / ca {acc.get('chart_account_id')}->{ca}")
            else:
                _patch_account_classification(ctrl, fac_id, cc, ca)
                log.info(f"conta id={fac_id} [{acc.get('document_type')}] -> cc={cc} ca={ca}")

        # Write-back no supplier: so tipos com write_back e nunca OTIMOTEX (sk=1).
        sk = acc.get("sk_supplier")
        if write_back and sk and sk != R.OTIMOTEX_SK_SUPPLIER:
            if sk in writebacks and writebacks[sk] != (cc, ca):
                log.warning(f"fornecedor {sk} com classificacoes conflitantes "
                            f"{writebacks[sk]} vs {(cc, ca)} — mantendo a primeira")
            else:
                writebacks.setdefault(sk, (cc, ca))
    return changed, writebacks


def apply_supplier_writebacks(ctrl, writebacks: dict, dry_run: bool) -> int:
    """Grava a classificacao nos fornecedores (dedupe por sk). Reusa o metodo de
    producao update_supplier_classification (best-effort)."""
    for sk, (cc, ca) in sorted(writebacks.items()):
        if dry_run:
            log.info(f"(dry-run) supplier sk={sk} -> cc={cc} ca={ca}")
        else:
            ctrl.update_supplier_classification(sk, cc, ca)
            log.info(f"supplier sk={sk} -> cc={cc} ca={ca}")
    return len(writebacks)


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Backfill das regras de classificacao contabil forcada (IRRF/DUIMP/ICMS/transporte)")
    ap.add_argument("--dry-run", action="store_true", help="Lista sem alterar")
    args = ap.parse_args()

    ctrl = R.SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponivel — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        sys.exit(1)

    log.info("=" * 60)
    log.info("Reclassificando contas por tipo de documento (IRRF/DUIMP/ICMS/transporte)")
    changed, writebacks = reclassify_accounts(ctrl, args.dry_run)

    log.info("=" * 60)
    log.info("Write-back da classificacao nos fornecedores (exceto OTIMOTEX sk=1)")
    suppliers = apply_supplier_writebacks(ctrl, writebacks, args.dry_run)

    log.info("=" * 60)
    pre = "(dry-run) " if args.dry_run else ""
    log.info(f"  {pre}Contas reclassificadas   : {changed}")
    log.info(f"  Fornecedores atualizados : {suppliers}")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
