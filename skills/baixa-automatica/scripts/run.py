#!/usr/bin/env python3
"""
run.py - Baixa automatica de contas pagas + marcacao de titulos vencidos
          (skill `baixa-automatica`).

Duas regras de negocio INDEPENDENTES sobre `financial_account_control`, cada uma com
suas proprias funcoes (nao compartilham logica de elegibilidade nem status alvo):

1. BAIXA (pago) - regra original, fonte unica espelhada no frontend
   `qualifiesForAutoPago` de /consulta: uma conta a pagar cuja curadoria confirma NF
   (has_invoice) E Boleto (has_bank_slip), com vencimento (due_date) <= hoje e ainda EM
   ABERTO (pendente / vencido / a vencer -> status_id 1/2/3), e considerada PAGA ->
   status_id passa a 8 (pago). build_filter/count_eligible/apply_baixa.

2. VENCIDO - nova regra: uma conta EM ABERTO (pendente ou a vencer -> status_id 1/3;
   NAO inclui vencido=2, ja e o alvo) cujo vencimento (due_date) e ANTERIOR a hoje
   (estritamente < , nao <=: quem vence HOJE ainda esta 'a vencer') e considerada
   VENCIDA -> status_id passa a 2 (vencido). build_filter_vencido/count_eligible_vencido/
   apply_vencido. Mesma semantica da trigger de banco fn_set_status_from_due_date.

As duas regras cobrem o mesmo problema estrutural: a trigger `fn_set_status_from_due_date`
so recalcula status_id em INSERT/UPDATE da linha - sem nenhuma edicao, o vencimento
"passa" com o tempo sem nada disparar a transicao (nem para pago, nem para vencido). Este
batch roda 1x/dia as 08:00 na maquina de producao (Windows Task Scheduler), no mesmo
padrao das skills `email-reader` e `cobranca-vencidos`, e aplica as DUAS regras em
sequencia, cada uma isolada em seu proprio try/except (falha numa nao impede a outra).

Uso:
  py -3 run.py            # aplica baixa + marcacao de vencidos (PATCH via service_role)
  py -3 run.py --dry-run  # so reporta quantas contas SERIAM afetadas (nao grava)

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


# =============================================================================
# NOVA REGRA: marcacao de titulos VENCIDOS. Funcoes totalmente independentes das
# de cima (build_filter/_url/count_eligible/apply_baixa permanecem intocadas) -
# proprio filtro, propria URL, propria elegibilidade, proprio status alvo.
# =============================================================================

# Situacoes EM ABERTO elegiveis a virar "vencido": pendente(1) e a vencer(3). NAO
# inclui vencido(2, ja e o alvo) nem os estados fechados (4 prorrogado, 5 baixado,
# 6 protestado, 7 cartorio, 8 pago, 9 cancelado, 10 falha) - preservados.
VENCIDO_ELIGIBLE_STATUS_IDS = (1, 3)  # pendente / a vencer
STATUS_ID_VENCIDO = 2


def build_filter_vencido(today: str) -> str:
    """Filtro PostgREST dos titulos elegiveis a virar "vencido" (em aberto +
    vencimento ANTERIOR a hoje). `due_date=lt.<today>` (estritamente menor, NAO
    `lte`) - uma conta que vence HOJE ainda esta 'a vencer'; so vira 'vencido' a
    partir do dia seguinte. Mesma semantica da trigger de banco
    fn_set_status_from_due_date (due_date < ref_date -> vencido)."""
    ids = ",".join(str(i) for i in VENCIDO_ELIGIBLE_STATUS_IDS)
    return f"status_id=in.({ids})&due_date=lt.{today}"


def _url_vencido(extra: str = "") -> str:
    query = build_filter_vencido(date.today().isoformat())
    if extra:
        query = f"{query}&{extra}"
    return f"{_base_url()}/{TABLE}?{query}"


def count_eligible_vencido() -> int:
    """Quantos titulos seriam marcados como vencido - GET com count=exact (nao grava)."""
    req = urllib.request.Request(
        _url_vencido("select=id&limit=1"), method="GET", headers=_headers("count=exact")
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
        content_range = resp.headers.get("Content-Range", "*/0")
    total = content_range.split("/")[-1]
    return int(total) if total.isdigit() else 0


def apply_vencido() -> int:
    """Marca status_id = vencido nos titulos elegiveis; retorna quantos foram atualizados."""
    body = json.dumps({"status_id": STATUS_ID_VENCIDO}).encode("utf-8")
    req = urllib.request.Request(
        _url_vencido("select=id"),
        data=body,
        method="PATCH",
        headers=_headers("return=representation"),
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
        rows = json.loads(resp.read() or b"[]")
    return len(rows)


def _run_baixa_step(*, dry_run: bool, today: str) -> bool:
    """Etapa 1 (INALTERADA): baixa automatica. Retorna True em sucesso, False em falha
    (logada) - isolada da etapa de vencidos, uma nao bloqueia a outra."""
    try:
        if dry_run:
            n = count_eligible()
            log.info("DRY-RUN: %d conta(s) seriam baixadas para 'pago' (vencimento <= %s).", n, today)
        else:
            n = apply_baixa()
            log.info(
                "Baixa automatica concluida: %d conta(s) marcadas como 'pago' (vencimento <= %s).",
                n, today,
            )
        return True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        log.exception("Falha HTTP %s na baixa automatica: %s", e.code, detail)
        return False
    except Exception:
        log.exception("Falha na baixa automatica")
        return False


def _run_vencido_step(*, dry_run: bool, today: str) -> bool:
    """Etapa 2 (NOVA): marcacao de titulos vencidos. Retorna True em sucesso, False em
    falha (logada) - isolada da etapa de baixa, uma nao bloqueia a outra."""
    try:
        if dry_run:
            n = count_eligible_vencido()
            log.info(
                "DRY-RUN: %d titulo(s) seriam marcados como 'vencido' (em aberto, vencimento < %s).",
                n, today,
            )
        else:
            n = apply_vencido()
            log.info(
                "Marcacao de vencidos concluida: %d titulo(s) marcados como 'vencido' (vencimento < %s).",
                n, today,
            )
        return True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        log.exception("Falha HTTP %s na marcacao de vencidos: %s", e.code, detail)
        return False
    except Exception:
        log.exception("Falha na marcacao de titulos vencidos")
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Baixa automatica de contas pagas (NF + Boleto, vencido, em aberto -> pago) "
            "e marcacao de titulos vencidos (pendente/a vencer + vencimento < hoje -> vencido)."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="So reporta quantas contas seriam baixadas/marcadas (nao grava).",
    )
    args = parser.parse_args(argv)

    try:
        _require_env()
    except Exception:
        log.exception("Falha de configuracao (variaveis de ambiente ausentes).")
        return 1

    today = date.today().isoformat()

    # ORDEM IMPORTA (nao regredir): uma conta com NF+Boleto confirmados E vencida e
    # elegivel pelas DUAS regras ao mesmo tempo. A baixa roda PRIMEIRO de proposito -
    # ao terminar, a conta ja esta status_id=8 (pago) e sai do filtro da etapa de
    # vencidos (status_id IN (1,3)), entao ela nunca e "rebaixada" para vencido. Se
    # a ordem for invertida, uma conta paga e vencida no mesmo dia seria marcada
    # como 'vencido' em vez de 'pago' - regra de negocio errada.
    #
    # Duas etapas independentes na falha: uma falhar nao impede a outra de rodar.
    # Exit code != 0 se QUALQUER uma falhar (o wrapper .ps1 marca a tarefa vermelha).
    baixa_ok   = _run_baixa_step(dry_run=args.dry_run, today=today)
    vencido_ok = _run_vencido_step(dry_run=args.dry_run, today=today)

    return 0 if (baixa_ok and vencido_ok) else 1


if __name__ == "__main__":
    sys.exit(main())
