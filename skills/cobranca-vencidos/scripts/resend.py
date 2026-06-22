"""
resend.py -- Reenvio manual de cobranças a partir da tela /cobranca/erros.

Recebe ids de linhas de `cobranca_erros_log`, reconstrói o e-mail a partir dos
campos já gravados (NÃO depende do Firebird) e reenvia, reaproveitando o mesmo
núcleo do batch diário (`send_core.send_and_log`) — mesma dedup, throttle e
classificação de erro. Exposto via Flask em POST /api/cobranca/resend/start.

Statuses por título (consumidos pela UI):
  sent     -> enviado agora com sucesso
  skipped  -> já constava em cobranca_envios_log (dedup) — não reenvia
  no_email -> sem e-mail / e-mail inválido (registrado em cobranca_erros_log)
  error    -> falha de SMTP (registrada em cobranca_erros_log)

Ao final, as linhas RESOLVIDAS (status 'sent' ou 'skipped') são REMOVIDAS de
`cobranca_erros_log` (`delete_erro_rows`) — o log de erros passa a conter só falhas
pendentes. Linhas que falharam de novo ('error'/'no_email') permanecem (com um registro
de erro atualizado).
"""

from __future__ import annotations

import logging
import os
import time
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Callable

from email_sender import SmtpSession
from send_core import send_and_log, validate_email
from supabase_log import (
    already_sent,
    delete_erro_rows,
    fetch_company_smtp,
    fetch_erro_rows,
    log_envio_erro,
)

logger = logging.getLogger("cobranca-vencidos")

# Teto de ids por requisição — evita um lote absurdo num clique acidental.
MAX_IDS = 500
# Throttle anti-bloqueio Locaweb (mesma variável do batch; default 10s — ver
# memória cobranca-smtp-bottleneck: 451 "queue file write error" sob rajada).
DEFAULT_DELAY = 10.0


def _delay_seconds() -> float:
    try:
        return max(0.0, float(os.environ.get("COBRANCA_SEND_DELAY_SECONDS", str(DEFAULT_DELAY))))
    except ValueError:
        return DEFAULT_DELAY


def _dev_config() -> tuple[bool, str]:
    dev_mode = os.environ.get("DEV_MODE", "false").lower() == "true"
    dev_override = os.environ.get("DEV_OVERRIDE_EMAIL", "").strip()
    return dev_mode, dev_override


def resend_ready() -> tuple[bool, str | None]:
    """Prontidão do ambiente para reenviar (usado pelo /health p/ habilitar o botão).

    Sem essas credenciais/serviços configurados, o envio não funciona — então a UI
    mantém o botão de reenvio desabilitado em vez de falhar no clique.
    """
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_KEY"):
        return False, "Supabase não configurado no servidor (SUPABASE_URL/SERVICE_KEY)."
    # SMTP reutiliza as credenciais IMAP quando as SMTP_* não estão setadas (ver email_sender).
    has_host = os.environ.get("SMTP_HOST") or os.environ.get("IMAP_HOST")
    has_pass = os.environ.get("SMTP_PASSWORD") or os.environ.get("IMAP_PASS")
    if not has_host or not has_pass:
        return False, "Envio de e-mail não configurado no servidor (SMTP/IMAP host e senha)."
    dev_mode, dev_override = _dev_config()
    if dev_mode and not dev_override:
        return False, "DEV_MODE ativo sem DEV_OVERRIDE_EMAIL definido."
    return True, None


def _parse_due(v):
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except (ValueError, TypeError):
        return v  # render_html já lida com string


def _parse_amount(v) -> Decimal:
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


def _email_error_type(primary_email: str | None) -> str:
    return "email_ausente" if not primary_email or not primary_email.strip() else "email_invalido"


def _resend_one(row: dict, _id: int, *, session, company_row, dev_mode: bool,
                dev_override: str, counts: dict, results: list[dict],
                emit: Callable[[str], None]) -> str:
    """Reenvia UMA linha de erro: valida, deduplica e despacha pelo núcleo compartilhado.
    Atualiza counts/results/emit e retorna o status ('no_email'|'skipped'|'sent'|'error')
    para o caller decidir o throttle (só pausa após envio real)."""
    doc_id = row.get("document_id")
    customer = row.get("customer_name")
    email = row.get("primary_email")
    cc = row.get("cc_email")
    due = _parse_due(row.get("due_date"))
    amount = _parse_amount(row.get("bill_amount"))
    subject = row.get("email_subject") or "COBRANÇA"

    email_ok, motivo = validate_email(email)
    if not email_ok:
        log_envio_erro(error_type=_email_error_type(email),
            error_message=motivo or "E-mail do cliente indisponível.",
            error_detail=f"primary_email={email!r}",
            document_id=doc_id, customer_name=customer, primary_email=email,
            cc_email=cc, due_date=due, bill_amount=amount, email_subject=subject)
        counts["no_email"] += 1
        results.append({"id": _id, "document_id": doc_id, "status": "no_email", "message": motivo})
        emit("enviando")
        return "no_email"

    if already_sent(doc_id):
        counts["skipped"] += 1
        results.append({"id": _id, "document_id": doc_id, "status": "skipped",
                        "message": "Já enviado anteriormente."})
        emit("enviando")
        return "skipped"

    status = send_and_log(document_id=doc_id, customer_name=customer,
        primary_email=email, cc_email=cc, due_date=due, bill_amount=amount,
        email_subject=subject, company_row=company_row,
        dev_mode=dev_mode, dev_override=dev_override, session=session)
    counts["sent" if status == "sent" else "error"] += 1
    results.append({"id": _id, "document_id": doc_id, "status": status,
                    "message": "Enviado." if status == "sent" else "Falha no envio."})
    emit("enviando")
    return status


def resend_erros(ids: list[int], on_progress: Callable[[dict], None] | None = None) -> dict:
    """Reenvia as cobranças das linhas de erro informadas. Retorna o resumo + por-linha."""
    ids = [int(i) for i in (ids or [])][:MAX_IDS]
    counts = {"sent": 0, "skipped": 0, "no_email": 0, "error": 0}
    results: list[dict] = []

    def _emit(phase: str) -> None:
        if on_progress:
            on_progress({"phase": phase, "total": len(ids), "done": len(results), **counts})

    if not ids:
        _emit("concluído")
        return {"total": 0, **counts, "results": results}

    _emit("iniciando")
    rows = fetch_erro_rows(ids)
    # Mantém a ordem/seleção do usuário; ignora ids inexistentes silenciosamente.
    by_id = {int(r["id"]): r for r in rows}

    company_row = fetch_company_smtp()
    dev_mode, dev_override = _dev_config()
    delay = _delay_seconds()

    # Ids resolvidos a remover do log de erros: reenviado AGORA com sucesso ('sent') ou
    # que já constava como enviado ('skipped'). Ambos deixam de ser falha pendente.
    resolved_ids: list[int] = []
    # Uma única conexão SMTP para todo o lote de reenvio (lazy: conecta no 1º envio real).
    session = SmtpSession(company_row, dev_mode=dev_mode, dev_override=dev_override)
    try:
        for idx, _id in enumerate(ids):
            row = by_id.get(_id)
            if row is None:
                continue
            status = _resend_one(row, _id, session=session, company_row=company_row,
                dev_mode=dev_mode, dev_override=dev_override,
                counts=counts, results=results, emit=_emit)
            if status in ("sent", "skipped"):
                resolved_ids.append(_id)
            # Throttle só entre envios reais (sent/error), nunca após skip/no_email — e
            # não após o último item.
            if status in ("sent", "error") and delay > 0 and idx < len(ids) - 1:
                time.sleep(delay)
    finally:
        session.close()

    # Remove do log de erros tudo que foi resolvido. Falha aqui não invalida o reenvio
    # (os e-mails já saíram) — apenas registra aviso; a dedup evita reenvio futuro.
    if resolved_ids:
        try:
            delete_erro_rows(resolved_ids)
        except Exception as e:  # noqa: BLE001 — limpeza best-effort, não derruba o reenvio
            logger.warning("Falha ao remover %d linha(s) resolvida(s) de cobranca_erros_log: %s",
                len(resolved_ids), e)

    _emit("concluído")
    logger.info("Reenvio: total=%d sent=%d skipped=%d no_email=%d error=%d",
        len(ids), counts["sent"], counts["skipped"], counts["no_email"], counts["error"])
    return {"total": len(ids), **counts, "results": results}
