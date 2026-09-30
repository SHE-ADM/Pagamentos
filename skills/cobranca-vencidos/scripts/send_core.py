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
from typing import NamedTuple

from email_sender import SmtpSession, send_cobranca
from supabase_log import log_envio_erro, log_envio_sucesso
from template import render_html

logger = logging.getLogger("cobranca-vencidos")


class SendResult(NamedTuple):
    """Resultado de send_and_log. `status` = 'sent' | 'error'. Em falha, `error_type`
    (mesmo domínio de classify_smtp_error / validação) e `motivo` (mensagem leiga)
    permitem ao caller decidir notificações sem reclassificar."""
    status: str
    error_type: str | None = None
    motivo: str | None = None

# Valido o suficiente para pegar e-mail ausente/obviamente quebrado — a validacao
# definitiva e o proprio servidor SMTP (que devolve o erro real no envio).
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ---------------------------------------------------------------------------
# Domínio com erro de digitação
# ---------------------------------------------------------------------------
# O relay (Locaweb) ACEITA qualquer destinatário sintaticamente válido e a devolução
# chega depois, na caixa do financeiro — o run registra "enviado" e a cobrança nunca
# chega (caso real 251796-A, "@gemail.com", 2026-09-29). Por isso o erro de digitação
# nos provedores gratuitos é barrado ANTES do envio e vira email_invalido, que já é
# registrado e notificado ao vendedor como o "sem e-mail".
#
# Rótulo do provedor -> sufixos em que ele recebe e-mail. Só provedores gratuitos: um
# domínio corporativo não tem "grafia certa" conhecida, e compará-lo geraria falso positivo.
_FREEMAIL_SUFFIXES: dict[str, tuple[str, ...]] = {
    "gmail":   ("com",),
    "icloud":  ("com",),
    "hotmail": ("com", "com.br"),
    "outlook": ("com", "com.br"),
    "yahoo":   ("com", "com.br"),
}
# Sufixos genéricos: só se compara o rótulo quando o domínio é "<rótulo>.<genérico>" —
# "hotmal.empresa.com.br" é subdomínio corporativo, não erro de digitação.
_GENERIC_SUFFIXES = ("com", "com.br")
# Provedores reais a 1 edição de um da lista (ymail/mail/email x gmail) — nunca são erro.
_LEGIT_NEAR_LABELS = frozenset({"ymail", "mail", "email"})
# "com.<país>" de 2 letras (com.ar, com.pt, com.mx): sufixo real de outro país.
_COUNTRY_SUFFIX_RE = re.compile(r"^com\.[a-z]{2}$")
# Distância máxima tolerada. 1 cobre inserção/remoção/troca/transposição de UMA letra
# (gemail, gmial, hotmial, gmail.con); 2 já alcança domínios legítimos diferentes.
_MAX_TYPO_DISTANCE = 1


def _edit_distance(a: str, b: str) -> int:
    """Distância de Damerau-Levenshtein (variante OSA): transposição de letras vizinhas
    conta como UMA edição — "hotmial" está a 1 de "hotmail", não a 2."""
    prev2: list[int] = []
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        prev2, prev = prev, cur
    return prev[len(b)]


def _near(value: str, targets: tuple[str, ...]) -> bool:
    return any(_edit_distance(value, t) <= _MAX_TYPO_DISTANCE for t in targets)


def _closest(value: str, targets: tuple[str, ...]) -> str:
    return min(targets, key=lambda t: (_edit_distance(value, t), t))


def suggest_domain_fix(domain: str) -> str | None:
    """Devolve o domínio provavelmente pretendido quando `domain` é erro de digitação de
    um provedor gratuito (gemail.com -> gmail.com); None quando não há indício de erro.

    Conservador de propósito: falso positivo deixa um cliente real SEM cobrança.
    """
    domain = (domain or "").strip().lower().strip(".")
    label, _, suffix = domain.partition(".")
    if not label or not suffix:
        return None

    if label in _FREEMAIL_SUFFIXES:
        valid = _FREEMAIL_SUFFIXES[label]
        if suffix in valid:
            return None
        # Só sufixo genérico mal digitado (gmail.con, yahoo.com.b) ou o genérico que o
        # provedor não usa (gmail.com.br). hotmail.fr / hotmail.co.uk / yahoo.com.ar são
        # domínios de país legítimos — "com.ar" está a 1 edição de "com.br", mas não é erro.
        if suffix in _GENERIC_SUFFIXES:
            return f"{label}.{_closest(suffix, valid)}"
        if _COUNTRY_SUFFIX_RE.match(suffix):
            return None
        if _near(suffix, _GENERIC_SUFFIXES):
            return f"{label}.{_closest(suffix, valid)}"
        return None

    if label in _LEGIT_NEAR_LABELS:
        return None
    if suffix not in _GENERIC_SUFFIXES and (
            _COUNTRY_SUFFIX_RE.match(suffix) or not _near(suffix, _GENERIC_SUFFIXES)):
        return None
    candidates = sorted(p for p in _FREEMAIL_SUFFIXES if _near(label, (p,)))
    if not candidates:
        return None
    provider = candidates[0]
    return f"{provider}.{_closest(suffix, _FREEMAIL_SUFFIXES[provider])}"


def validate_email(value: str | None) -> tuple[bool, str | None]:
    """Retorna (ok, motivo). Mensagens em linguagem simples (coluna "Motivo")."""
    if not value or not value.strip():
        return False, "Cliente sem e-mail cadastrado."
    email = value.strip()
    if not EMAIL_RE.match(email):
        return False, f"E-mail do cliente parece inválido: {email}"
    fix = suggest_domain_fix(email.rsplit("@", 1)[1])
    if fix:
        return False, (f"E-mail do cliente com provável erro de digitação no domínio: "
                       f"{email} (o correto seria @{fix}?)")
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
                 dev_mode: bool = False, dev_override: str = "",
                 session: SmtpSession | None = None) -> SendResult:
    """Renderiza, envia e registra UMA cobrança. Retorna SendResult (status 'sent'/'error';
    em falha, com error_type + motivo).

    Sucesso -> grava em cobranca_envios_log; falha -> classifica e grava em
    cobranca_erros_log. Nunca propaga exceção de SMTP (o caller decide o fluxo).

    `session`: quando o caller (batch/reenvio) já abriu uma SmtpSession para o lote,
    o envio reaproveita essa conexão. Sem sessão, abre uma conexão avulsa por envio
    (compatibilidade — `send_cobranca`).
    """
    html = render_html(customer_name=customer_name, document_id=document_id,
        bill_amount=bill_amount, due_date=due_date)
    try:
        if session is not None:
            session.send(to_email=primary_email, cc_email=cc_email,
                subject=email_subject, html_body=html)
        else:
            send_cobranca(to_email=primary_email, cc_email=cc_email,
                subject=email_subject, html_body=html, company_row=company_row,
                dev_mode=dev_mode, dev_override=dev_override)
        log_envio_sucesso(document_id=document_id, customer_name=customer_name,
            primary_email=primary_email, cc_email=cc_email,
            due_date=due_date, bill_amount=bill_amount, email_subject=email_subject)
        logger.info("[OK] %s -> %s", document_id, primary_email)
        return SendResult("sent")
    except Exception as exc:  # noqa: BLE001 — falha de envio vira registro, não crash
        logger.exception("[ERRO SMTP] %s: %s", document_id, exc)
        error_type, motivo = classify_smtp_error(exc)
        log_envio_erro(error_type=error_type, error_message=motivo,
            error_detail=traceback.format_exc(),
            document_id=document_id, customer_name=customer_name,
            primary_email=primary_email, cc_email=cc_email,
            due_date=due_date, bill_amount=bill_amount, email_subject=email_subject)
        return SendResult("error", error_type, motivo)
