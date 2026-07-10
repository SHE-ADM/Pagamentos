#!/usr/bin/env python3
"""
run.py - Baixa automatica de contas pagas (skill `baixa-automatica`).

Regra de negocio (fonte unica, espelhada no frontend `qualifiesForAutoPago` de
/consulta): uma conta a pagar cuja curadoria confirma NF (has_invoice) E Boleto
(has_bank_slip), com vencimento (due_date) <= hoje e ainda EM ABERTO (pendente /
vencido / a vencer -> status_id 1/2/3), e considerada PAGA -> status_id passa a 8 (pago).

Este batch cobre o caso em que o vencimento "passa" com o tempo sem nenhuma edicao
disparar a baixa no ato (o frontend so reage quando o usuario marca a 2a flag). Roda
1x/dia as 06:00 na maquina de producao (Windows Task Scheduler), no mesmo padrao das
skills `email-reader` e `cobranca-vencidos`.

Uso:
  py -3 run.py            # aplica a baixa (PATCH via service_role)
  py -3 run.py --dry-run  # so reporta quantas contas SERIAM baixadas (nao grava)

Le SUPABASE_URL / SUPABASE_SERVICE_KEY do .env na raiz do projeto. O papel service_role
ignora RLS (escrita direta na tabela principal).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

# .env na raiz do projeto: skills/baixa-automatica/scripts/run.py -> parents[3].
load_dotenv(Path(__file__).resolve().parents[3] / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("baixa-automatica")

# Situacoes EM ABERTO (dimensao `status`) - unicas convertidas para "pago". Preserva
# cancelado/baixado/protestado/cartorio/prorrogado e o que ja esta pago.
OPEN_STATUS_IDS = (1, 2, 3)  # pendente / vencido / a vencer
STATUS_ID_PAGO = 8
TABLE = "financial_account_control"
HTTP_TIMEOUT_SECONDS = 30


def build_filter(today: str) -> str:
    """Filtro PostgREST das contas elegiveis a baixa (NF + Boleto, vencido, em aberto)."""
    ids = ",".join(str(i) for i in OPEN_STATUS_IDS)
    return (
        "has_invoice=eq.true"
        "&has_bank_slip=eq.true"
        f"&due_date=lte.{today}"
        f"&status_id=in.({ids})"
    )


def _base_url() -> str:
    return os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"


def _headers(prefer: str) -> dict[str, str]:
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def _url(extra: str = "") -> str:
    query = build_filter(date.today().isoformat())
    if extra:
        query = f"{query}&{extra}"
    return f"{_base_url()}/{TABLE}?{query}"


def _require_env() -> None:
    missing = [v for v in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY") if not os.environ.get(v)]
    if missing:
        raise RuntimeError(f"Variaveis de ambiente ausentes no .env: {', '.join(missing)}")


def count_eligible() -> int:
    """Quantas contas seriam baixadas - GET com count=exact (nao grava nada)."""
    req = urllib.request.Request(
        _url("select=id&limit=1"), method="GET", headers=_headers("count=exact")
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
        # Content-Range: 0-0/135  -> o total exato vem apos a barra.
        content_range = resp.headers.get("Content-Range", "*/0")
    total = content_range.split("/")[-1]
    return int(total) if total.isdigit() else 0


def apply_baixa() -> int:
    """Marca status_id = pago nas contas elegiveis; retorna quantas foram atualizadas."""
    body = json.dumps({"status_id": STATUS_ID_PAGO}).encode("utf-8")
    req = urllib.request.Request(
        _url("select=id"),
        data=body,
        method="PATCH",
        headers=_headers("return=representation"),
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
        rows = json.loads(resp.read() or b"[]")
    return len(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Baixa automatica de contas pagas (NF + Boleto, vencido, em aberto -> pago)."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="So reporta quantas contas seriam baixadas (nao grava).",
    )
    args = parser.parse_args(argv)

    try:
        _require_env()
        today = date.today().isoformat()
        if args.dry_run:
            n = count_eligible()
            log.info("DRY-RUN: %d conta(s) seriam baixadas para 'pago' (vencimento <= %s).", n, today)
            return 0
        n = apply_baixa()
        log.info(
            "Baixa automatica concluida: %d conta(s) marcadas como 'pago' (vencimento <= %s).",
            n,
            today,
        )
        return 0
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        log.error("Falha HTTP %s na baixa automatica: %s", e.code, detail)
        return 1
    except Exception:
        log.exception("Falha na baixa automatica")
        return 1


if __name__ == "__main__":
    sys.exit(main())
