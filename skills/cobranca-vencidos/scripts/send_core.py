"""
send_core.py -- Nucleo reutilizavel de validacao, envio e registro de UMA cobranca.

Usado tanto pelo run.py (batch diario do Task Scheduler) quanto pelo resend.py
(reenvio manual a partir da tela /cobranca/erros, via Flask). Centraliza num so
lugar a classificacao de erro SMTP e o par render->send->log, evitando duplicar a
logica entre os dois fluxos. Os modulos irmaos (email_sender, supabase_log,
template) sao importados como top-level — quem importa send_core ja inseriu o
diretorio dos scripts no sys.path (run.py e server/app.py fazem isso).
"""

from __future__ import annotations

import logging
import re
import smtplib
import traceback

from email_sender import send_cobranca
from supabase_log import log_envio_erro, log_envio_sucesso
from template import render_html

logger = logging.getLogger("cobranca-vencidos")

# Valido o suficiente para pegar e-mail ausente/obviamente quebrado — a validacao
# definitiva e o proprio servidor SMTP (que devolve o erro real no envio).
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def validate_email(value: str | None) -> tuple[bool, str | None]:
    """Retorna (ok, motivo). Mensagens em linguagem simples (coluna "Motivo")."""
    if not value or not value.strip():
        return False, "Cliente sem e-mail cadastrado."
    if not EMAIL_RE.match(value.strip()):
        return False, f"E-mail do cliente parece inválido: {value.strip()}"
    return True, None


def classify_smtp_error(exc: Exception) -> tuple[str, str]:
    """Distingue BLOQUEIO/negação (exige ação humana) de INSTABILIDADE temporária (retry).

    Retorna (error_type, mensagem em linguagem simples para a coluna "Motivo").
    Locaweb costuma BLOQUEAR o envio (login recusado, limite de envios, conta bloqueada) —
    nesses casos repetir não resolve; já timeout/queda de rede são temporários.
    """
    code = getattr(exc, "smtp_code", None)

    # Login recusado / conta bloqueada (Locaweb 535).
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        return ("smtp_bloqueio",
            "Envio bloqueado: o servidor de e-mail recusou o login. Verifique o usuário/senha "
            "e se a conta de e-mail não está bloqueada na Locaweb.")

    # Endereço do destinatário recusado pelo servidor de destino. O código SMTP por
    # destinatário decide a natureza: 5xx = recusa DEFINITIVA (endereço inexistente/
    # caixa cheia/bloqueado, exige ação humana); 4xx = limite TEMPORÁRIO de envio
    # (ex.: 452 "sending too many mails, slow down" do Hotmail/Gmail), que se resolve
    # com retry + throttle — NÃO trocar o e-mail do cliente nesse caso.
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        rcpt_codes = [c for (c, _resp) in (exc.recipients or {}).values()
                      if isinstance(c, int)]
        if rcpt_codes and all(400 <= c < 500 for c in rcpt_codes):
            return ("smtp_falha",
                "O servidor de destino recusou o e-mail temporariamente por limite de envios "
                "(muitos e-mails em sequência). O sistema tentará novamente na próxima execução.")
        return ("smtp_bloqueio",
            "O e-mail do cliente foi recusado pelo servidor de destino (endereço inexistente, "
            "caixa cheia ou bloqueado). Confira o e-mail cadastrado do cliente.")

    # 421 (excesso de conexões / limite temporário) ou qualquer 5xx = bloqueio/negação:
    # repetir não resolve — exige verificar o limite de envios ou o bloqueio da conta.
    if code == 421 or (isinstance(code, int) and 500 <= code < 600):
        return ("smtp_bloqueio",
            "Envio bloqueado pelo servidor de e-mail — provável limite de envios excedido ou "
            "conta bloqueada na Locaweb. Repetir não resolve: verifique o limite de envios e o "
            "status da conta de e-mail.")

    # Timeout, queda de rede, 450/451/452 (fila ocupada) = instabilidade temporária.
    return ("smtp_falha",
        "Não foi possível enviar o e-mail agora (instabilidade temporária no servidor de "
        "e-mail). O sistema tentará novamente na próxima execução.")


def send_and_log(*, document_id, customer_name, primary_email, cc_email,
                 due_date, bill_amount, email_subject, company_row,
                 dev_mode: bool = False, dev_override: str = "") -> str:
    """Renderiza, envia e registra UMA cobrança. Retorna 'sent' ou 'error'.

    Sucesso -> grava em cobranca_envios_log; falha -> classifica e grava em
    cobranca_erros_log. Nunca propaga exceção de SMTP (o caller decide o fluxo).
    """
    html = render_html(customer_name=customer_name, document_id=document_id,
        bill_amount=bill_amount, due_date=due_date)
    try:
        send_cobranca(to_email=primary_email, cc_email=cc_email,
            subject=email_subject, html_body=html, company_row=company_row,
            dev_mode=dev_mode, dev_override=dev_override)
        log_envio_sucesso(document_id=document_id, customer_name=customer_name,
            primary_email=primary_email, cc_email=cc_email,
            due_date=due_date, bill_amount=bill_amount, email_subject=email_subject)
        logger.info("[OK] %s -> %s", document_id, primary_email)
        return "sent"
    except Exception as exc:  # noqa: BLE001 — falha de envio vira registro, não crash
        logger.exception("[ERRO SMTP] %s: %s", document_id, exc)
        error_type, motivo = classify_smtp_error(exc)
        log_envio_erro(error_type=error_type, error_message=motivo,
            error_detail=traceback.format_exc(),
            document_id=document_id, customer_name=customer_name,
            primary_email=primary_email, cc_email=cc_email,
            due_date=due_date, bill_amount=bill_amount, email_subject=email_subject)
        return "error"
