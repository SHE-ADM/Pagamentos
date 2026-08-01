"""Registra em `fiscal_document` as chaves de acesso dos PDFs que JA estao no bucket.

Contexto (Onda 3 do roadmap): ate a migration 107 o documento fiscal era descartado por
inteiro — 172 DACTEs e 33 DANFEs baixados, zero dado estruturado. O gancho no reader passa a
capturar os NOVOS; este script recupera o que ainda existe no bucket.

ESCOPO DELIBERADO: so o que esta no bucket. A purga de 15/07/2026 ja levou 67% dos PDFs de
CT-e, e os que faltam so existem no IMAP — recupera-los e a ONDA 4 (varredura historica), que
tem protocolo proprio. Antecipar isso aqui misturaria as duas.

VARRE TODOS OS OBJETOS, nao so os de nome "CT-e"/"DANFE": o parser e deterministico, valida
UF + mes + modelo + DV e nao custa chamada de API nenhuma, entao filtrar por nome so
introduziria falso negativo. Um PDF sem chave simplesmente nao produz linha.

IDEMPOTENTE: a UNIQUE de `access_key` + `resolution=ignore-duplicates` fazem a reexecucao ser
inofensiva. NAO apaga nem altera nada — a tabela e append-only.

Uso:
    py -3 scripts/backfill_fiscal_documents.py --dry-run          # so relata
    py -3 scripts/backfill_fiscal_documents.py                    # grava
    py -3 scripts/backfill_fiscal_documents.py --limit 20         # amostra (diagnostico)
"""

import argparse
import io
import logging
import os
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
load_dotenv(ROOT / ".env")

import fiscal_key  # noqa: E402
from read_emails import safe_filename  # noqa: E402
from supabase_rest import RestError, rest_get, rest_write, storage_list  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("backfill-fiscal")

BASE = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_KEY")
BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "attachments")
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def _rest(path: str, order: str = "id"):
    """GET no PostgREST, PAGINADO — delega a `supabase_rest.rest_get` (fonte unica).

    NAO reintroduzir um `urlopen` local. O Supabase corta a resposta em "Max rows" (1000) e
    responde HTTP 200 — sem erro e sem sinal. Foi exatamente isto que corrompeu o primeiro
    backfill: `email_control` tem 1158 linhas, a chamada crua devolvia 1000, e os documentos
    cujo PDF veio dos 158 e-mails invisiveis foram gravados com `sender_email`,
    `gmail_message_id` e `received_at` NULL — 68 de 172 linhas (40%). Como a tool
    `analytics.documentos_fiscais` filtra por `received_at` e `NULL >= data` e NULL, essas
    linhas somem de QUALQUER consulta com recorte de data.
    """
    return rest_get(BASE, HEADERS, path, order)


def _storage_list() -> list[str]:
    """Objetos do bucket — delega ao modulo compartilhado (que ja pula placeholder de pasta)."""
    return storage_list(BASE, HEADERS, BUCKET)


def _storage_get(name: str) -> bytes:
    url = f"{BASE}/storage/v1/object/{BUCKET}/{urllib.parse.quote(name)}"
    req = urllib.request.Request(url, headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def _pdf_text(data: bytes) -> str:
    """Texto do PDF a partir dos BYTES — best-effort (imagem/cifrado devolvem "")."""
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            return "\n".join((p.extract_text() or "") for p in pdf.pages)
    except Exception as e:  # noqa: BLE001 — best-effort por design
        log.debug(f"  texto ilegivel: {e}")
        return ""


def _provenance_index(emails: list[dict]) -> dict:
    """Prefixo do nome do objeto -> LISTA de e-mails que produzem aquele prefixo.

    Reconstroi o `{sender_tag}_{subject_tag}_{YYYYMMDD}_` que `save_attachments` monta, com o
    `safe_filename` REAL — mesma tecnica do purge_orphan_attachments. E a unica ligacao entre
    o objeto (nome flat) e o e-mail, ja que o documento fiscal por definicao NAO tem conta.

    ⚠️ GUARDA A LISTA, NAO O PRIMEIRO. A versao anterior fazia `setdefault` e o comentario
    justificava: "prefixo repetido sao reenvios da mesma thread, proveniencia equivalente na
    pratica". **Medido em 2026-08-01: falso em 27% dos casos.** Dos 1015 prefixos, 82 colidem
    (143 e-mails); destes, 60 sao reenvio real (assunto identico) mas **22 tem assunto
    DIFERENTE** — o `safe_filename(subject, 30)` trunca em 30 chars e colapsa e-mails de
    fornecedores distintos:

        LE BIANCO - PAGAMENTO FORNECEDOR | ... (DOIS M) | ... (NYBC)

    Escolher "o primeiro" nesse caso atribui o documento ao e-mail errado em silencio. Guardar
    a lista deixa a ambiguidade VISIVEL para quem chama decidir (ver `_match_email`).

    O que a colisao NAO afeta: a DATA. O prefixo contem `YYYYMMDD`, entao todos os candidatos
    sao do mesmo dia — o filtro temporal da tool nunca erra por causa disto.
    """
    idx: dict = {}
    for e in emails:
        if not e.get("received_at"):
            continue
        date_tag = e["received_at"][:10].replace("-", "")
        sender_tag = safe_filename((e.get("sender_email") or "").split("@")[0], 20)
        subject_tag = safe_filename(e.get("subject") or "", 30)
        idx.setdefault(f"{sender_tag}_{subject_tag}_{date_tag}_", []).append(e)
    return idx


def _emissao_plausivel(email: dict, doc: dict) -> bool:
    """O e-mail poderia ter trazido ESTE documento? (oraculo independente do casamento)

    Compara o `AAMM` da chave de acesso — escrito pelo EMISSOR, nao pelo nosso codigo — com a
    data em que o e-mail chegou. Documento fiscal e enviado depois de emitido, e nao anos
    depois: a janela [0, 6] meses cobre reenvio e cobranca atrasada.

    Foi esta a verificacao que validou o reparo das 68 linhas em 2026-08-01 (172/172 coerentes)
    — mas ela existia so no console de quem rodou. Aqui ela vira garantia permanente: e a
    diferenca entre "conferi uma vez" e "nao passa se estiver errado".
    """
    aamm, quando = doc.get("issue_yearmonth"), email.get("received_at")
    if not (aamm and quando and len(aamm) == 4 and aamm.isdigit()):
        return True          # sem base para julgar: nao inventa rejeicao
    try:
        emissao = date(2000 + int(aamm[:2]), int(aamm[2:]), 1)
        receb = date.fromisoformat(quando[:10])
    except ValueError:
        return True
    meses = (receb.year - emissao.year) * 12 + (receb.month - emissao.month)
    return 0 <= meses <= 6


def _match_email(name: str, idx: dict, doc: "dict | None" = None) -> dict:
    """E-mail de origem do objeto `name`, ou `{}`.

    Com `doc`, a plausibilidade (`_emissao_plausivel`) DESEMPATA prefixo ambiguo e rejeita
    candidato incoerente — sem `doc`, mantem o comportamento historico de pegar o primeiro.
    Devolver `{}` e melhor que devolver um palpite: proveniencia errada e pior que ausente,
    porque parece correta.
    """
    for prefix, candidatos in idx.items():
        if not name.startswith(prefix):
            continue
        if doc is None:
            return candidatos[0]
        plausiveis = [e for e in candidatos if _emissao_plausivel(e, doc)]
        if len(plausiveis) == 1:
            return plausiveis[0]
        if not plausiveis:
            return {}                      # todos incoerentes: nao atribui
        # Ainda ambiguo (varios plausiveis): o mais proximo da emissao e o melhor palpite, e
        # todos sao do mesmo dia por construcao do prefixo.
        return min(plausiveis, key=lambda e: e.get("received_at") or "")
    return {}


def _insert(doc: dict, storage_key: str, email: dict) -> bool:
    payload = {
        "access_key":       doc["access_key"],
        "model":            doc["model"],
        "uf_code":          doc["uf_code"],
        "issue_yearmonth":  doc["issue_yearmonth"],
        "emitter_cnpj":     doc["emitter_cnpj"],
        "series":           doc["series"],
        "doc_number":       doc["doc_number"],
        "storage_key":      storage_key,
        "gmail_message_id": email.get("message_id"),
        "sender_email":     email.get("sender_email"),
        "subject":          email.get("subject"),
        "received_at":      email.get("received_at"),
    }
    ok, detalhe = rest_write(BASE, HEADERS, "fiscal_document?on_conflict=access_key",
                             payload, prefer="resolution=ignore-duplicates")
    if not ok:
        log.warning(f"  falha ao gravar {doc['access_key']}: {detalhe}")
    return ok


def _patch_provenance(row_id: int, email: dict) -> bool:
    """Preenche os 4 campos de proveniencia de UMA linha ja gravada.

    A tabela e append-only por CONTRATO, nao por trigger — e a migration 107 diz por que:
    bloquear UPDATE "impediria corrigir um backfill errado, sem impedir nada que hoje aconteca".
    E exatamente este caso. So os 4 campos de proveniencia sao tocados; identidade do documento
    (`access_key`, `model`, `emitter_cnpj`, `storage_key`...) nao entra no payload.
    """
    payload = {
        "gmail_message_id": email.get("message_id"),
        "sender_email":     email.get("sender_email"),
        "subject":          email.get("subject"),
        "received_at":      email.get("received_at"),
    }
    ok, detalhe = rest_write(BASE, HEADERS, f"fiscal_document?id=eq.{row_id}", payload,
                             method="PATCH", prefer="return=minimal")
    if not ok:
        log.warning(f"  falha ao corrigir id={row_id}: {detalhe}")
    return ok


def fix_provenance(dry_run: bool) -> int:
    """Preenche a proveniencia das linhas gravadas SEM ela (`--fix-provenance`).

    POR QUE ISTO EXISTE — e por que reexecutar o backfill NAO resolve:
    o `_rest` original nao paginava, entao `_provenance_index` foi montado com 1000 das 1158
    linhas de `email_control` e 68 dos 172 documentos nasceram com `sender_email`,
    `gmail_message_id`, `subject` e `received_at` NULL. Como `analytics.documentos_fiscais`
    filtra por `received_at` e `NULL >= data` e NULL, essas linhas somem de QUALQUER pergunta
    com recorte de data. E o dano nao se auto-corrige: `novo = chave not in ja_registradas`
    pula a chave existente, e o INSERT usa `ignore-duplicates`, que IGNORA em vez de atualizar.

    IDEMPOTENTE e conservador: so toca linha cujo `sender_email` esta NULL, e so quando o
    `storage_key` casa um e-mail. Linha sem casamento fica como esta e e relatada — preencher
    com palpite seria pior que deixar nulo.
    """
    idx = _provenance_index(
        _rest("email_control?select=message_id,sender_email,subject,received_at"))
    # `issue_yearmonth` NAO e enfeite: e o oraculo de `_emissao_plausivel`, que desempata
    # prefixo ambiguo e recusa casamento incoerente. Sem ele o reparo volta a ser "o primeiro
    # prefixo que casar".
    orfas = _rest("fiscal_document?select=id,access_key,storage_key,issue_yearmonth"
                  "&sender_email=is.null")

    log.info(f"linhas sem proveniencia .... {len(orfas)}")
    log.info(f"e-mails no indice .......... {len(idx)} prefixos")

    casadas, corrigidas, sem_match = [], 0, []
    for row in orfas:
        email = _match_email(row.get("storage_key") or "", idx, row)
        (casadas if email else sem_match).append((row, email))

    log.info(f"  com e-mail correspondente  {len(casadas)}")
    log.info(f"  SEM correspondencia ...... {len(sem_match)}")
    for row, _e in sem_match[:10]:
        log.info(f"    ? id={row['id']} {row.get('storage_key')}")

    if dry_run:
        for row, email in casadas[:10]:
            log.info(f"    + id={row['id']} <- {email.get('sender_email')} "
                     f"({email.get('received_at', '')[:10]})")
        if len(casadas) > 10:
            log.info(f"    ... e mais {len(casadas) - 10}")
        log.info("\n[dry-run] nada foi alterado.")
        return 0

    for row, email in casadas:
        if _patch_provenance(row["id"], email):
            corrigidas += 1
    log.info(f"CORRIGIDAS ................. {corrigidas}")
    return 0 if corrigidas == len(casadas) else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="so relata, sem gravar")
    ap.add_argument("--limit", type=int, default=0, help="processa no maximo N objetos")
    ap.add_argument("--fix-provenance", action="store_true",
                    help="NAO varre o bucket: so preenche a proveniencia das linhas ja gravadas "
                         "sem ela (ver fix_provenance)")
    args = ap.parse_args()

    if not BASE or not KEY:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY ausentes no .env")
        return 1

    # Modo de reparo: caminho proprio, sem baixar PDF nenhum. Fica ANTES do _storage_list para
    # nao pagar o download do bucket inteiro so para corrigir 4 colunas.
    if args.fix_provenance:
        return fix_provenance(args.dry_run)

    objetos = _storage_list()
    if args.limit:
        objetos = objetos[:args.limit]
    idx = _provenance_index(
        _rest("email_control?select=message_id,sender_email,subject,received_at"))
    ja_registradas = {f["access_key"].strip()
                      for f in _rest("fiscal_document?select=access_key")}

    log.info(f"objetos a inspecionar .. {len(objetos)}")
    log.info(f"chaves ja registradas .. {len(ja_registradas)}")

    achados, gravados, sem_texto, sem_chave = [], 0, 0, 0
    for i, nome in enumerate(objetos, 1):
        if i % 25 == 0:
            log.info(f"  ... {i}/{len(objetos)}")
        try:
            data = _storage_get(nome)
        except Exception as e:  # noqa: BLE001 — um objeto ilegivel nao para o backfill
            log.warning(f"  download falhou: {nome} ({e})")
            continue

        texto = _pdf_text(data)
        if not texto:
            sem_texto += 1
            continue

        chaves = fiscal_key.extract_access_keys(texto)
        if not chaves:
            sem_chave += 1
            continue

        for chave in chaves:
            doc = fiscal_key.parse_access_key(chave)
            # `doc` entra no casamento: quando o prefixo e ambiguo (82 dos 1015 colidem), a
            # plausibilidade da emissao desempata em vez de "o primeiro que casar".
            email = _match_email(nome, idx, doc)
            novo = chave not in ja_registradas
            achados.append((doc["model_name"], chave, nome, novo))
            if novo and not args.dry_run and _insert(doc, nome, email):
                ja_registradas.add(chave)
                gravados += 1

    novos = [a for a in achados if a[3]]
    log.info("")
    log.info(f"sem texto (imagem/cifrado) .. {sem_texto}")
    log.info(f"sem chave de acesso ......... {sem_chave}")
    log.info(f"chaves encontradas .......... {len(achados)}  ({len(novos)} novas)")
    por_modelo = {}
    for modelo, _c, _n, novo in achados:
        if novo:
            por_modelo[modelo] = por_modelo.get(modelo, 0) + 1
    for modelo, qtd in sorted(por_modelo.items()):
        log.info(f"  {modelo:>5} ....................... {qtd}")

    if args.dry_run:
        for modelo, chave, nome, _novo in novos[:10]:
            log.info(f"    + [{modelo}] {chave}  <- {nome}")
        if len(novos) > 10:
            log.info(f"    ... e mais {len(novos) - 10}")
        log.info("\n[dry-run] nada foi gravado.")
        return 0

    log.info(f"GRAVADOS .................... {gravados}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
