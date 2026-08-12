"""Preenche o conteudo do CT-e (peso, rota, NF, frete) em `fiscal_document` — Onda 5, item 5.3.

Le as faturas agregadas da BRASPRESS que ja estao no bucket e grava, em cada CT-e ja registrado,
os campos que a migration 119 criou. NAO cria documento: quem faz isso e
`backfill_fiscal_documents.py`. Aqui so se ATUALIZA linha existente — chave que ainda nao esta
na tabela e reportada, nunca inserida pela porta dos fundos.

POR QUE VARRE `fiscal_document` E NAO O BUCKET INTEIRO
    So da para atualizar CT-e que ja existe na tabela, e todo CT-e da tabela veio de um PDF cujo
    `storage_key` esta gravado. Varrer os 144 storage_keys distintos em vez dos 657 objetos do
    bucket cobre exatamente a mesma populacao por um quarto do download.

FAIL-CLOSED HERDADO DO PARSER
    `cte_content.parse_braspress_invoice` devolve NADA quando a soma do que extraiu nao bate com
    o SUB-TOTAL impresso na fatura. Este script nao contorna isso: fatura que nao fecha entra em
    `nao_fechou` e nenhum dos seus conhecimentos e gravado. Rateio incompleto atribui frete ao
    conjunto errado — dado ausente e melhor.

IDEMPOTENTE: reexecutar reescreve os mesmos valores. Nao sobrescreve conteudo de outra fonte
(`content_source` diferente de 'braspress_invoice'), para o dia em que o DACTE for lido por LLM.

Uso:
    py -3 scripts/backfill_cte_content.py --dry-run     # so relata
    py -3 scripts/backfill_cte_content.py               # grava
"""

import argparse
import io
import logging
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from decimal import Decimal
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
load_dotenv(ROOT / ".env")

import cte_content  # noqa: E402
from supabase_rest import NETWORK_ERRORS, RestError, rest_get, rest_write  # noqa: E402

BUCKET = "attachments"
CONTENT_SOURCE = "braspress_invoice"
DOWNLOAD_TIMEOUT = 60
DOWNLOAD_ATTEMPTS = 3
RETRY_BACKOFF = 2.0

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("backfill-cte")


def _headers() -> dict:
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return {"Authorization": f"Bearer {key}", "apikey": key, "Content-Type": "application/json"}


def _download(base: str, headers: dict, storage_key: str) -> "bytes | None":
    """Baixa o objeto com retry/backoff. None (logado) quando nao vem — um PDF ilegivel nao
    pode derrubar a varredura dos demais."""
    url = f"{base}/storage/v1/object/{BUCKET}/{urllib.parse.quote(storage_key, safe='')}"
    req = urllib.request.Request(url, headers={"Authorization": headers["Authorization"],
                                               "apikey": headers["apikey"]})
    for tentativa in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            log.warning("  download %s: HTTP %s (sem retry)", storage_key[:60], e.code)
            return None
        except NETWORK_ERRORS as e:
            if tentativa == DOWNLOAD_ATTEMPTS:
                log.warning("  download %s: rede (%s) apos %d tentativas",
                            storage_key[:60], e, DOWNLOAD_ATTEMPTS)
                return None
            import time
            time.sleep(RETRY_BACKOFF * tentativa)
    return None


def _pdf_text(data: bytes, storage_key: str) -> str:
    """Texto do PDF. String vazia quando nao ha camada de texto (escaneado/cifrado)."""
    try:
        import pdfplumber  # noqa: PLC0415 — import local: so este passo precisa da dependencia
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            return "\n".join((p.extract_text() or "") for p in pdf.pages)
    except Exception:
        # Nunca silenciar: PDF ilegivel e um RESULTADO do backfill, nao um bug.
        log.exception("  pdfplumber falhou em %s", storage_key[:60])
        return ""


def _payload(item: dict) -> dict:
    """Item do parser -> corpo do PATCH. Decimal/date viram string (JSON nao os conhece)."""
    def num(v):
        return str(v) if isinstance(v, Decimal) else v
    return {
        "awb":                  item["awb"],
        "origin":               item["origin"],
        "destination":          item["destination"],
        "service_date":         item["service_date"].isoformat(),
        "cargo_weight_kg":      num(item["cargo_weight_kg"]),
        "cargo_amount":         num(item["cargo_amount"]),
        "freight_amount":       num(item["freight_amount"]),
        "linked_invoice":       item["linked_invoice"],
        "receiver_name":        item["receiver_name"],
        "content_source":       CONTENT_SOURCE,
        "content_extracted_at": "now()",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="so relata, sem gravar")
    ap.add_argument("--limit", type=int, default=0, help="processa no maximo N PDFs (diagnostico)")
    args = ap.parse_args()

    base = os.environ["SUPABASE_URL"].rstrip("/")
    headers = _headers()

    try:
        docs = rest_get(base, headers,
                        "fiscal_document?select=id,access_key,storage_key,model,content_source")
    except RestError as e:
        log.error("nao foi possivel ler fiscal_document: %s", e)
        return 1

    # Chaves ja registradas -> so elas podem receber conteudo.
    por_chave = {d["access_key"]: d for d in docs}
    pdfs = sorted({d["storage_key"] for d in docs if d.get("storage_key")})
    if args.limit:
        pdfs = pdfs[:args.limit]
    log.info("documentos: %d | PDFs distintos a varrer: %d", len(docs), len(pdfs))

    c = Counter()
    nao_fechou: list = []
    sem_registro: list = []

    for i, skey in enumerate(pdfs, 1):
        data = _download(base, headers, skey)
        if not data:
            c["download_falhou"] += 1
            continue
        texto = _pdf_text(data, skey)
        if not cte_content.is_braspress_invoice(texto):
            c["nao_e_fatura"] += 1
            continue

        itens = cte_content.parse_braspress_invoice(texto)
        if not itens:
            # O parser so devolve vazio aqui por causa do oraculo — a deteccao ja passou acima.
            c["nao_fechou_subtotal"] += 1
            nao_fechou.append(skey)
            log.warning("  SUB-TOTAL nao fechou, fatura IGNORADA: %s", skey[:70])
            continue

        c["faturas"] += 1
        for item in itens:
            doc = por_chave.get(item["access_key"])
            if not doc:
                c["chave_sem_registro"] += 1
                sem_registro.append(item["access_key"])
                continue
            # Nao sobrescrever conteudo vindo de outra fonte (ex.: DACTE por LLM, no futuro).
            if doc.get("content_source") and doc["content_source"] != CONTENT_SOURCE:
                c["outra_fonte_preservada"] += 1
                continue
            if args.dry_run:
                c["seriam_gravados"] += 1
                continue
            ok, motivo = rest_write(
                base, headers,
                f"fiscal_document?access_key=eq.{item['access_key']}",
                _payload(item), method="PATCH", prefer="return=minimal")
            if ok:
                c["gravados"] += 1
            else:
                c["erro_gravacao"] += 1
                log.warning("  PATCH %s falhou: %s", item["access_key"][-8:], motivo)
        if i % 25 == 0:
            log.info("  ... %d/%d PDFs", i, len(pdfs))

    log.info("")
    log.info("faturas BRASPRESS aceitas ... %d", c["faturas"])
    log.info("PDFs que nao sao fatura ..... %d", c["nao_e_fatura"])
    log.info("SUB-TOTAL nao fechou ........ %d %s", c["nao_fechou_subtotal"],
             nao_fechou[:3] if nao_fechou else "")
    log.info("chave sem registro na tabela  %d %s", c["chave_sem_registro"],
             sem_registro[:3] if sem_registro else "")
    log.info("conteudo de outra fonte ..... %d (preservado)", c["outra_fonte_preservada"])
    log.info("download falhou ............. %d", c["download_falhou"])
    if args.dry_run:
        log.info("SERIAM gravados ............. %d", c["seriam_gravados"])
        log.info("\n[dry-run] nada foi gravado.")
    else:
        log.info("GRAVADOS .................... %d", c["gravados"])
        if c["erro_gravacao"]:
            log.error("ERROS de gravacao ........... %d", c["erro_gravacao"])
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
