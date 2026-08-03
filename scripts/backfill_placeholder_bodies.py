"""Regrava o corpo dos e-mails cujo texto salvo e apenas um AVISO de "conteudo em HTML".

O QUE ISTO CONSERTA
    Ate 2026-08-03 o reader so caia no HTML quando o texto plano vinha VAZIO. A plataforma
    SSW envia um `text/plain` de 55 caracteres dizendo que a mensagem esta em HTML — nao
    e vazio, entao o fallback nunca disparava e o aviso era gravado como se fosse o corpo.
    Resultado: 29 e-mails com `body_full` inutil (a tool `buscar_emails` do chat nao os
    enxerga) e a guarda do cedente SSW sem texto para ler.

    O reader ja foi corrigido (`_plain_body_is_placeholder`), entao e-mail NOVO nasce certo.
    Este script cuida do passivo — e so dele.

ALCANCE REAL (medido em 2026-08-03, antes de escrever o coletor)
    Dos 29 e-mails afetados, apenas **5** ainda estao na INBOX; os outros 24 sairam da caixa
    e sao IRRECUPERAVEIS — nao ha segunda passada que os traga. E o mesmo padrao que derrubou
    a premissa da Onda 4: a caixa guarda ~3 meses. Medir a fonte ANTES vale mais que o coletor.

INVARIANTES (nao afrouxar)
    1. NUNCA grava conta. Este script nao conhece `financial_account_control`; so reescreve
       duas colunas de `email_control`.
    2. NUNCA marca \\Seen. A INBOX e aberta em EXAMINE (`readonly=True`, em que o servidor nao
       *pode* gravar flag permanente) e todo fetch usa BODY.PEEK.
    3. So substitui corpo-PLACEHOLDER, e o filtro vai NA URL do PATCH — atomico no servidor,
       imune a corrida com o reader agendado (que roda a cada 5 min).
    4. Usa as MESMAS funcoes do reader (`_plain_body_is_placeholder`, `_html_to_text`,
       `_body_full_for_storage`). Reimplementar a regra aqui criaria uma 2a fonte de verdade,
       fadada a divergir — foi assim que o teto do corpo quase ficou incoerente entre camadas.

USO
    py -3 scripts\\backfill_placeholder_bodies.py --dry-run
    py -3 scripts\\backfill_placeholder_bodies.py
"""

import argparse
import email
import imaplib
import logging
import os
import sys
import urllib.parse
from pathlib import Path

from dotenv import load_dotenv

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "scripts"))
sys.path.insert(0, str(RAIZ / "skills" / "email-reader" / "scripts"))

from supabase_rest import RestError, rest_get, rest_write  # noqa: E402

log = logging.getLogger("backfill-placeholder")

TABELA = "email_control"
# Teto do preview na tela /emails — o mesmo do reader (nao unificar com body_full: sao
# preview e conteudo, papeis distintos).
PREVIEW_MAX = 500


def _reader():
    """Importa o reader tarde: ele puxa pdfplumber/anthropic, caros e desnecessarios no --dry-run
    de contagem. Falha aqui e ERRO, nao degradacao — sem as funcoes canonicas nao ha o que fazer."""
    import read_emails as R

    return R


def _headers(key: str) -> dict:
    return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def candidatos(base: str, headers: dict) -> list:
    """E-mails cujo `body_full` e um aviso de conteudo-em-HTML.

    O filtro fino roda AQUI (em Python, pela funcao canonica) e nao no PostgREST: a deteccao
    depende do regex + teto de tamanho do reader, e traduzi-la para `ilike` seria a 2a fonte
    de verdade que o cabecalho deste arquivo proibe.
    """
    R = _reader()
    linhas = rest_get(
        base, headers,
        f"{TABELA}?select=id,message_id,received_at,status,body_full"
        f"&body_full=not.is.null&order=id",
    )
    return [
        r for r in linhas
        if r.get("message_id") and R._plain_body_is_placeholder(r.get("body_full"))
    ]


def _abrir_inbox():
    """INBOX em EXAMINE — o servidor nao pode gravar flag permanente nesse modo."""
    host = os.environ["IMAP_HOST"]
    m = imaplib.IMAP4_SSL(host, timeout=int(os.getenv("IMAP_TIMEOUT", "120")))
    m.login(os.environ["IMAP_USER"], os.environ["IMAP_PASS"])
    typ, _ = m.select(os.getenv("IMAP_MAILBOX", "INBOX"), readonly=True)
    if typ != "OK":
        raise RuntimeError(f"nao foi possivel abrir a caixa em modo leitura: {typ}")
    return m


def _mapa_da_caixa(m) -> dict:
    """Message-ID -> UID de tudo que esta na INBOX. Um SEARCH + um FETCH de cabecalho, em vez
    de um SEARCH por e-mail (que seria uma ida ao servidor por item)."""
    typ, data = m.search(None, "ALL")
    if typ != "OK" or not data or not data[0]:
        return {}
    uids = data[0].split()
    typ, fetched = m.fetch(b",".join(uids), "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
    mapa = {}
    if typ != "OK":
        return mapa
    for item in fetched:
        if isinstance(item, tuple) and isinstance(item[1], (bytes, bytearray)):
            cabecalho = email.message_from_bytes(bytes(item[1])).get("Message-ID", "").strip()
            # O primeiro campo da tupla traz "<n> (BODY[...]" — o numero de sequencia.
            prefixo = item[0].decode(errors="replace").split()[0]
            if cabecalho:
                mapa[cabecalho] = prefixo
    return mapa


def corpo_do_html(m, seq: str) -> str:
    """Texto extraido da parte HTML da mensagem. BODY.PEEK: nao marca \\Seen."""
    R = _reader()
    typ, data = m.fetch(seq, "(BODY.PEEK[])")
    if typ != "OK":
        return ""
    # Contrato da funcao canonica: devolve a TUPLA (meta, raw) e LEVANTA quando o FETCH
    # nao traz conteudo — quem chama trata (o laco de main isola a falha por mensagem).
    _meta, bruto = R._rfc822_from_fetch(data)
    if not bruto:
        return ""
    msg = email.message_from_bytes(bruto)
    return R._html_to_text(R.get_body_html(msg))


def gravar(base: str, headers: dict, linha_id: int, corpo: str) -> tuple:
    """PATCH condicional: so escreve se o corpo NO BANCO ainda for o aviso.

    O filtro extra na URL e o que torna a operacao segura diante do reader agendado — se ele
    tiver corrigido o registro nesse meio tempo, o PATCH simplesmente nao encontra a linha.
    """
    R = _reader()
    payload = {
        "body_full": R._body_full_for_storage(corpo),
        "body_preview": corpo[:PREVIEW_MAX].replace("\n", " "),
    }
    filtro = urllib.parse.quote("*em HTML*")
    return rest_write(
        base, headers,
        f"{TABELA}?id=eq.{linha_id}&body_full=ilike.{filtro}",
        payload, method="PATCH",
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="mede e relata, sem gravar nada")
    ap.add_argument("--limit", type=int, default=0, help="processa no maximo N e-mails")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    load_dotenv(RAIZ / ".env")

    base = os.environ["SUPABASE_URL"]
    headers = _headers(os.environ["SUPABASE_SERVICE_KEY"])

    try:
        alvos = candidatos(base, headers)
    except RestError as e:
        log.error("falha ao consultar o Supabase: %s — NADA foi alterado", e)
        return 1
    log.info("e-mails com corpo-placeholder: %d", len(alvos))
    if not alvos:
        return 0

    m = _abrir_inbox()
    try:
        caixa = _mapa_da_caixa(m)
        log.info("mensagens na INBOX: %d", len(caixa))

        recuperaveis = [r for r in alvos if r["message_id"] in caixa]
        perdidos = len(alvos) - len(recuperaveis)
        log.info("recuperaveis: %d | fora da caixa (irrecuperaveis): %d",
                 len(recuperaveis), perdidos)
        if args.limit:
            recuperaveis = recuperaveis[: args.limit]

        ok = falhou = vazio = 0
        for r in recuperaveis:
            rid, mid = r["id"], r["message_id"]
            try:
                corpo = corpo_do_html(m, caixa[mid])
            except Exception:
                # Uma mensagem problematica nao pode derrubar o lote.
                log.exception("  id=%s: falha ao ler a mensagem no IMAP", rid)
                falhou += 1
                continue
            if not corpo:
                # Sem HTML aproveitavel, sobrescrever deixaria o registro PIOR (sem nem o aviso).
                log.info("  id=%s: HTML sem texto aproveitavel — preservado", rid)
                vazio += 1
                continue
            if args.dry_run:
                log.info("  id=%s: [dry-run] gravaria %d chars", rid, len(corpo))
                ok += 1
                continue
            gravou, motivo = gravar(base, headers, rid, corpo)
            if gravou:
                log.info("  id=%s: corpo regravado (%d chars)", rid, len(corpo))
                ok += 1
            else:
                log.error("  id=%s: falha ao gravar — %s", rid, motivo)
                falhou += 1

        log.info("resumo: %d %s | %d sem html | %d falhas | %d irrecuperaveis",
                 ok, "simulados" if args.dry_run else "regravados", vazio, falhou, perdidos)
        return 1 if falhou else 0
    finally:
        try:
            m.logout()
        except Exception:
            log.exception("falha ao encerrar a conexao IMAP")


if __name__ == "__main__":
    sys.exit(main())
