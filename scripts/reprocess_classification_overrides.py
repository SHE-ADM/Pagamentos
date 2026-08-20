"""
reprocess_classification_overrides.py — Aplica RETROATIVAMENTE a CLASSIFICACAO CONTABIL
por tipo de documento (mesma logica/fonte unica da extracao de e-mail:
read_emails.resolve_forced_classification).

  GUIA TRIBUTARIA (_is_tax_document)  -> relacionada ao plano de contas pelo TIPO/CONTEXTO do
    imposto (_resolve_tax_chart_code -> classification_for_account_code); precedencia MAXIMA,
    write-back True. Ex.: DAS/GNRE/DARE/DAM-DUAM/IPTU/IRRF/ICMS/ISS -> a conta "X a Recolher"
    correspondente (ver "Classificacao contabil FORCADA" no CLAUDE.md).
  TRANSPORTE (cte/frete, NAO-tributario) -> cost_center_id=4, chart_account_id=339 (write-back).

Deteccao por ASSUNTO + DESCRICAO do documento + REMETENTE. O write-back no supplier NUNCA
ocorre para a OTIMOTEX (sk_supplier=1). So altera a conta quando a classificacao diverge da atual.

CUIDADO: documentos MAL-ROTULADOS (boleto de fornecedor gravado como dare/dae) serao
reclassificados como imposto — revise o dry-run e corrija o document_type antes, se necessario.

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


def _apply_account_change(ctrl, acc: dict, cc: int, ca: int, dry_run: bool) -> bool:
    """Grava a nova classificacao na conta se divergir da atual. Retorna True se mudou."""
    if acc.get("cost_center_id") == cc and acc.get("chart_account_id") == ca:
        return False
    fac_id = acc["id"]
    if dry_run:
        log.info(f"(dry-run) conta id={fac_id} [{acc.get('document_type')}] "
                 f"cc {acc.get('cost_center_id')}->{cc} / ca {acc.get('chart_account_id')}->{ca}")
    else:
        _patch_account_classification(ctrl, fac_id, cc, ca)
        log.info(f"conta id={fac_id} [{acc.get('document_type')}] -> cc={cc} ca={ca}")
    return True


def _collect_writeback(acc: dict, cc: int, ca: int, write_back: bool, writebacks: dict) -> None:
    """Acumula o write-back do fornecedor (dedupe por sk; so write_back e nunca OTIMOTEX sk=1)."""
    sk = acc.get("sk_supplier")
    if not (write_back and sk and sk != R.OTIMOTEX_SK_SUPPLIER):
        return
    if sk in writebacks and writebacks[sk] != (cc, ca):
        log.warning(f"fornecedor {sk} com classificacoes conflitantes "
                    f"{writebacks[sk]} vs {(cc, ca)} — mantendo a primeira")
    else:
        writebacks.setdefault(sk, (cc, ca))


def reclassify_accounts(ctrl, dry_run: bool) -> "tuple[int, dict]":
    """Reclassifica as contas cujo assunto/descricao casa uma regra. Retorna (contas
    alteradas, write-backs pendentes {sk_supplier: (cc, ca)})."""
    rows = _get_all(ctrl, "financial_account_control?select=id,document_type,subject,"
                          "description,sender_email,cost_center_id,chart_account_id,sk_supplier")
    log.info(f"contas avaliadas: {len(rows)}")

    changed = 0
    writebacks: "dict[int, tuple[int, int]]" = {}
    for acc in rows:
        # sender_email alimenta a regra GNRE @lebianco -> ICMS-ST; sk_supplier permite a
        # exclusao de fornecedores nao-tributarios (ex.: Dr. Ricardo) — mesma logica da extracao.
        override = R.resolve_forced_classification(
            ctrl, acc.get("document_type"), acc.get("subject"), acc.get("description"),
            sender_email=acc.get("sender_email"), sk_supplier=acc.get("sk_supplier"))
        if not override:
            continue
        cc, ca, write_back = override
        if _apply_account_change(ctrl, acc, cc, ca, dry_run):
            changed += 1
        _collect_writeback(acc, cc, ca, write_back, writebacks)
    return changed, writebacks


def apply_supplier_writebacks(ctrl, writebacks: dict, dry_run: bool) -> int:
    """Grava a classificacao nos fornecedores (dedupe por sk). Reusa o metodo de
    producao update_supplier_classification (best-effort).

    🔴 ESTE SCRIPT NAO ENXERGA A PROCEDENCIA DO FORNECEDOR. No pipeline,
    `apply_forced_classification` SUPRIME o write-back quando o sk_supplier veio de um
    sinal FRACO (fallback 1b — o e-mail de quem ENCAMINHOU a guia): a guia e' do FISCO,
    nao do despachante. Aqui a marca `_supplier_signal` nao existe — ela e' efemera e nao
    e' persistida —, entao uma conta gravada por aquele caminho volta a ser candidata a
    write-back, e a exclusao `TAX_CLASSIFICATION_EXCLUDED_SK_SUPPLIERS` so protege quem ja
    foi descoberto e cadastrado a mao.

    A protecao aqui e' de VISIBILIDADE, nao automatica: todo write-back que SOBRESCREVE
    uma classificacao ja cadastrada e' marcado com [SOBRESCREVE], com o valor antigo e o
    novo, e aparece no --dry-run. Curadoria destruida em silencio era o risco; uma linha
    de log que o operador le antes de confirmar e' o que o torna uma decisao."""
    for sk, (cc, ca) in sorted(writebacks.items()):
        # Classificacao ATUAL do cadastro — (0, 0) quando nao ha nenhuma ou a leitura
        # falha (supplier_defaults e best-effort e nao levanta).
        atual_cc, atual_ca = ctrl.supplier_defaults(sk)
        sobrescreve = (atual_cc or atual_ca) and (atual_cc, atual_ca) != (cc, ca)
        aviso = (f"  [SOBRESCREVE] curadoria atual {atual_cc}/{atual_ca} -> {cc}/{ca} "
                 f"— confira se o sk {sk} e' o CREDOR e nao um intermediario/despachante"
                 if sobrescreve else "")
        if dry_run:
            log.info(f"(dry-run) supplier sk={sk} -> cc={cc} ca={ca}{aviso}")
        else:
            ctrl.update_supplier_classification(sk, cc, ca)
            log.info(f"supplier sk={sk} -> cc={cc} ca={ca}{aviso}")
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
