"""Remove do bucket `attachments` os objetos ORFAOS — os que nenhuma linha referencia.

Contexto: `upload_attachment` publica TODO PDF no Passo 1, ANTES de saber se ele vira conta.
Quando nao vira (CT-e/NF-e ignorado, fatura cujo boleto virou a conta, confirmacao de pagamento,
duplicidade), o objeto fica no bucket sem nenhuma linha apontando para ele. Depois da migration
080 esses objetos sao invisiveis pela API (a policy exige uma linha visivel), entao so ocupam
espaco.

ORFAO = objeto do bucket que NAO e referenciado por:
  - financial_account_attachment.storage_key  (o padrao unico, migration 079), NEM
  - financial_account_control.source_file     (o anexo do e-mail sem linha registrada), NEM
  - fiscal_document.storage_key               (documento fiscal, migration 107 — Onda 3)

A terceira fonte NAO e detalhe: CT-e/NF-e sem boleto e, por regra de negocio, o documento que
NUNCA vira conta — logo nenhuma das duas primeiras o alcanca. Antes da Onda 3 esses PDFs eram
apagados como orfaos (a purga de 15/07/2026 levou 67% dos CT-e); depois dela, o registro da
chave de acesso e o que os preserva.

PRESERVA (nao apaga) o objeto que ainda representa TRABALHO EM ABERTO:
  - e-mail em `pendente`  → o PDF aguarda reprocessamento (retry_extraction);
  - e-mail em `falha`     → idem;
  - objeto citado em email_processing_errors.raw_payload → e a evidencia de um documento cuja
    extracao falhou e que ainda pode virar conta a mao.
Para esses, o bucket e a copia acessivel — o original so existe no IMAP.

PRESERVA TAMBEM, pelo CONTEUDO: o orfao cujo PDF contem uma chave de acesso fiscal VALIDA.
  A preservacao por `fiscal_document.storage_key` cobre o PRIMEIRO objeto de cada chave — e
  `access_key` e UNIQUE. Quando a MESMA chave chega por dois objetos (o PDF consolidado da
  transportadora e o individual), o segundo nao consta em lugar nenhum, vira orfao e era apagado
  **mesmo sendo um DACTE legitimo**. Medido: 4 objetos nessa situacao em 2026-08-01 e **10** em
  2026-08-03 — a lacuna CRESCE a cada CT-e reenviado. Como a decisao aqui e irreversivel, a purga
  abre cada candidato e so apaga o que comprovadamente nao carrega documento fiscal.

PRESERVA TAMBEM o objeto RECEM-ESCRITO (menos de `MIN_AGE_HOURS`):
  o reader publica o anexo no Passo 1, ANTES de gravar a conta, e roda a cada 5 minutos em
  producao. O anexo de um run EM ANDAMENTO ainda nao tem linha nenhuma — para esta purga ele e
  indistinguivel de um orfao, e apaga-lo deixaria a conta que nasce segundos depois SEM o PDF,
  em silencio. Sem data legivel, tambem preserva. O que ficar de fora hoje cai na purga seguinte.

IRREVERSIVEL. Use --dry-run primeiro (padrao do projeto). O backup diario (skill
`backup-supabase`, 02:00) inclui o bucket, entao ha rede de seguranca.

REGISTRO: antes de apagar, a execucao real grava a lista COMPLETA das chaves em
`logs/purge_orphans_<data>_<hora>.txt`. Sem conseguir gravar o registro, nao apaga nada.

Uso:
    py -3 scripts/purge_orphan_attachments.py --dry-run   # lista o que faria
    py -3 scripts/purge_orphan_attachments.py             # apaga
"""

import argparse
import json
import logging
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
import os

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
load_dotenv(ROOT / ".env")

import fiscal_key  # noqa: E402
from read_emails import _pdf_text, safe_filename  # noqa: E402
from supabase_rest import RestError, rest_get, storage_list  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("purge")

BASE = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_KEY")
BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "attachments")
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# Status de e-mail cujo anexo AINDA pode virar conta — nunca apagar.
KEEP_EMAIL_STATUSES = {"pendente", "falha"}
DELETE_BATCH = 100   # a Storage API aceita varios prefixes por chamada

# Objeto escrito ha menos tempo que isto NUNCA e apagado (ver "RECEM-ESCRITO" na docstring).
# A janela real entre o upload e a linha e de minutos; 24 h e folga deliberada — esperar um dia
# para remover um orfao nao custa nada, e apagar o anexo de um run em andamento nao tem volta.
MIN_AGE_HOURS = 24
MOTIVO_RECENTE = f"escrito ha menos de {MIN_AGE_HOURS} h (pode ser de um run em andamento)"

# Onde a execucao real registra o que apagou (pasta ignorada pelo git).
PURGE_LOG_DIR = ROOT / "logs"


def _rest(path: str, order: str = "id"):
    """GET no PostgREST, PAGINADO — delega a `supabase_rest.rest_get` (fonte unica).

    NAO reintroduzir um `urlopen` local. O Supabase corta a resposta em "Max rows" (1000) e
    responde HTTP 200 — sem erro, sem excecao, sem sinal nenhum. Aqui isso decide o que e
    APAGADO do bucket, e a falha tem duas direcoes, ambas silenciosas:

      - truncar `emails` PERDE protecao (e-mail em pendente/falha deixa de ser preservado);
      - truncar `anexos`/`sources`/`fiscais` e PIOR: um objeto legitimamente referenciado vira
        falso orfao e e apagado, num run que reporta "orfaos removidos" com naturalidade.

    Medido em 2026-08-01: `email_control` ja tem 1158 linhas e devolvia 1000; as tres consultas
    de `referenciados` estavam entre 17% e 40% do teto, crescendo a cada conta lancada.
    """
    return rest_get(BASE, HEADERS, path, order)


def _storage_list() -> dict:
    """Todos os objetos do bucket, como `{nome: instante da ultima escrita}` — delega ao modulo
    compartilhado. Iterar o resultado devolve os nomes."""
    return storage_list(BASE, HEADERS, BUCKET, com_ultima_escrita=True)


def _escrito_ha_pouco(instante, agora: datetime) -> bool:
    """True se o objeto foi escrito ha menos de `MIN_AGE_HOURS` — OU se nao da para saber.

    As tres duvidas resolvem para PRESERVAR, porque esta funcao decide uma remocao irreversivel:
    data ausente, data ilegivel e data no futuro (relogio fora de sincronia) contam como recente.
    """
    try:
        escrito = datetime.fromisoformat(str(instante or ""))
    except ValueError:
        return True
    if escrito.tzinfo is None:
        escrito = escrito.replace(tzinfo=timezone.utc)
    return agora - escrito < timedelta(hours=MIN_AGE_HOURS)


def _grava_registro(apagar: list[str], agora: datetime) -> Path:
    """Grava a lista COMPLETA do que sera apagado e devolve o caminho. LEVANTA `OSError`.

    Roda ANTES do primeiro DELETE: se a purga cair no meio, o registro ja diz o que estava na
    fila. Em bytes, para o arquivo sair em LF mesmo no Windows.
    """
    PURGE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    caminho = PURGE_LOG_DIR / f"purge_orphans_{agora.astimezone():%Y%m%d_%H%M%S}.txt"
    linhas = [f"# purga de orfaos do bucket {BUCKET} — {agora.isoformat()}",
              f"# {len(apagar)} objeto(s) a remover", *apagar]
    caminho.write_bytes(("\n".join(linhas) + "\n").encode("utf-8"))
    return caminho


def _erro_source_files(erros: list[dict]) -> set:
    """Nomes de objeto citados em `email_processing_errors.raw_payload`.

    Le a CHAVE `source_file` em vez de procurar o nome como substring no JSON inteiro. O
    substring casa por acidente (um nome contido em outro) e depende de o JSON nao escapar
    caracteres — funciona so porque `safe_filename` reduz tudo a ASCII. Conferido em
    2026-08-01: as duas formas preservam os MESMOS 12 objetos, entao a troca e exata, e esta
    diz o que quer dizer.
    """
    nomes = set()
    for e in erros:
        rp = e.get("raw_payload")
        if isinstance(rp, dict) and rp.get("source_file"):
            nomes.add(rp["source_file"])
    return nomes


def _baixar(nome: str) -> "bytes | None":
    """Bytes do objeto, ou None se nao der para baixar. NUNCA levanta.

    Quem chama decide o que fazer com o None — e a decisao correta aqui e PRESERVAR: nao
    conseguir ler o arquivo nao e prova de que ele e descartavel.
    """
    url = f"{BASE}/storage/v1/object/{BUCKET}/{urllib.parse.quote(nome, safe='')}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as r:
            return r.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        log.warning(f"  nao foi possivel baixar {nome}: {e}")
        return None


def _tem_chave_fiscal(nome: str) -> bool:
    """True se o PDF orfao carrega uma chave de acesso fiscal VALIDA.

    Fecha a lacuna estrutural da preservacao por `storage_key`: `fiscal_document.access_key` e
    UNIQUE, entao o SEGUNDO objeto que traz a mesma chave nao tem linha e cairia como orfao.

    Tres decisoes, todas na direcao de NAO apagar:
      - so PDF e inspecionado (imagem nao tem chave em texto; abri-la seria custo sem resposta);
      - falha ao baixar ou ao ler o texto → devolve True (preserva). O objetivo desta funcao e
        autorizar uma remocao IRREVERSIVEL: na duvida, ela nao autoriza;
      - a validacao e a canonica (`fiscal_key.extract_access_keys`, com as cinco camadas —
        UF, mes, ano, modelo e DV), nao um "44 digitos" ganancioso que preservaria qualquer
        boleto por acidente.
    """
    if not nome.lower().endswith(".pdf"):
        return False
    dados = _baixar(nome)
    if dados is None:
        return True
    try:
        with tempfile.TemporaryDirectory(prefix="purge_") as td:
            caminho = Path(td) / "orfao.pdf"
            caminho.write_bytes(dados)
            texto = _pdf_text(caminho)
    except OSError as e:
        log.warning(f"  nao foi possivel inspecionar {nome}: {e}")
        return True
    return bool(fiscal_key.extract_access_keys(texto))


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

    # TODA a leitura acontece ANTES de qualquer apagamento, e uma falha aqui ABORTA o run: e
    # melhor nao apagar nada do que apagar com um conjunto de "referenciados" incompleto — o
    # erro seria irreversivel e se reportaria como sucesso.
    try:
        objetos = _storage_list()
        anexos = {a["storage_key"] for a in _rest("financial_account_attachment?select=storage_key")}
        sources = {f["source_file"] for f in
                   _rest("financial_account_control?select=source_file&source_file=not.is.null")}
        # ONDA 3 — o PDF de onde saiu uma chave de acesso fiscal NAO e orfao, mesmo sem conta
        # nenhuma apontando para ele: CT-e/NF-e sem boleto e exatamente o documento que NUNCA
        # vira conta. Sem esta terceira fonte, a purga apagaria justamente o que a migration 107
        # registrou — irreversivelmente e reportando "orfaos removidos" com naturalidade.
        fiscais = {f["storage_key"] for f in
                   _rest("fiscal_document?select=storage_key&storage_key=not.is.null")}
        emails = _rest("email_control?select=message_id,sender_email,subject,status,received_at")
        erros = _rest("email_processing_errors?select=raw_payload")
    except RestError as e:
        log.error(f"Leitura incompleta — NADA foi apagado: {e}")
        return 1

    erros_files = _erro_source_files(erros)

    referenciados = anexos | sources | fiscais
    orfaos = [n for n in objetos if n not in referenciados]
    protegidos_pref = _protected_prefixes(emails)

    agora = datetime.now(timezone.utc)
    apagar, preservar = [], []
    for nome in orfaos:
        motivo = None
        if _escrito_ha_pouco(objetos.get(nome), agora):
            motivo = MOTIVO_RECENTE
        elif any(nome.startswith(p) for p in protegidos_pref):
            motivo = "e-mail em pendente/falha (pode virar conta)"
        elif nome in erros_files:
            motivo = "citado em email_processing_errors (extracao falhou)"
        (preservar.append((nome, motivo)) if motivo else apagar.append(nome))

    # Ultima barreira, e a unica que olha o CONTEUDO: entre os candidatos a remocao ainda ha
    # documento fiscal legitimo — o 2o objeto de uma chave ja registrada (a UNIQUE de
    # `access_key` guarda so o primeiro). Roda por ultimo, sobre o conjunto ja reduzido, porque
    # baixa e abre cada PDF; e sempre, inclusive no --dry-run, senao o relatorio prometeria
    # apagar o que a execucao real preservaria.
    if apagar:
        log.info(f"  inspecionando o conteudo de {len(apagar)} candidato(s)...")
        restantes = []
        for nome in apagar:
            (preservar.append((nome, "contem chave de acesso fiscal (documento fiscal)"))
             if _tem_chave_fiscal(nome) else restantes.append(nome))
        apagar = restantes

    log.info(f"objetos no bucket ..... {len(objetos)}")
    log.info(f"com linha (mantidos) .. {len(objetos) - len(orfaos)}")
    log.info(f"  dos quais fiscais ... {len(fiscais & set(objetos))} (chave de acesso registrada)")
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

    if not apagar:
        log.info("\nOK: nada a remover.")
        return 0

    # Sem rastro, nao apaga: a lista do que saiu e a unica memoria de uma remocao irreversivel.
    try:
        registro = _grava_registro(apagar, agora)
    except OSError as e:
        log.error(f"Nao foi possivel gravar o registro da purga — NADA foi apagado: {e}")
        return 1
    log.info(f"  registro do que sera removido: {registro}")

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
