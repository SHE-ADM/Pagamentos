"""
email_sender.py
Composição e envio de email de cobrança via SMTP Locaweb.
Remetente: campo `email` da tabela `company` no Supabase (ex.: financeiro@otimotex.com.br).
Senha do mailbox: variável `SMTP_PASSWORD` no .env (segredo nunca vai para o banco).
Host/porta/nome: default Locaweb (smtp.locaweb.com.br:587), com override opcional por .env
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM_NAME`, `SMTP_USER`).

Conexão reaproveitada (SmtpSession): abrir conexão + STARTTLS + LOGIN a cada e-mail
multiplica o handshake por título e aumenta a pressão sobre o relay da Locaweb (limite
de conexões / fila de saída -> 451 "queue file write error"). O batch (run.py) e o
reenvio (resend.py) abrem UMA SmtpSession por lote e reusam a conexão entre os envios.
"""

from __future__ import annotations

import logging
import os
import smtplib
import ssl
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

logger = logging.getLogger(__name__)

_SIGNATURE_PATH = Path(__file__).parent.parent / "assets" / "signature.png"
# Bytes da assinatura lidos UMA vez (não reler o disco a cada e-mail do lote).
_SIGNATURE_BYTES: bytes | None = (
    _SIGNATURE_PATH.read_bytes() if _SIGNATURE_PATH.exists() else None
)

# Timeout de socket (s) de cada operação SMTP — sem ele, um envio que estanca
# congelaria o lote inteiro (mesma classe de proteção do IMAP/Claude API).
_SMTP_TIMEOUT_SECONDS = 30


def _load_smtp_config(company_row: dict | None) -> dict:
    # Remetente: campo `email` da tabela company (financeiro@otimotex.com.br) — o MESMO
    # mailbox usado para recebimento (IMAP). Por isso a senha SMTP reusa `IMAP_PASS` do
    # .env quando `SMTP_PASSWORD` não está definido — sem duplicar segredo. Host/porta/
    # nome têm default Locaweb e aceitam override por .env; `SMTP_USER` só é necessário
    # se o login do mailbox diferir do endereço remetente.
    row = company_row or {}
    sender = row.get("email") or os.environ.get("SMTP_USER") or os.environ.get("IMAP_USER", "")
    from_name = (
        os.environ.get("SMTP_FROM_NAME")
        or row.get("trade_name")
        or row.get("legal_name")
        or "Departamento Financeiro"
    )
    return {
        # Mesmo servidor de e-mail do recebimento (IMAP_HOST = email-ssl.com.br na
        # Locaweb). `smtp.locaweb.com.br` não atende esta conta (timeout). Override
        # explícito via SMTP_HOST tem prioridade.
        "host": os.environ.get("SMTP_HOST") or os.environ.get("IMAP_HOST") or "email-ssl.com.br",
        "port": int(os.environ.get("SMTP_PORT", "587")),
        "user": os.environ.get("SMTP_USER") or sender,
        "password": os.environ.get("SMTP_PASSWORD") or os.environ.get("IMAP_PASS", ""),
        "from_name": from_name,
        "from_addr": sender,
    }


def _resolve_recipients(
    to_email: str, cc_email: str | None, *, dev_mode: bool, dev_override: str
) -> tuple[str, str | None]:
    """Em DEV_MODE redireciona To/Cc para as caixas de teste; em produção, os reais."""
    if dev_mode:
        # Em teste: To vai para DEV_OVERRIDE_EMAIL; a CÓPIA (Cc) vai para
        # DEV_OVERRIDE_CC_EMAIL (se definido), permitindo validar o Cc numa caixa
        # separada. Só adiciona Cc quando o título original tem cópia.
        actual_to = dev_override
        actual_cc = (os.environ.get("DEV_OVERRIDE_CC_EMAIL", "").strip() or dev_override) if cc_email else None
        logger.info("[DEV] orig To=%s Cc=%s -> teste To=%s Cc=%s", to_email, cc_email, actual_to, actual_cc)
        return actual_to, actual_cc
    return to_email, cc_email


def _build_message(
    smtp: dict, *, subject: str, html_body: str, actual_to: str, actual_cc: str | None
) -> MIMEMultipart:
    msg = MIMEMultipart("related")
    msg["Subject"] = subject
    msg["From"] = f"{smtp['from_name']} <{smtp['from_addr']}>"
    msg["To"] = actual_to
    if actual_cc:
        msg["Cc"] = actual_cc
    msg.attach(MIMEText(html_body, "html", "utf-8"))
    if _SIGNATURE_BYTES is not None:
        img = MIMEImage(_SIGNATURE_BYTES)
        img.add_header("Content-ID", "<signature>")
        img.add_header("Content-Disposition", "inline", filename="signature.png")
        msg.attach(img)
    return msg


def _deliver(conn: smtplib.SMTP, from_addr: str, actual_to: str, actual_cc: str | None, raw: str) -> None:
    # 1) Envia o PRINCIPAL (To). Se falhar, a exceção propaga e o envio aborta AQUI —
    #    a cópia (Cc) NÃO é enviada quando o e-mail principal falha.
    conn.sendmail(from_addr, [actual_to], raw)
    # 2) Principal aceito -> envia a CÓPIA (Cc), se houver. Falha SÓ no Cc (inclusive
    #    queda de conexão) não invalida o principal nem dispara reconexão/reenvio do To
    #    (evita reenviar o principal em duplicidade): apenas registra aviso.
    if actual_cc:
        try:
            conn.sendmail(from_addr, [actual_cc], raw)
        except (smtplib.SMTPException, OSError) as cc_exc:
            logger.warning("Cópia (Cc) não entregue para %s (principal OK): %s", actual_cc, cc_exc)


class SmtpSession:
    """Conexão SMTP persistente reaproveitada entre vários envios do mesmo lote.

    Conecta de forma preguiçosa (no 1º envio) e reusa a conexão; se ela cair no meio
    do lote, reconecta e tenta o envio do principal UMA vez. Recusas definitivas
    (SMTPDataError 451/5xx, SMTPRecipientsRefused, SMTPAuthenticationError) NÃO são
    capturadas aqui — propagam para `classify_smtp_error` decidir retry vs. bloqueio.

    Uso:
        with SmtpSession(company_row, dev_mode=..., dev_override=...) as session:
            session.send(to_email=..., cc_email=..., subject=..., html_body=...)
    """

    def __init__(self, company_row: dict | None, *, dev_mode: bool = False, dev_override: str = "") -> None:
        self._smtp = _load_smtp_config(company_row)
        self.dev_mode = dev_mode
        self.dev_override = dev_override
        self._conn: smtplib.SMTP | None = None

    def __enter__(self) -> SmtpSession:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _connect(self) -> smtplib.SMTP:
        ctx = ssl.create_default_context()
        conn = smtplib.SMTP(self._smtp["host"], self._smtp["port"], timeout=_SMTP_TIMEOUT_SECONDS)
        conn.ehlo()
        conn.starttls(context=ctx)
        conn.login(self._smtp["user"], self._smtp["password"])
        self._conn = conn
        logger.info("Conexão SMTP aberta: %s", self._smtp["host"])
        return conn

    def _ensure(self) -> smtplib.SMTP:
        return self._conn if self._conn is not None else self._connect()

    def close(self) -> None:
        if self._conn is None:
            return
        try:
            self._conn.quit()
        except (smtplib.SMTPException, OSError):
            try:
                self._conn.close()
            except OSError:
                pass
        self._conn = None

    def send(self, *, to_email: str, cc_email: str | None, subject: str, html_body: str) -> None:
        actual_to, actual_cc = _resolve_recipients(
            to_email, cc_email, dev_mode=self.dev_mode, dev_override=self.dev_override
        )
        raw = _build_message(
            self._smtp, subject=subject, html_body=html_body,
            actual_to=actual_to, actual_cc=actual_cc,
        ).as_string()
        logger.info("Enviando email: to=%s via %s", to_email, self._smtp["host"])
        try:
            _deliver(self._ensure(), self._smtp["from_addr"], actual_to, actual_cc, raw)
        except (smtplib.SMTPServerDisconnected, ConnectionError, TimeoutError) as exc:
            # Conexão persistente ficou obsoleta/caiu entre usos — reconecta e tenta UMA
            # vez. ATENÇÃO: smtplib.SMTPException herda de OSError, então NÃO usar OSError
            # aqui — capturar só estas (queda real de conexão). As recusas com resposta do
            # servidor (SMTPDataError 451/5xx, SMTPRecipientsRefused, SMTPAuthenticationError)
            # propagam para `classify_smtp_error` decidir retry vs. bloqueio.
            logger.warning("Conexão SMTP caiu; reconectando e reenviando: %s", exc)
            self.close()
            _deliver(self._connect(), self._smtp["from_addr"], actual_to, actual_cc, raw)
        logger.info("Email enviado com sucesso -> %s", actual_to)


def send_cobranca(
    *, to_email: str, cc_email: str | None, subject: str, html_body: str,
    company_row: dict | None, dev_mode: bool = False, dev_override: str = "",
) -> None:
    """Envio avulso (abre e fecha uma conexão por chamada). Mantido para compatibilidade —
    o batch (run.py) e o reenvio (resend.py) usam SmtpSession para reaproveitar a conexão
    ao longo do lote, reduzindo a pressão sobre o relay."""
    with SmtpSession(company_row, dev_mode=dev_mode, dev_override=dev_override) as session:
        session.send(to_email=to_email, cc_email=cc_email, subject=subject, html_body=html_body)
