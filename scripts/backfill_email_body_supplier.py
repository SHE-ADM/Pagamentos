"""
backfill_email_body_supplier.py — Corrige fornecedor/CNPJ/barcode dos registros
historicos extraidos pelo corpo do e-mail (extraction_source='email_body').

Contexto: antes da correcao, extract_from_email_body nao lia o rotulo 'Fornecedor:'
nem o CNPJ do corpo e caia no fallback do e-mail do remetente. Este script reexecuta
a extracao melhorada a partir do email_body_excerpt JA armazenado e atualiza apenas
os campos derivados do fornecedor/boleto. O UPDATE dispara a trigger
trg_fe_resolve_supplier (migration 023), que re-resolve supplier_id pelo CNPJ.

Comprovantes/notificacoes de "pix recebido" (agora barrados pela guarda) sao
listados como candidatos a remocao — a exclusao e feita manualmente no SQL Editor.

Uso:
    py -3 scripts/backfill_email_body_supplier.py            # aplica as correcoes
    py -3 scripts/backfill_email_body_supplier.py --dry-run  # so mostra o antes/depois
"""

import sys, json, argparse, logging, urllib.request, urllib.parse, urllib.error
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")

sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
from read_emails import SupabaseControl, extract_from_email_body  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("backfill-email-body")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Campos derivados do fornecedor/boleto que o backfill recalcula a partir do corpo.
# supplier_name pode ir a NULL quando ha CNPJ — por isso o PATCH dedicado abaixo
# (e nao update_financial, que descarta None) precisa enviar nulls explicitos.
_PATCH_FIELDS = (
    "supplier_name", "supplier_cnpj", "supplier_cpf",
    "barcode", "document_type", "payment_method",
)


def fetch_email_body_rows(ctrl: SupabaseControl) -> list:
    """Linhas de financial_account_control extraidas pelo corpo do e-mail."""
    try:
        req = urllib.request.Request(
            f"{ctrl.base}/rest/v1/financial_account_control"
            "?extraction_source=eq.email_body"
            "&select=id,gmail_message_id,supplier_name,supplier_cnpj,barcode,"
            "sender_email,email_body_excerpt&order=id",
            headers=ctrl.headers,
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except Exception:
        log.exception("Erro ao buscar registros email_body")
        return []


def patch_financial(ctrl: SupabaseControl, record_id: int, fields: dict) -> bool:
    """PATCH que envia tambem valores None (NULL) — necessario para limpar o
    supplier_name errado quando o fornecedor passa a ser resolvido pelo CNPJ."""
    try:
        data = json.dumps(fields).encode()
        req = urllib.request.Request(
            f"{ctrl.base}/rest/v1/financial_account_control?id=eq.{record_id}",
            data=data,
            headers={**ctrl.headers, "Prefer": "return=minimal"},
            method="PATCH",
        )
        urllib.request.urlopen(req, timeout=10)
        return True
    except urllib.error.HTTPError as e:
        log.error(f"  Falha PATCH id={record_id}: {e.code} {e.read().decode(errors='replace')[:150]}")
        return False
    except Exception:
        log.exception(f"  Falha PATCH id={record_id}")
        return False


def process_row(ctrl: SupabaseControl, row: dict, dry_run: bool) -> str:
    """Reprocessa uma linha email_body. Retorna a categoria do resultado:
    'updated' | 'unchanged' | 'to_remove' | 'failed'."""
    rid      = row["id"]
    old_name = row.get("supplier_name")
    excerpt  = row.get("email_body_excerpt") or ""
    mid      = (row.get("gmail_message_id") or "").split("#")[0]

    # Rows historicas tem sender_email NULL (coluna criada na migration 023, depois
    # destes registros). Usar o supplier_name atual como fallback evita rebaixar
    # para "desconhecido" os casos sem rotulo/CNPJ (ex.: faturas SmartWebServices),
    # preservando a melhor informacao ja existente.
    fallback = row.get("sender_email") or row.get("supplier_name")
    payload = extract_from_email_body(excerpt, "", mid, fallback)

    # Guarda de comprovante/recebido → nao e conta a pagar: candidato a remocao.
    if payload is None:
        log.warning(f"[{rid}] CANDIDATO A REMOCAO (comprovante/recebido) — "
                    f"fornecedor atual: {old_name}")
        return "to_remove"

    new_fields = {f: payload.get(f) for f in _PATCH_FIELDS}

    # Nada mudou nos campos-chave (nome/CNPJ/barcode) → pula.
    if (new_fields["supplier_name"] == old_name
            and new_fields["supplier_cnpj"] == row.get("supplier_cnpj")
            and new_fields["barcode"] == row.get("barcode")):
        return "unchanged"

    log.info(
        f"[{rid}] {old_name!r} → {new_fields['supplier_name']!r} | "
        f"CNPJ={new_fields['supplier_cnpj']} | barcode={new_fields['barcode']}"
    )

    if dry_run:
        return "updated"
    return "updated" if patch_financial(ctrl, rid, new_fields) else "failed"


def main():
    parser = argparse.ArgumentParser(
        description="Reprocessa fornecedor/CNPJ/barcode dos registros email_body"
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="Mostra o antes/depois sem aplicar")
    args = parser.parse_args()

    ctrl = SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponivel — verifique SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        sys.exit(1)

    rows = fetch_email_body_rows(ctrl)
    log.info(f"Registros email_body encontrados: {len(rows)}")

    tally = {"updated": 0, "unchanged": 0, "to_remove": 0, "failed": 0}
    for row in rows:
        tally[process_row(ctrl, row, args.dry_run)] += 1

    updated, unchanged = tally["updated"], tally["unchanged"]
    to_remove, failed  = tally["to_remove"], tally["failed"]

    log.info("=" * 60)
    log.info(f"  {'(dry-run) ' if args.dry_run else ''}Atualizados   : {updated}")
    log.info(f"  Sem alteracao              : {unchanged}")
    log.info(f"  Candidatos a remocao       : {to_remove} (excluir no SQL Editor)")
    log.info(f"  Falhas                     : {failed}")
    log.info("=" * 60)
    if to_remove:
        log.info("Remocao manual sugerida: DELETE FROM financial_account_control "
                 "WHERE id IN (158, 174);  -- conferir ids acima")


if __name__ == "__main__":
    main()
