"""Remove do bucket `attachments` os objetos ORFAOS — os que nenhuma linha referencia.

Contexto: `upload_attachment` publica TODO PDF no Passo 1, ANTES de saber se ele vira conta.
Quando nao vira (CT-e/NF-e ignorado, fatura cujo boleto virou a conta, confirmacao de pagamento,
duplicidade), o objeto fica no bucket sem nenhuma linha apontando para ele. Depois da migration
080 esses objetos sao invisiveis pela API (a policy exige uma linha visivel), entao so ocupam
espaco.

ORFAO = objeto do bucket que NAO e referenciado por:
  - financial_account_attachment.storage_key  (o padrao unico, migration 079), NEM
  - financial_account_control.source_file     (o anexo do e-mail sem linha registrada)

PRESERVA (nao apaga) o objeto que ainda representa TRABALHO EM ABERTO:
  - e-mail em `pendente`  → o PDF aguarda reprocessamento (retry_extraction);
  - e-mail em `falha`     → idem;
  - objeto citado em email_processing_errors.raw_payload → e a evidencia de um documento cuja
    extracao falhou e que ainda pode virar conta a mao.
Para esses, o bucket e a copia acessivel — o original so existe no IMAP.

IRREVERSIVEL. Use --dry-run primeiro (padrao do projeto). O backup diario (skill
`backup-supabase`, 02:00) inclui o bucket, entao ha rede de seguranca.

Uso:
    py -3 scripts/purge_orphan_attachments.py --dry-run   # lista o que faria
    py -3 scripts/purge_orphan_attachments.py             # apaga
"""

import argparse
import json
import logging
import sys
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv
import os

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "email-reader" / "scripts"))
load_dotenv(ROOT / ".env")

from read_emails import safe_filename  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("purge")

BASE = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_KEY")
BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "attachments")
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# Status de e-mail cujo anexo AINDA pode virar conta — nunca apagar.
KEEP_EMAIL_STATUSES = {"pendente", "falha"}
DELETE_BATCH = 100   # a Storage API aceita varios prefixes por chamada


def _rest(path: str):
    req = urllib.request.Request(f"{BASE}/rest/v1/{path}", headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def _storage_list() -> list[str]:
    """Todos os objetos do bucket (a API pagina em 100 por padrao)."""
    names, offset = [], 0
    while True:
        body = json.dumps({"prefix": "", "limit": 1000, "offset": offset}).encode()
        req = urllib.request.Request(
            f"{BASE}/storage/v1/object/list/{BUCKET}", data=body, headers=HEADERS, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            page = json.loads(r.read())
        if not page:
            break
        names.extend(o["name"] for o in page if o.get("name"))
        offset += len(page)
        if len(page) < 1000:
            break
    return names


def _storage_remove(keys: list[str]) -> int:
    """DELETE em lote. O corpo vai como JSON (nao normaliza path — sem risco de traversal)."""
    body = json.dumps({"prefixes": keys}).encode()
    req = urllib.request.Request(
        f"{BASE}/storage/v1/object/{BUCKET}", data=body, headers=HEADERS, method="DELETE")
    with urllib.request.urlopen(req, timeout=120) as r:
        return len(json.loads(r.read()))


def _protected_prefixes(emails: list[dict]) -> list[str]:
    """Prefixos de chave dos e-mails cujo anexo deve ser PRESERVADO.

    Reconstroi o `{sender_tag}_{subject_tag}_{YYYYMMDD}_` que save_attachments monta, usando o
    safe_filename REAL — e a unica forma de ligar o objeto (nome flat) ao e-mail de origem.
    """
    out = []
    for e in emails:
        if e.get("status") not in KEEP_EMAIL_STATUSES or not e.get("received_at"):
            continue
        date_tag = e["received_at"][:10].replace("-", "")
        sender_tag = safe_filename((e.get("sender_email") or "").split("@")[0], 20)
        subject_tag = safe_filename(e.get("subject") or "", 30)
        out.append(f"{sender_tag}_{subject_tag}_{date_tag}_")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="lista o que seria apagado, sem apagar")
    args = ap.parse_args()

    if not BASE or not KEY:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY ausentes no .env")
        return 1

    objetos = _storage_list()
    anexos = {a["storage_key"] for a in _rest("financial_account_attachment?select=storage_key")}
    sources = {f["source_file"] for f in
               _rest("financial_account_control?select=source_file&source_file=not.is.null")}
    emails = _rest("email_control?select=message_id,sender_email,subject,status,received_at")
    erros = _rest("email_processing_errors?select=raw_payload")
    erros_txt = json.dumps(erros, ensure_ascii=False)

    orfaos = [n for n in objetos if n not in anexos and n not in sources]
    protegidos_pref = _protected_prefixes(emails)

    apagar, preservar = [], []
    for nome in orfaos:
        motivo = None
        if any(nome.startswith(p) for p in protegidos_pref):
            motivo = "e-mail em pendente/falha (pode virar conta)"
        elif nome in erros_txt:
            motivo = "citado em email_processing_errors (extracao falhou)"
        (preservar.append((nome, motivo)) if motivo else apagar.append(nome))

    log.info(f"objetos no bucket ..... {len(objetos)}")
    log.info(f"com linha (mantidos) .. {len(objetos) - len(orfaos)}")
    log.info(f"ORFAOS ................ {len(orfaos)}")
    log.info(f"  a PRESERVAR ......... {len(preservar)}")
    for nome, motivo in preservar:
        log.info(f"    ~ {nome}  [{motivo}]")
    log.info(f"  a APAGAR ............ {len(apagar)}")

    if args.dry_run:
        for nome in apagar[:10]:
            log.info(f"    - {nome}")
        if len(apagar) > 10:
            log.info(f"    ... e mais {len(apagar) - 10}")
        log.info("\n[dry-run] nada foi apagado.")
        return 0

    removidos = 0
    for i in range(0, len(apagar), DELETE_BATCH):
        lote = apagar[i:i + DELETE_BATCH]
        try:
            removidos += _storage_remove(lote)
            log.info(f"  removidos {removidos}/{len(apagar)}")
        except urllib.error.HTTPError as e:
            log.exception(f"Falha no lote {i // DELETE_BATCH + 1}: {e.code} {e.read()[:200]}")
            return 1

    log.info(f"\nOK: {removidos} objetos removidos; {len(preservar)} preservados.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
