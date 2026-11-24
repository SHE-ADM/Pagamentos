"""
reader_alert.py -- Alerta ATIVO do leitor de e-mails: avisa quando há e-mail financeiro PARADO.

POR QUE EXISTE
    De 18 a 21/11/2026 um anexo fez a fila do leitor parar. O run saía com exit 3 e gravava
    Event Log a cada 5 minutos, por dois dias, e ninguém viu: esses sinais dependem de alguém
    abrir o Agendador. Este módulo manda um e-mail para quem pode agir.

QUANDO AVISA (as três condições, todas)
    1. o run terminou com e-mail financeiro ADIADO (ficou sem registro e volta no próximo run);
    2. algum dos adiados DESTE run está parado há ALERT_MIN_AGE_MINUTES ou mais, medido pelo
       `logged_at` da linha `erro_api` — ela nasce no 1º adiamento e some quando o e-mail conclui;
    3. nenhum alerta saiu nas últimas ALERT_COOLDOWN_HOURS (carimbo `alerted_at` nas linhas).

INTERRUPTOR
    `READER_ALERT_TO` no .env (endereços separados por vírgula). SEM ela o alerta fica DESLIGADO:
    é o que impede o ambiente de desenvolvimento de mandar aviso a alguém.

TESTAR O CANAL (depois de um deploy)
    py -3 skills\\email-reader\\scripts\\reader_alert.py --test
    Envia UM e-mail de teste aos destinatários. Exit 0 = aceito por ao menos um; 1 = não enviado.

O QUE ESTE MÓDULO NÃO FAZ
    Não fala com o Supabase (recebe o mapa de pendências e uma função de carimbo) e não importa
    `read_emails` (evitaria import circular). O envio reusa `SmtpSession` da cobrança, carregado
    POR CAMINHO: as regras de TLS 1.2, CRLF e From no domínio de Return Path têm uma cópia só.

Uso (é o que `read_emails._alert_stuck_emails` faz ao fim de cada run):

    outcome = notify_stuck(
        deferred={"<id@x>": {"subject": "...", "sender_email": "...", "received_at": "..."}},
        pending=ctrl.pending_api_errors(),       # {message_id: {logged_at, alerted_at, ...}}
        stamp=ctrl.stamp_alerted,                # (message_id, when_iso) -> bool
        subject_marker="[ALERTA-LEITOR]",
        reason="Error code: 529",
    )
"""

from __future__ import annotations

import html
import importlib.util
import inspect
import logging
import os
import re
import smtplib
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Filho do logger do leitor: herda o arquivo de log e o formato configurados em read_emails.
log = logging.getLogger("email-reader.alert")

# ---------------------------------------------------------------------------
# Parâmetros
# ---------------------------------------------------------------------------
# Variável de ambiente com os destinatários. Ausente ou vazia = alerta desligado.
ENV_RECIPIENTS = "READER_ALERT_TO"
# Tempo mínimo parado antes de avisar. A quarentena do leitor resolve o e-mail "venenoso" em
# ~30 min (6 runs); 60 min é o ponto em que os mecanismos automáticos já tiveram a sua chance.
ALERT_MIN_AGE_MINUTES = 60
# Carência entre dois alertas. Uma parada longa gera ~4 avisos por dia, não 288 (um por run).
ALERT_COOLDOWN_HOURS = 6
# Teto de e-mails LISTADOS no corpo (o total real vai sempre no texto e no assunto).
ALERT_MAX_LISTED = 20
# Teto de tempo para carimbar as linhas depois do envio: cada carimbo são 2 chamadas HTTP, e
# numa parada de dias são centenas de linhas — o run seguinte não pode ficar esperando.
ALERT_STAMP_BUDGET_SECONDS = 45
# Folga para relógio fora de sincronia (o `logged_at` vem do relógio do BANCO). Data além
# disto no FUTURO é dado corrompido, não "acabou de acontecer".
CLOCK_SKEW_TOLERANCE = timedelta(minutes=5)

# Chaves que este módulo lê em cada entrada do mapa de pendências. `read_emails` é quem as
# grava (ALERTED_AT_KEY e o `logged_at` da consulta); há guarda de teste travando a igualdade.
PENDING_LOGGED_AT_KEY = "logged_at"
PENDING_ALERTED_AT_KEY = "alerted_at"

# Nome exibido no From quando o .env não define SMTP_FROM_NAME. 🔴 Só ASCII, de propósito: o
# `email_sender` monta `Nome <endereço>` num texto só, e com acento a biblioteca codificaria o
# cabeçalho INTEIRO (RFC 2047) — endereço incluído —, o que relays recusam ou reescrevem.
ALERT_FROM_NAME = "Leitor de e-mails - Contas a Pagar"

# `email_sender.py` da cobrança, carregado por caminho (sem pôr a pasta dela no sys.path:
# lá existem módulos de nome genérico — `run`, `template` — que sombreariam outros).
EMAIL_SENDER_PATH = (Path(__file__).resolve().parents[2]
                     / "cobranca-vencidos" / "scripts" / "email_sender.py")

# Desfechos de `notify_stuck` (vão para o resumo e o log do run).
OUTCOME_DISABLED = "desligado"
OUTCOME_NOT_DUE = "nao_devido"
OUTCOME_COOLDOWN = "em_carencia"
OUTCOME_SENT = "enviado"
OUTCOME_SEND_FAILED = "falha_envio"

_SUBJECT_MAX_CHARS = 110
_SENDER_MAX_CHARS = 70
_REASON_MAX_CHARS = 300
_ABSENT = "—"
# Linha de pendência mais nova que isto nasceu NESTE run (os runs são de 5 em 5 minutos).
_JUST_DEFERRED = timedelta(minutes=1)


# ---------------------------------------------------------------------------
# Datas
# ---------------------------------------------------------------------------
def parse_instant(value) -> datetime | None:
    """Instante ISO-8601 → `datetime` COM fuso (UTC quando vier sem). None se ausente/ilegível.

    O PostgREST devolve a fração com 1 a 6 dígitos (`.5`, `.123456`), o fuso como `Z`,
    `+00:00` ou `+00`, e o separador como `T` ou espaço. `datetime.fromisoformat` aceita todas
    essas formas a partir do Python 3.11 (produção roda 3.14) — por isso não há normalização
    aqui: seria código sem efeito. `tests/test_reader_alert.py` trava os formatos; num Python
    mais antigo eles falhariam ALTO no teste, e em execução a data ilegível conta como
    "parado" (o alerta sai cedo, não se cala).
    """
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value or "").strip())
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _fmt_local(value) -> str:
    """`dd/mm/aaaa hh:mm` no fuso da máquina, ou travessão."""
    parsed = parse_instant(value)
    return parsed.astimezone().strftime("%d/%m/%Y %H:%M") if parsed else _ABSENT


def _fmt_age(age: timedelta | None) -> str:
    """Duração legível: `45 min`, `2 h 15 min`, `3 d 4 h`."""
    if age is None:
        return "data não registrada"
    minutes = max(0, int(age.total_seconds() // 60))
    if minutes < 60:
        return f"{minutes} min"
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return f"{hours} h {minutes} min"
    days, hours = divmod(hours, 24)
    return f"{days} d {hours} h"


# ---------------------------------------------------------------------------
# Decisão: quem está parado, e se já avisamos
# ---------------------------------------------------------------------------
def _is_plain_address(address: str) -> bool:
    """Um endereço simples: `local@dominio.tld`, sem espaço, sem `<>` e sem caractere de controle.

    Quebra de linha é espaço para `str.isspace`, então um valor com CR/LF — injeção de cabeçalho
    ou de destinatário — nunca passa. Sem regex de propósito: a validação é por partes.
    """
    if any(ch.isspace() or not ch.isprintable() or ch in "<>" for ch in address):
        return False
    local, at, domain = address.partition("@")
    labels = domain.split(".")
    return bool(local) and bool(at) and "@" not in domain and len(labels) >= 2 and all(labels)


def parse_recipients(raw: str | None) -> list[str]:
    """Destinatários de `READER_ALERT_TO`: separados por vírgula (ou ponto e vírgula).

    Endereço malformado — inclusive com quebra de linha, que seria injeção de cabeçalho — é
    DESCARTADO com aviso; os demais seguem. Repetido (sem diferenciar maiúsculas) conta uma vez.
    """
    seen: set[str] = set()
    recipients: list[str] = []
    for piece in re.split(r"[,;]", raw or ""):
        address = piece.strip()
        if not address:
            continue
        if not _is_plain_address(address):
            log.warning("[ALERTA] destinatário inválido em %s descartado: %r",
                        ENV_RECIPIENTS, address[:80])
            continue
        if address.lower() not in seen:
            seen.add(address.lower())
            recipients.append(address)
    return recipients


def _stuck_since(entry, now: datetime) -> timedelta | None:
    """Há quanto tempo a linha existe. None quando a data não se lê (ou está no futuro)."""
    logged = parse_instant(entry.get(PENDING_LOGGED_AT_KEY))
    if logged is None or logged > now + CLOCK_SKEW_TOLERANCE:
        return None
    return max(now - logged, timedelta(0))


def select_stuck(deferred: dict, pending: dict, now: datetime) -> list[str]:
    """Dos e-mails adiados NESTE run, os parados há `ALERT_MIN_AGE_MINUTES` ou mais.

    - Sem entrada em `pending`: adiado pela 1ª vez agora — não está parado, acabou de falhar.
    - Entrada com `logged_at` ILEGÍVEL (ou no futuro): conta como PARADO. É o lado seguro de um
      alerta — o erro possível é um aviso a mais (limitado pela carência), nunca um e-mail que
      fica dias sem leitura porque uma data veio estranha.
    """
    threshold = timedelta(minutes=ALERT_MIN_AGE_MINUTES)
    stuck: list[str] = []
    for message_id in deferred:
        entry = pending.get(message_id)
        if not isinstance(entry, dict):
            continue
        age = _stuck_since(entry, now)
        if age is None or age >= threshold:
            stuck.append(message_id)
    return stuck


def last_alert_at(pending: dict, now: datetime) -> datetime | None:
    """Instante do alerta mais recente entre TODAS as pendências, ou None.

    🔴 Carimbo no FUTURO é descartado. Sem isso, um `alerted_at` corrompido (ano 2126) manteria
    `agora − carimbo` negativo, portanto "dentro da carência", para sempre: o alerta se calaria
    sozinho, sem erro — exatamente o defeito que ele existe para combater.
    """
    stamps = []
    for entry in pending.values():
        if not isinstance(entry, dict):
            continue
        stamp = parse_instant(entry.get(PENDING_ALERTED_AT_KEY))
        if stamp is not None and stamp <= now + CLOCK_SKEW_TOLERANCE:
            stamps.append(stamp)
    return max(stamps, default=None)


# ---------------------------------------------------------------------------
# Conteúdo
# ---------------------------------------------------------------------------
def build_subject(marker: str, total: int) -> str:
    """Assunto do alerta. 🔴 Sem keyword financeira e sem dado de terceiros: o texto é fixo."""
    plural = "" if total == 1 else "s"
    return f"{marker} {total} e-mail{plural} financeiro{plural} aguardando leitura"


def _clip(value, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _td(value: str) -> str:
    return ("<td style='padding:6px 10px;border:1px solid #ccc;text-align:left;'>"
            f"{html.escape(value)}</td>")


def _th(value: str) -> str:
    return ("<th style='padding:6px 10px;border:1px solid #ccc;text-align:left;'>"
            f"{html.escape(value)}</th>")


def _alert_row(message_id: str, deferred: dict, pending: dict,
               now: datetime) -> tuple[str, timedelta | None]:
    """Linha da tabela de UM e-mail citado e há quanto tempo ele está parado (None = não se sabe
    ou acabou de ser adiado). Todo campo passa por `_td`, que escapa o HTML."""
    info = deferred.get(message_id)
    info = info if isinstance(info, dict) else {}
    entry = pending.get(message_id)
    age = _stuck_since(entry, now) if isinstance(entry, dict) else None
    # Sem linha anterior, ou com a linha criada neste mesmo run (`_mark_deferred` a carimba com
    # a hora de agora): o e-mail não está "parado há 0 min", ele acabou de ser adiado.
    just_deferred = not isinstance(entry, dict) or (age is not None and age < _JUST_DEFERRED)
    age_text = "adiado agora (1ª vez)" if just_deferred else _fmt_age(age)
    row = ("<tr>"
           + _td(_fmt_local(info.get("received_at")))
           + _td(_clip(info.get("sender_email"), _SENDER_MAX_CHARS) or _ABSENT)
           + _td(_clip(info.get("subject"), _SUBJECT_MAX_CHARS) or _ABSENT)
           + _td(age_text)
           + "</tr>")
    return row, age


def render_alert(cited: list[str], deferred: dict, pending: dict, now: datetime,
                 reason: str | None) -> str:
    """HTML do alerta. TODO dado que vem de fora (assunto, remetente, motivo da API) passa por
    `html.escape` — o assunto de um e-mail é texto que o remetente controla."""
    built = [_alert_row(message_id, deferred, pending, now) for message_id in cited]
    rows = [row for row, _age in built[:ALERT_MAX_LISTED]]
    oldest = max((age for _row, age in built if age is not None), default=None)
    total = len(cited)
    plural = "" if total == 1 else "s"
    hidden = total - len(rows)
    hidden_note = ""
    if hidden > 0:
        hidden_plural = "" if hidden == 1 else "s"
        hidden_note = (f"<p>Mais {hidden} e-mail{hidden_plural} na mesma situação não "
                       "aparece(m) na lista acima.</p>")
    oldest_note = ""
    if oldest is not None:
        oldest_note = (" O mais antigo está parado há "
                       f"<strong>{html.escape(_fmt_age(oldest))}</strong>.")
    reason_text = html.escape(_clip(reason, _REASON_MAX_CHARS) or "não informado")
    header = "".join(_th(title) for title in ("Recebido em", "Remetente", "Assunto", "Parado há"))
    pronoun = "ele" if total == 1 else "eles"
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;color:#000000;">
<div style="max-width:820px;margin:0 auto;padding:24px;">
  <p>O leitor de e-mails do Contas a Pagar <strong>não conseguiu ler {total} e-mail{plural}
     financeiro{plural}</strong>.{oldest_note} Nenhuma conta foi gerada para
     {pronoun} até agora.</p>
  <p><strong>Motivo registrado:</strong> {reason_text}</p>
  <table style="border-collapse:collapse;width:100%;font-size:10pt;">
    <thead><tr style="background-color:#f0f0f0;">{header}</tr></thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
  {hidden_note}
  <p><strong>O que conferir:</strong> o saldo e a chave da API Anthropic; a tela
     <em>Recebimentos &rsaquo; Erros</em> (tipo <code>erro_api</code>); e o log do leitor no
     servidor. O leitor tenta de novo sozinho a cada execução — quando os e-mails forem lidos,
     saem da tela de erros sem nenhuma ação.</p>
  <p style="color:#555555;font-size:9pt;">Aviso automático. Não se repete nas próximas
     {ALERT_COOLDOWN_HOURS} horas, mesmo que a situação continue. Respostas a esta mensagem
     não são lidas pelo leitor.</p>
</div></body></html>"""


# ---------------------------------------------------------------------------
# Envio e carimbo
# ---------------------------------------------------------------------------
def _load_email_sender():
    """Módulo `email_sender` da cobrança, carregado por caminho. LEVANTA se não der."""
    spec = importlib.util.spec_from_file_location("reader_alert_email_sender", EMAIL_SENDER_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"não foi possível carregar {EMAIL_SENDER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _open_session(dev_mode: bool, dev_override: str):
    """`SmtpSession` da cobrança, com o mailbox do leitor como remetente/Reply-To."""
    sender = _load_email_sender()
    return sender.SmtpSession(
        {"email": os.environ.get("IMAP_USER", ""), "trade_name": ALERT_FROM_NAME},
        dev_mode=dev_mode, dev_override=dev_override)


def _send(recipients: list[str], subject: str, html_body: str) -> int:
    """Envia UM e-mail por destinatário. Devolve quantos o servidor aceitou. Nunca levanta."""
    dev_mode = os.environ.get("DEV_MODE", "false").strip().lower() == "true"
    dev_override = os.environ.get("DEV_OVERRIDE_EMAIL", "").strip()
    if dev_mode:
        if not dev_override:
            log.warning("[ALERTA] DEV_MODE ativo sem DEV_OVERRIDE_EMAIL — alerta NÃO enviado")
            return 0
        # Em DEV_MODE todos os destinatários viram a mesma caixa de teste: um envio basta.
        recipients = recipients[:1]
    try:
        session = _open_session(dev_mode, dev_override)
        send_params = inspect.signature(session.send).parameters
    except Exception:  # noqa: BLE001
        # Arquivo ausente, import quebrado ou SMTP_FROM_ADDR malformado: o run não cai por isso.
        log.exception("[ALERTA] não foi possível preparar o envio (email_sender.py ausente ou "
                      "configuração SMTP inválida). Deploy parcial?")
        return 0
    # `email_sender.py` anterior a este alerta não conhece `signature`. Avisar COM a imagem da
    # assinatura é melhor do que não avisar — o deploy parcial não pode calar o alerta.
    extra = {"signature": False} if "signature" in send_params else {}
    if not extra:
        log.warning("[ALERTA] email_sender.py sem o parâmetro `signature` — o aviso sai com a "
                    "imagem de assinatura da cobrança. Deploy parcial?")
    accepted = 0
    with session:
        for recipient in recipients:
            try:
                session.send(to_email=recipient, cc_email=None, subject=subject,
                             html_body=html_body, **extra)
                accepted += 1
            except smtplib.SMTPRecipientsRefused as e:
                # Problema DESTE endereço: os outros destinatários ainda podem receber.
                log.warning("[ALERTA] destinatário recusado pelo servidor (%s): %s", recipient, e)
            except (smtplib.SMTPException, OSError) as e:
                # Problema do SERVIDOR ou da conexão: repetir para os demais só somaria timeouts.
                log.warning("[ALERTA] envio falhou (%s); demais destinatários não tentados: %s",
                            recipient, e)
                break
            except Exception:  # noqa: BLE001
                # Erro que não é de rede/SMTP é bug: fica com traceback, e o run não cai.
                log.exception("[ALERTA] erro inesperado ao enviar para %s", recipient)
                break
    return accepted


def _stamp_all(message_ids: list[str], stamp, when_iso: str) -> int:
    """Carimba o alerta em TODAS as linhas citadas. Devolve quantas foram gravadas.

    🔴 Todas, e não só a mais antiga: a linha some quando o e-mail conclui. Com o carimbo numa
    linha só, bastaria aquele e-mail ser lido para os demais — ainda parados — dispararem um
    alerta novo no run seguinte, dentro da carência.
    """
    deadline = time.monotonic() + ALERT_STAMP_BUDGET_SECONDS
    stamped = 0
    for index, message_id in enumerate(message_ids):
        if time.monotonic() > deadline:
            log.warning("[ALERTA] carimbo interrompido pelo teto de %s s: %d de %d linhas "
                        "carimbadas", ALERT_STAMP_BUDGET_SECONDS, stamped, len(message_ids))
            break
        try:
            if stamp(message_id, when_iso):
                stamped += 1
        except Exception:  # noqa: BLE001
            # `stamp` é injetado; se levantar, as linhas seguintes ainda merecem o carimbo.
            log.exception("[ALERTA] falha ao carimbar a linha %d de %d", index + 1,
                          len(message_ids))
    return stamped


# ---------------------------------------------------------------------------
# Ponto de entrada
# ---------------------------------------------------------------------------
def notify_stuck(*, deferred: dict, pending: dict, stamp, subject_marker: str,
                 reason: str | None = None, now: datetime | None = None) -> str:
    """Avisa por e-mail se algum e-mail adiado neste run está parado há tempo demais.

    Args:
        deferred: `{message_id: {subject, sender_email, received_at}}` — os adiados DESTE run.
        pending:  mapa de `SupabaseControl.pending_api_errors()`, lido no INÍCIO do run.
        stamp:    `(message_id, when_iso) -> bool` — grava o carimbo na linha do e-mail.
        subject_marker: marcador fixo do assunto (o leitor o usa para ignorar o próprio alerta).
        reason:   motivo da 1ª recusa do run (vai escapado no corpo).
        now:      instante de referência (injetável em teste); padrão = agora, em UTC.

    Devolve um dos `OUTCOME_*`. Envio que falha NÃO carimba: o próximo run tenta de novo.
    """
    recipients = parse_recipients(os.environ.get(ENV_RECIPIENTS))
    if not recipients:
        return OUTCOME_DISABLED
    deferred = deferred if isinstance(deferred, dict) else {}
    pending = pending if isinstance(pending, dict) else {}
    now = now or datetime.now(timezone.utc)

    stuck = select_stuck(deferred, pending, now)
    if not stuck:
        return OUTCOME_NOT_DUE
    last = last_alert_at(pending, now)
    if last is not None and now - last < timedelta(hours=ALERT_COOLDOWN_HOURS):
        log.info("[ALERTA] %d e-mail(s) parado(s), mas já houve aviso em %s — em carência",
                 len(stuck), _fmt_local(last))
        return OUTCOME_COOLDOWN

    # Os parados primeiro (são o motivo do aviso); depois os demais adiados do run.
    stuck_set = set(stuck)
    cited = stuck + [message_id for message_id in deferred if message_id not in stuck_set]
    accepted = _send(recipients, build_subject(subject_marker, len(cited)),
                     render_alert(cited, deferred, pending, now, reason))
    if not accepted:
        log.error("[ALERTA] %d e-mail(s) parado(s) e o aviso NÃO pôde ser enviado — nova "
                  "tentativa no próximo run", len(stuck))
        return OUTCOME_SEND_FAILED

    stamped = _stamp_all(cited, stamp, now.isoformat())
    if stamped:
        log.warning("[ALERTA] aviso enviado a %d destinatário(s): %d e-mail(s) sem leitura "
                    "(%d linha(s) carimbada(s))", accepted, len(cited), stamped)
    else:
        log.error("[ALERTA] aviso enviado, mas NENHUMA linha pôde ser carimbada — o aviso vai "
                  "se repetir no próximo run")
    return OUTCOME_SENT


# ---------------------------------------------------------------------------
# Teste do canal (CLI) — `py -3 skills\email-reader\scripts\reader_alert.py --test`
# ---------------------------------------------------------------------------
def send_test(subject_marker: str) -> bool:
    """Envia UM e-mail de TESTE aos destinatários de `READER_ALERT_TO`. True se algum aceitou.

    Percorre o MESMO caminho do alerta real (destinatários, sessão SMTP, DEV_MODE), mas não lê
    nem grava nada no banco: serve para provar, depois de um deploy, que o aviso chega a alguém.
    Um alerta cujo canal nunca foi exercitado só revela o defeito no dia em que é necessário.
    """
    recipients = parse_recipients(os.environ.get(ENV_RECIPIENTS))
    if not recipients:
        log.error("[ALERTA] %s vazio ou ausente no .env — o alerta está DESLIGADO; nada a testar",
                  ENV_RECIPIENTS)
        return False
    body = f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;color:#000000;">
<div style="max-width:820px;margin:0 auto;padding:24px;">
  <p><strong>Este é um TESTE do alerta do leitor de e-mails do Contas a Pagar.</strong></p>
  <p>Nenhum e-mail está parado. Se você recebeu esta mensagem, o canal de aviso funciona: é por
     ele que chega o alerta quando um e-mail financeiro fica mais de {ALERT_MIN_AGE_MINUTES}
     minutos sem leitura.</p>
  <p style="color:#555555;font-size:9pt;">Enviado manualmente em
     {html.escape(_fmt_local(datetime.now(timezone.utc)))}. Respostas a esta mensagem não são
     lidas pelo leitor.</p>
</div></body></html>"""
    accepted = _send(recipients, f"{subject_marker} TESTE do canal de aviso", body)
    if accepted:
        log.info("[ALERTA] teste enviado a %d de %d destinatário(s)", accepted, len(recipients))
    else:
        log.error("[ALERTA] teste NÃO enviado — ver as mensagens acima")
    return bool(accepted)


def main(argv: list[str] | None = None) -> int:
    """CLI: `--test` envia o e-mail de teste. Exit 0 = aceito; 1 = não enviado; 2 = uso."""
    import argparse

    parser = argparse.ArgumentParser(description="Alerta ativo do leitor de e-mails")
    parser.add_argument("--test", action="store_true",
                        help=f"envia UM e-mail de teste aos destinatários de {ENV_RECIPIENTS}")
    args = parser.parse_args(argv)
    if not args.test:
        parser.print_help()
        return 2
    # Importar o leitor carrega o `.env` da raiz, configura o log e dá o marcador do assunto —
    # exatamente o ambiente em que o alerta real roda. Só aqui: o módulo em si não o importa.
    import read_emails
    return 0 if send_test(read_emails.READER_ALERT_SUBJECT_MARKER) else 1


if __name__ == "__main__":
    raise SystemExit(main())
