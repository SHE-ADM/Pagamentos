"""
run.py -- Entry-point da skill cobranca-vencidos
Invocado diretamente pelo Windows Task Scheduler as 08:00.

Uso:
    py -3 skills/cobranca-vencidos/scripts/run.py
    py -3 skills/cobranca-vencidos/scripts/run.py --dry-run
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import sys
import time
import traceback
from pathlib import Path

# ---------------------------------------------------------------------------
# sys.path -- diretório dos scripts da skill (mesmo padrão de server/app.py com
# read_emails): a pasta tem hífen (cobranca-vencidos), inválido como nome de
# pacote Python, então os módulos irmãos são importados como top-level.
# ---------------------------------------------------------------------------
SCRIPTS_DIR  = Path(__file__).resolve().parent
PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(SCRIPTS_DIR))

# ---------------------------------------------------------------------------
# .env -- antes de qualquer import da skill
# ---------------------------------------------------------------------------
from dotenv import load_dotenv  # noqa: E402
load_dotenv(PROJECT_ROOT / ".env")

# ---------------------------------------------------------------------------
# Imports da skill (módulos irmãos em SCRIPTS_DIR)
# ---------------------------------------------------------------------------
from db_firebird  import fetch_titulos_vencidos   # noqa: E402
from email_sender import SmtpSession              # noqa: E402
from send_core    import send_and_log, validate_email  # noqa: E402
from supabase_log import (                        # noqa: E402
    already_sent,
    delete_erro_rows_by_document_id,
    fetch_company_smtp,
    fetch_error_document_ids,
    log_envio_erro,
)

# ---------------------------------------------------------------------------
# Logging -- arquivo rotativo 30 dias + console
# ---------------------------------------------------------------------------
LOG_FILE = PROJECT_ROOT / "logs" / "cobranca_vencidos.log"
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s -- %(message)s",
    handlers=[
        logging.handlers.TimedRotatingFileHandler(
            LOG_FILE, when="D", interval=1, backupCount=30, encoding="utf-8",
        ),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("cobranca-vencidos")


def _log_email_error(titulo, motivo: str | None, *, dry_run: bool) -> None:
    """Registra falha de e-mail (ausente/inválido) em cobranca_erros_log."""
    doc_id = titulo.document_id
    error_type = (
        "email_ausente"
        if not titulo.primary_email or not titulo.primary_email.strip()
        else "email_invalido"
    )
    logger.warning("[ERRO] %s -- %s", doc_id, motivo)
    if not dry_run:
        log_envio_erro(
            error_type=error_type,
            error_message=motivo or "E-mail do cliente indisponível.",
            error_detail=f"primary_email={titulo.primary_email!r}",
            document_id=doc_id, customer_name=titulo.customer_name,
            primary_email=titulo.primary_email, cc_email=titulo.cc_email,
            due_date=titulo.due_date, bill_amount=titulo.bill_amount,
            email_subject=titulo.email_subject,
        )


def _cleanup_resolved_errors(document_id) -> None:
    """Remove as linhas de erro antigas de um título resolvido (enviado agora ou que já
    constava enviado). Best-effort: falha aqui não derruba o run — os e-mails já saíram."""
    try:
        delete_erro_rows_by_document_id(document_id)
    except Exception:  # noqa: BLE001 — limpeza best-effort, não interrompe o lote
        logger.warning("Falha ao limpar erros resolvidos do título %s (envio OK, seguindo).", document_id)


def _send_titulo(titulo, *, dev_mode: bool, dev_override: str, company_row, session) -> str:
    """Adapta um TituloVencido para o núcleo de envio compartilhado (send_core)."""
    return send_and_log(
        document_id=titulo.document_id, customer_name=titulo.customer_name,
        primary_email=titulo.primary_email, cc_email=titulo.cc_email,
        due_date=titulo.due_date, bill_amount=titulo.bill_amount,
        email_subject=titulo.email_subject, company_row=company_row,
        dev_mode=dev_mode, dev_override=dev_override, session=session,
    )


def _process_titulo(titulo, *, dry_run: bool, dev_mode: bool, dev_override: str, company_row, session) -> str:
    """Processa um título do começo ao fim. Retorna 'sent' | 'skipped' | 'error'."""
    doc_id = titulo.document_id

    if not dry_run and already_sent(doc_id):
        logger.info("[SKIP] %s -- ja consta em cobranca_envios_log.", doc_id)
        return "skipped"

    email_ok, email_motivo = validate_email(titulo.primary_email)
    if not email_ok:
        _log_email_error(titulo, email_motivo, dry_run=dry_run)
        return "error"

    if dry_run:
        logger.info("[DRY-RUN] Enviaria: doc_id=%s to=%s cc=%s subject=%r",
            doc_id, titulo.primary_email, titulo.cc_email, titulo.email_subject)
        return "sent"

    return _send_titulo(titulo, dev_mode=dev_mode, dev_override=dev_override,
        company_row=company_row, session=session)


def _process_titulo_safe(titulo, *, dry_run: bool, dev_mode: bool, dev_override: str, company_row, session) -> str:
    """Rede de segurança: envolve _process_titulo para que NENHUMA falha de um título
    interrompa os demais. Erros previstos (SMTP/e-mail) já são tratados lá dentro; isto
    captura qualquer exceção inesperada (render, dado ruim), registra como erro_inesperado
    e segue para o próximo título."""
    try:
        return _process_titulo(
            titulo, dry_run=dry_run, dev_mode=dev_mode,
            dev_override=dev_override, company_row=company_row, session=session,
        )
    except Exception:
        doc_id = getattr(titulo, "document_id", None)
        logger.exception("Falha inesperada no título %s — seguindo para o próximo.", doc_id)
        if not dry_run:
            log_envio_erro(
                error_type="erro_inesperado",
                error_message="Ocorreu um erro inesperado ao processar este título.",
                error_detail=traceback.format_exc(),
                document_id=doc_id, customer_name=getattr(titulo, "customer_name", None),
                primary_email=getattr(titulo, "primary_email", None),
                cc_email=getattr(titulo, "cc_email", None),
                due_date=getattr(titulo, "due_date", None),
                bill_amount=getattr(titulo, "bill_amount", None),
                email_subject=getattr(titulo, "email_subject", None),
            )
        return "error"


def main(dry_run: bool = False) -> None:
    logger.info("=" * 60)
    logger.info("Iniciando skill cobranca-vencidos | dry_run=%s", dry_run)
    logger.info("=" * 60)

    dev_mode     = os.environ.get("DEV_MODE", "false").lower() == "true"
    dev_override = os.environ.get("DEV_OVERRIDE_EMAIL", "").strip()

    if dev_mode:
        if not dev_override:
            logger.error("DEV_MODE=true mas DEV_OVERRIDE_EMAIL nao definido. Abortando.")
            sys.exit(1)
        logger.warning("DEV_MODE ativo -- todos os enviosirao para: %s", dev_override)

    company_row = fetch_company_smtp()
    logger.info(
        "Config SMTP: %s",
        f"tabela company ({company_row.get('email')})" if company_row else "fallback .env",
    )

    try:
        titulos = fetch_titulos_vencidos()
    except Exception as exc:
        logger.exception("Falha critica ao consultar Firebird.")
        log_envio_erro(
            error_type="firebird_falha",
            error_message="Não foi possível consultar os títulos vencidos no sistema financeiro.",
            error_detail=f"{exc}\n\n{traceback.format_exc()}",
        )
        sys.exit(1)

    if not titulos:
        logger.info("Nenhum titulo vencido encontrado. Encerrando.")
        return

    # Throttle anti-bloqueio (boa prática Locaweb): pausa de alguns segundos ENTRE envios
    # reais para não saturar a fila de saída (451 "queue file write error" sob rajada).
    # Configurável por COBRANCA_SEND_DELAY_SECONDS (default 10s — alinhado ao reenvio e à
    # produção; 0 desliga). Não pausa em duplicatas puladas nem em dry-run.
    try:
        send_delay = max(0.0, float(os.environ.get("COBRANCA_SEND_DELAY_SECONDS", "10")))
    except ValueError:
        send_delay = 10.0

    # Títulos que JÁ têm erro registrado — usado para limpar o log de erros ao enviá-los
    # com sucesso (e-mail corrigido no Firebird volta ao fluxo e a falha antiga some). Só
    # limpa quem estava neste conjunto, evitando um DELETE por título p/ quem nunca falhou.
    # Best-effort: se a consulta falhar, segue sem limpar (não derruba o run). Vazio em dry-run.
    error_doc_ids: set[str] = set()
    if not dry_run:
        try:
            error_doc_ids = fetch_error_document_ids()
        except Exception:  # noqa: BLE001 — sem isso, só não limpa; o run segue
            logger.warning("Não foi possível listar títulos com erro; limpeza de resolvidos desativada neste run.")

    counts = {"sent": 0, "skipped": 0, "error": 0}
    # Uma única conexão SMTP para todo o lote (lazy: só conecta no 1º envio real).
    # Em dry-run não há envio, então não abre sessão.
    session = None if dry_run else SmtpSession(
        company_row, dev_mode=dev_mode, dev_override=dev_override)
    try:
        for titulo in titulos:
            result = _process_titulo_safe(
                titulo, dry_run=dry_run, dev_mode=dev_mode,
                dev_override=dev_override, company_row=company_row, session=session,
            )
            counts[result] += 1
            # Título resolvido (enviado agora ou já enviado) que antes tinha erro: limpa o log.
            if result in ("sent", "skipped") and titulo.document_id in error_doc_ids:
                _cleanup_resolved_errors(titulo.document_id)
            if send_delay > 0 and not dry_run and result in ("sent", "error"):
                time.sleep(send_delay)
    finally:
        if session is not None:
            session.close()

    logger.info("-" * 60)
    logger.info("Resumo: total=%d | enviados=%d | pulados=%d | erros=%d",
        len(titulos), counts["sent"], counts["skipped"], counts["error"])
    logger.info("=" * 60)
    if counts["error"] > 0: sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cobranca de titulos vencidos")
    parser.add_argument("--dry-run", action="store_true",
        help="Simula sem enviar emails nem gravar no Supabase")
    args = parser.parse_args()
    main(dry_run=args.dry_run)
