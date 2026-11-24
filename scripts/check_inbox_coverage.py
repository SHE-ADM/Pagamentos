"""Conferencia de COBERTURA da caixa postal — SOMENTE LEITURA.

A PERGUNTA QUE ELE RESPONDE
    "Toda mensagem que esta na INBOX tem linha em `email_control`?"
    O reader registra TODOS os e-mails (a keyword decide o que extrair, nao o que registrar),
    entao mensagem na caixa sem linha no controle e sempre um e-mail que o pipeline nao leu.

POR QUE EXISTE (caso real, 18 a 21/11/2026)
    Um anexo de imagem com a extensao errada fez a Claude API responder 400; esse erro era lido
    como "API fora do ar", o e-mail voltava a cada 5 min e o circuit breaker adiava todos os
    financeiros seguintes. 14 e-mails sairam da janela de leitura sem NUNCA serem registrados —
    e nada no banco os mostrava: `email_control` nao tem linha para o que nao foi lido. A unica
    verificacao que encontra esse tipo de perda e comparar a FONTE com o que foi gravado.

O QUE ELE NUNCA FAZ (imposto por estrutura, como na varredura historica)
    - Nao grava nada: nenhum POST/PATCH/DELETE; so `rest_get`.
    - Nao marca \\Seen: fala com a caixa SO pela classe `Caixa` da varredura historica, que
      reabre a pasta em EXAMINE (`readonly=True`) e busca cabecalho com `BODY.PEEK`.
    - Nao baixa corpo nem anexo: um FETCH de cabecalho por mensagem.

NAO EXIGE DEPLOY: vive em `scripts/`, fora dos DEPLOY_GLOBS.

Uso:
    py -3 scripts\\check_inbox_coverage.py                      # ultimos 7 dias
    py -3 scripts\\check_inbox_coverage.py --days 30
    py -3 scripts\\check_inbox_coverage.py --days 3 --min-age-minutes 60

Exit code:
    0 = toda mensagem da janela esta registrada
    1 = ha mensagem SEM registro (listadas na saida)
    2 = nao foi possivel conferir (IMAP/Supabase indisponivel, ou mensagem ilegivel)
"""

import argparse
import email
import logging
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# `varredura_historica` ja carrega o .env, o reader (`R`) e a camada IMAP somente-leitura.
import varredura_historica as V  # noqa: E402
from supabase_rest import RestError, rest_get  # noqa: E402

log = logging.getLogger("cobertura")

DEFAULT_DAYS = 7
MAX_DAYS = 365
# Mensagem mais nova que isto ainda esta dentro da cadencia do reader (5 min) — nao e perda.
DEFAULT_MIN_AGE_MINUTES = 15
MAX_MIN_AGE_MINUTES = 24 * 60

EXIT_OK = 0
EXIT_MISSING = 1
EXIT_UNVERIFIED = 2

# Meses do IMAP (RFC 3501) escritos por extenso: `strftime("%b")` depende do locale do processo,
# e "fev"/"abr"/"mai" seriam recusados pelo servidor.
_IMAP_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def imap_since(days: int, today: date | None = None) -> str:
    """Criterio `SINCE` do IMAP para os ultimos `days` dias (a data e do servidor, sem hora)."""
    start = (today or date.today()) - timedelta(days=days)
    return f'SINCE "{start.day:02d}-{_IMAP_MONTHS[start.month - 1]}-{start.year}"'


def load_known_ids() -> set:
    """Todos os `message_id` de `email_control`. Paginado e ordenado (`rest_get`)."""
    rows = rest_get(V.BASE, V.HEADERS, "email_control?select=message_id")
    return {row["message_id"] for row in rows if row.get("message_id")}


def _parse_received(value) -> datetime | None:
    """`received_at` (ISO com fuso) como datetime ciente; None se ilegivel."""
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def find_missing(caixa, uids: list, known_ids: set, now: datetime,
                 min_age: timedelta) -> tuple[list, int]:
    """Mensagens da caixa sem linha no controle. Devolve `(ausentes, nao_conferidas)`.

    Uma mensagem ilegivel NAO derruba a conferencia das demais, mas e CONTADA: uma conferencia
    que pulou mensagens nao pode sair com "cobertura completa".
    """
    missing: list = []
    unverified = 0
    for uid in uids:
        try:
            meta, raw, _size = caixa.previa(uid)
            identity = V._message_identity(email.message_from_bytes(raw), uid, meta)
        except Exception:  # noqa: BLE001
            # Isola UMA mensagem: e contada e logada com traceback, e o exit code a denuncia.
            log.exception(f"  uid {V._uid_str(uid)}: cabecalho ilegivel — mensagem NAO conferida")
            unverified += 1
            continue
        if identity["chave_indice"] in known_ids:
            continue
        received = _parse_received(identity["received_at"])
        if received is not None and now - received < min_age:
            continue   # recem-chegada: o proximo run do reader ainda vai registra-la
        missing.append({"uid": V._uid_str(uid), **identity})
    return missing, unverified


def _report(missing: list, unverified: int, total: int, criteria: str) -> None:
    log.info(f"Mensagens na caixa ({criteria}): {total}")
    log.info(f"Sem registro em email_control: {len(missing)}")
    for item in missing:
        log.info(f"  UID {item['uid']} | {item['received_at']} | {item['sender_email']} | "
                 f"{(item['subject'] or '')[:90]}")
        log.info(f"      Message-ID: {item['message_id'] or '(ausente)'}")
    if unverified:
        log.warning(f"Mensagens NAO conferidas (cabecalho ilegivel): {unverified}")
    if missing:
        log.info("Para recuperar: .venv\\Scripts\\python.exe "
                 "skills\\email-reader\\scripts\\read_emails.py --days <N que cubra as datas acima>")


def _parse_args(argv) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Confere, sem gravar nada, se toda mensagem da INBOX esta em email_control.")
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS,
                        help=f"Janela em dias (1 a {MAX_DAYS}; padrao {DEFAULT_DAYS})")
    parser.add_argument("--min-age-minutes", type=int, default=DEFAULT_MIN_AGE_MINUTES,
                        help="Ignora mensagem mais nova que isto — ainda na cadencia do reader "
                             f"(0 a {MAX_MIN_AGE_MINUTES}; padrao {DEFAULT_MIN_AGE_MINUTES})")
    args = parser.parse_args(argv)
    if not 1 <= args.days <= MAX_DAYS:
        parser.error(f"--days deve estar entre 1 e {MAX_DAYS}")
    if not 0 <= args.min_age_minutes <= MAX_MIN_AGE_MINUTES:
        parser.error(f"--min-age-minutes deve estar entre 0 e {MAX_MIN_AGE_MINUTES}")
    return args


def main(argv=None) -> int:
    args = _parse_args(argv)
    criteria = imap_since(args.days)

    try:
        known_ids = load_known_ids()
    except RestError as e:
        log.exception(f"Nao foi possivel ler email_control: {e}")
        return EXIT_UNVERIFIED
    if not known_ids:
        # Controle vazio faria TODA a caixa aparecer como "sem registro": e falha de leitura
        # (ou base recem-limpa), nao um achado — nao pode sair como lista de perdas.
        log.error("email_control veio vazio — conferencia nao realizada.")
        return EXIT_UNVERIFIED

    caixa = V.Caixa(criterio=criteria)
    try:
        uids = caixa.abrir()
        missing, unverified = find_missing(
            caixa, uids, known_ids, datetime.now(timezone.utc),
            timedelta(minutes=args.min_age_minutes))
    except RuntimeError as e:   # falha de IMAP ja com retry esgotado (_connect_and_search)
        log.exception(f"Nao foi possivel ler a caixa postal: {e}")
        return EXIT_UNVERIFIED
    finally:
        V.R._safe_logout(caixa.mail)

    _report(missing, unverified, len(uids), criteria)
    if missing:
        return EXIT_MISSING
    return EXIT_UNVERIFIED if unverified else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
