"""Varredura historica da caixa postal — Onda 4, passada UNICA e ESTRITAMENTE ADITIVA.

O QUE ESTE SCRIPT RECUPERA
    Parte do acervo nao esta mais no banco nem no bucket — so na caixa postal:
      - ~115 PDFs de CT-e apagados pela purga de 15/07 (antes de a Onda 3 existir);
      - 440 corpos de e-mail truncados em 500 chars (anteriores a Onda 2);
      - documentos fiscais de e-mails que nunca passaram pelo pipeline.

POR QUE UM SCRIPT NOVO (e nao `read_emails.py --all`)
    A dedup por `message_id` do reader PULA todo e-mail ja registrado — exatamente o conjunto
    que se quer reprocessar. O `reprocess_message.py` ignora a dedup, mas opera um Message-ID
    por vez.

INVARIANTES (o que este script NUNCA faz — cada um e imposto por ESTRUTURA, nao por disciplina)
    1. NUNCA grava conta a pagar. O nome da tabela financeira nao aparece no codigo, e nenhuma
       funcao do pipeline de extracao (`extract_and_store_accounts`, `register_financial`,
       `try_extract_from_body`, `run_extraction`) e importada. Conta duplicada em massa e o pior
       desfecho possivel num sistema de pagamentos.
    2. NUNCA marca \\Seen. A caixa e operada por PESSOAS. Tres travas independentes: a caixa e
       reaberta em EXAMINE (`readonly=True`, em que o servidor nao PODE gravar flag permanente),
       todo FETCH usa `BODY.PEEK[]`, e nao ha `STORE`/`+FLAGS` no arquivo. A trava 1 sozinha ja
       bastaria; as outras existem porque `process_message` do reader usa `(INTERNALDATE RFC822)`
       — sem PEEK — e copiar aquela linha por engano seria facil demais.
    3. NUNCA sobrescreve. `body_full` so quando NULO (filtro na URL, nao no cliente),
       `fiscal_document` so INSERT idempotente, objeto do bucket so quando ainda nao existe.
    4. NUNCA escreve em `data/pdfs_inbox`. Esse diretorio e territorio proibido: o
       `retry_extraction.py` resolve PDFs PELO NOME la dentro, a partir do banco — um arquivo
       nosso cujo nome casasse um `source_file` pendente seria extraido por ele e VIRARIA CONTA,
       furando o invariante 1 pela porta dos fundos.
    5. Idempotente e retomavel: rodar duas vezes nao duplica nada.

O QUE ELE INEVITAVELMENTE ALTERA (declarado para nao parecer defeito numa revisao futura)
    `email_control.updated_at` das linhas que recebem `body_full` — a trigger `trg_ec_updated_at`
    carimba em qualquer UPDATE. E coluna de auditoria; nao ha como preencher o corpo sem toca-la.

DECISOES DE ESCOPO (tomadas em 2026-08-03, nao reabrir sem pedido)
    - E-mail fora de `email_control` NAO ganha linha nova: so o documento fiscal e registrado
      (`fiscal_document` guarda a propria proveniencia e nao tem FK).
    - Corpo dos e-mails SEM keyword nao e gravado (mantem a opcao A do item 2.3 do roadmap): o
      custo de FETCH deixou de valer aqui, mas o argumento de PII permanece — comunicacao
      interna nao-financeira ficaria indexada e pesquisavel pelo chat de IA.
    - PDF sem chave de acesso NAO sobe ao bucket: sem linha em `fiscal_document` a proxima
      `purge_orphan_attachments` o apagaria como orfao. `--upload-all` para quem aceitar isso.
    - So a pasta de IMAP_MAILBOX (INBOX). O `--dry-run` LISTA as demais pastas com a contagem de
      cada uma, para medir o que existe fora dela.

NAO EXIGE DEPLOY: vive em `scripts/`, que o `check_deploy_parity` nao varre.

Uso:
    py -3 scripts\\varredura_historica.py --dry-run                     # dimensiona (barato)
    py -3 scripts\\varredura_historica.py --dry-run --deep --limit 200  # taxa real de chaves
    py -3 scripts\\varredura_historica.py --limit 50                    # primeira passada real
    py -3 scripts\\varredura_historica.py                               # passada completa
"""

import argparse
import email
import hashlib
import imaplib
import json
import logging
import os
import re
import sys
import tempfile
import time
from datetime import date, datetime, timezone
from email.utils import parseaddr
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
load_dotenv(ROOT / ".env")

import fiscal_key  # noqa: E402
import read_emails as R  # noqa: E402
from supabase_rest import (  # noqa: E402
    RestError,
    rest_get,
    rest_write,
    storage_list,
    storage_upload,
)

logging.basicConfig(level=logging.INFO, format="%(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("varredura")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001 — console legado; nao vale derrubar o run por isto
    pass

BASE = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_KEY")
BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "attachments")
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

MAILBOX = os.getenv("IMAP_MAILBOX", "INBOX")
CRITERIO = "ALL"

CHECKPOINT_PATH = ROOT / "data" / "varredura_checkpoint.json"
CHECKPOINT_VERSAO = 1
QUARENTENA_DIR = ROOT / "data" / "varredura_pdfs"

# Teto por mensagem. O `RFC822.SIZE` e conhecido ANTES do fetch, entao a mensagem gigante e
# pulada sem custo — e REPORTADA, nunca em silencio.
MAX_MESSAGE_BYTES_DEFAULT = 25 * 1024 * 1024

# Tentativas de re-FETCH da MESMA mensagem apos queda transitoria. `_connect_and_search` do
# reader cobre apenas o search INICIAL — nenhum dos N mil FETCH de uma varredura esta protegido
# por ele, e a queda no meio e o modo de falha esperado aqui.
FETCH_MAX_ATTEMPTS = 3


# ---------------------------------------------------------------------------------------------
# Wrappers finos sobre o modulo compartilhado.
# Existem porque ha teste-guarda que PROIBE `urlopen` dentro de `_rest`: a paginacao precisa vir
# da fonte unica (o Supabase corta em 1000 linhas devolvendo HTTP 200, sem sinal de erro).
# ---------------------------------------------------------------------------------------------
def _rest(path: str, order: str = "id") -> list:
    return rest_get(BASE, HEADERS, path, order)


def _storage_list(com_metadata: bool = False):
    return storage_list(BASE, HEADERS, BUCKET, com_metadata)


# =============================================================================================
# FUNCOES PURAS — sem rede, sem IMAP, sem disco. Sao elas que os testes cobrem de verdade.
# =============================================================================================

def _document_parts(msg) -> list:
    """Anexos que sao DOCUMENTO: PDF, .docx, ou imagem com `Content-Disposition: attachment`.

    Delega a decisao a `read_emails.attachment_kind`/`attachment_ext` — a FONTE UNICA da regra.
    Antes, o criterio era reimplementado aqui (e num terceiro lugar, o `reprocess_message`), e as
    copias so podiam concordar por disciplina; a guarda cross-layer de `test_varredura_historica`
    existe justamente porque divergir significa subir ao bucket o que o pipeline nunca
    consideraria documento, ou perder o documento que a varredura existe para recuperar.
    Imagem INLINE fica de fora: e logo/assinatura, nao documento.

    Devolve dicts `{filename, ext, content_type, payload}` — bytes em memoria, nunca disco.
    """
    achados = []
    for part in msg.walk():
        cd = str(part.get("Content-Disposition", ""))
        ct = part.get_content_type()
        fname = R.decode_str(part.get_filename() or "")
        fl = fname.lower()
        kind = R.attachment_kind(ct, fl, cd)
        if kind is None:
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        ext = R.attachment_ext(kind, ct, fl)
        achados.append({
            "filename": fname,
            "ext": ext,
            # O content-type do upload sai do MESMO mapa que o pipeline usa, em vez do que o
            # remetente declarou: e o que mantem o objeto no bucket coerente com o que o
            # `register_attachment` grava em `financial_account_attachment.mime_type`.
            "content_type": R._UPLOAD_CONTENT_TYPES.get(
                ext, ct or "application/octet-stream"),
            "payload": payload,
        })
    return achados


def storage_key_for(sender_email: str, subject: str, received_at: str, filename: str,
                    ext: str, payload: bytes, objetos: dict) -> tuple:
    """Chave do objeto no bucket. Devolve `(chave, precisa_subir)`. PURA e DETERMINISTICA.

    A base e IDENTICA a que o reader produz (`{remetente20}_{assunto30}_{AAAAMMDD}_{arquivo20}`),
    preservando o prefixo que `purge_orphan_attachments` e o `_provenance_index` do backfill
    sabem ler — e fazendo com que um anexo ja processado pelo reader receba exatamente a chave
    que ele usou, coerente com `financial_account_attachment`.

    COLISAO DE NOME: o reader resolve contra o DISCO (`_unique_inbox_path`), o que aqui nao serve
    — o que importa e o BUCKET. E o HTTP 409 do upload tampouco resolve: ele diz "ja existe uma
    chave assim", nunca "e o mesmo arquivo". Entao:
      - nome livre                      -> sobe com a base;
      - nome ocupado, TAMANHO IGUAL     -> e o mesmo anexo, ja esta la: reusa e NAO sobe;
      - nome ocupado, tamanho diferente -> sufixo `_{sha1[:8]}` do conteudo.
    O sufixo vem do CONTEUDO (nao de um contador), entao retomar apos uma queda gera a MESMA
    chave — e dois anexos distintos nunca colidem.
    """
    date_tag = (received_at or "")[:10].replace("-", "")
    sender_tag = R.safe_filename((sender_email or "").split("@")[0], 20)
    subject_tag = R.safe_filename(subject or "", 30)
    orig = R.safe_filename(Path(filename).stem, 20) if filename else "anexo"
    stem = f"{sender_tag}_{subject_tag}_{date_tag}_{orig}"

    def _mesmo_conteudo(chave: str) -> bool:
        try:
            return int((objetos.get(chave) or {}).get("size", -1)) == len(payload)
        except (TypeError, ValueError):
            return False

    base = f"{stem}{ext}"
    if base not in objetos:
        return base, True
    if _mesmo_conteudo(base):
        return base, False

    alternativa = f"{stem}_{hashlib.sha1(payload).hexdigest()[:8]}{ext}"
    if alternativa in objetos and _mesmo_conteudo(alternativa):
        return alternativa, False
    return alternativa, True


def _message_identity(msg, uid, meta) -> dict:
    """Identidade da mensagem: o que casa `email_control` e o que vai para a proveniencia.

    `message_id` e o REAL (None quando o e-mail nao tem header Message-ID) — e o que vai para
    `fiscal_document.gmail_message_id`. Preencher com palpite seria pior que deixar nulo.
    `chave_indice` e o que casa uma linha de `email_control`: ali o reader grava a forma
    sintetica `no-id-{uid}` quando falta o header, e como e a mesma caixa e o mesmo UIDVALIDITY,
    o valor bate.
    """
    uid_str = uid.decode() if isinstance(uid, (bytes, bytearray)) else str(uid)
    bruto = msg.get("Message-ID")
    message_id = bruto.strip() if bruto else None
    _, sender_email = parseaddr(msg.get("From", ""))
    return {
        "message_id": message_id,
        "chave_indice": message_id or f"no-id-{uid_str}",
        "sender_email": sender_email,
        "subject": R.decode_str(msg.get("Subject", "(sem assunto)")),
        "received_at": R._received_at_from(meta, msg.get("Date", "")),
    }


def _fiscal_payload(doc: dict, storage_key: str, ctx: dict) -> dict:
    """Linha de `fiscal_document`. Espelha as colunas da migration 107 e o payload que o
    `SupabaseControl.register_fiscal_document` do reader monta — as duas origens tem de gravar
    exatamente o mesmo formato, senao a tool `documentos_fiscais` ve dois acervos diferentes."""
    return {
        "access_key": doc["access_key"],
        "model": doc["model"],
        "uf_code": doc["uf_code"],
        "issue_yearmonth": doc["issue_yearmonth"],
        "emitter_cnpj": doc["emitter_cnpj"],
        "series": doc["series"],
        "doc_number": doc["doc_number"],
        "storage_key": storage_key,
        "gmail_message_id": ctx.get("message_id"),
        "sender_email": ctx.get("sender_email"),
        "subject": ctx.get("subject"),
        "received_at": ctx.get("received_at"),
    }


def _checkpoint_compativel(salvo: dict, atual: dict):
    """Motivo pelo qual o checkpoint NAO pode ser retomado, ou None quando pode.

    O UID do IMAP so e estavel dentro do par `(mailbox, UIDVALIDITY)`. Se a caixa for recriada
    ou migrada, o servidor incrementa o UIDVALIDITY e os UIDs antigos passam a designar OUTRAS
    mensagens: retomar com o checkpoint velho pularia mensagens nunca processadas e processaria
    as erradas — em silencio, que e o pior desfecho. `imap_user` esta aqui para o caso trivial e
    real de rodar apontando para outra conta com o checkpoint da anterior no disco.
    """
    if not salvo:
        return None
    if salvo.get("versao") != CHECKPOINT_VERSAO:
        return f"versao {salvo.get('versao')} != {CHECKPOINT_VERSAO}"
    for campo in ("imap_user", "mailbox", "uidvalidity", "criterio"):
        if str(salvo.get(campo)) != str(atual.get(campo)):
            return f"{campo}: checkpoint={salvo.get(campo)!r} agora={atual.get(campo)!r}"
    return None


def _uids_pendentes(uids: list, concluidos) -> list:
    """UIDs ainda por processar, na ordem ascendente da caixa.

    Os `falhados` NAO entram em `concluidos`, entao voltam para a fila sozinhos — um UID so e
    dado por concluido quando todas as sub-etapas daquela mensagem terminaram sem erro.
    """
    feitos = {str(u) for u in (concluidos or ())}
    return [u for u in uids if _uid_str(u) not in feitos]


def _uid_str(uid) -> str:
    return uid.decode() if isinstance(uid, (bytes, bytearray)) else str(uid)


def _ref_date(received_at: str):
    """Data de referencia para validar a chave de acesso: a do E-MAIL, nao a de hoje.

    `parse_access_key` recusa chave cujo ano passe de `ref.year + 1`. Num acervo historico o
    "hoje" seria a referencia errada: fixar a data da mensagem faz a janela acompanhar a epoca
    do documento, e uma chave "do futuro" para aquele e-mail continua sendo recusada. Recebe o
    ISO de `received_at`; `None` quando ilegivel (o parser cai no default de hoje).
    """
    try:
        return date.fromisoformat((received_at or "")[:10])
    except ValueError:
        return None


def _fmt_bytes(n: int) -> str:
    for unidade in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unidade == "TB":
            return f"{n:.1f} {unidade}" if unidade != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} TB"


# =============================================================================================
# CHECKPOINT — estado local, gravado de forma atomica
# =============================================================================================

def _sem_quebra(texto, limite: int = 200) -> str:
    """Texto de UMA linha, truncado — para tudo que vem de fora e vai ao log.

    Sem isto, um valor com `\\r\\n` forja linhas inteiras no log (log injection): quem lesse o
    arquivo veria um "ERRO" que ninguem emitiu. Vale para o checkpoint (arquivo local editavel) e
    para qualquer dado derivado do e-mail.
    """
    limpo = " ".join(str(texto).split())
    return limpo[:limite] + ("…" if len(limpo) > limite else "")


def _saneia_checkpoint(bruto) -> dict:
    """Normaliza o checkpoint LIDO DO DISCO ao formato esperado.

    O arquivo e entrada EXTERNA — editavel a mao, corrompivel por queda, e seus valores decidem
    o que a varredura pula e o que vai para o log. Consumi-lo cru significa confiar em tipo,
    tamanho e conteudo de algo que ninguem validou: `concluidos` como string faria o `set()`
    virar um conjunto de CARACTERES (pulando UIDs por acaso), e um campo com `\\r\\n` forja linha
    no log.

    Tudo o que sobrevive aqui e string de uma linha, truncada, ou lista/dict de strings assim.
    """
    if not isinstance(bruto, dict):
        return {}
    salvo = {campo: _sem_quebra(bruto.get(campo)) for campo in
             ("imap_user", "mailbox", "uidvalidity", "criterio") if bruto.get(campo) is not None}
    if isinstance(bruto.get("versao"), int):
        salvo["versao"] = bruto["versao"]
    concluidos = bruto.get("concluidos")
    # `isinstance(str)` explicito: string tambem e iteravel, e `set("12")` daria {'1','2'}.
    salvo["concluidos"] = ([_sem_quebra(u, 40) for u in concluidos]
                           if isinstance(concluidos, (list, tuple, set)) else [])
    falhados = bruto.get("falhados")
    salvo["falhados"] = ({_sem_quebra(k, 40): _sem_quebra(v) for k, v in falhados.items()}
                         if isinstance(falhados, dict) else {})
    return salvo


def _carrega_checkpoint(path: Path) -> dict:
    try:
        return _saneia_checkpoint(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError, ValueError) as e:
        log.warning(f"checkpoint ilegivel ({_sem_quebra(e)}) — comecando do zero")
        return {}


def _salva_checkpoint(path: Path, estado: dict) -> None:
    """Grava `.tmp` e faz `os.replace` — ATOMICO tambem no Windows.

    Sem isso, um Ctrl+C no meio do `json.dump` deixa um JSON truncado e o run seguinte perde o
    progresso INTEIRO, que e justamente o que o checkpoint existe para evitar.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(estado, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as e:
        log.warning(f"nao foi possivel gravar o checkpoint: {_sem_quebra(e)}")


# =============================================================================================
# IMAP — a unica camada que fala com a caixa postal
# =============================================================================================

class CaixaMudou(RuntimeError):
    """A caixa deixou de ser a mesma no meio da passada (UIDVALIDITY diferente).

    Tem tipo PROPRIO porque precisa atravessar o `except Exception` do laco, que existe para
    isolar uma mensagem ruim. Uma `RuntimeError` generica ali seria tratada como "falha desta
    mensagem" e a varredura seguiria para o UID seguinte — que agora designa OUTRA mensagem —,
    imprimindo "Abortando" a cada volta sem nunca abortar.
    """


class Caixa:
    """Sessao IMAP em modo SOMENTE LEITURA, com re-FETCH resiliente.

    `abrir()` reusa `_connect_and_search` do reader (timeout de socket + retry/backoff no
    connect/select/search) e entao REABRE a caixa em EXAMINE. O reader seleciona em read-write
    porque precisa marcar \\Seen; aqui isso e proibido, e o EXAMINE torna a garantia estrutural:
    em read-only o servidor nao PODE gravar flag permanente, nem diante de um FETCH sem PEEK.
    """

    def __init__(self, criterio: str = CRITERIO, mailbox: str = MAILBOX):
        self.criterio = criterio
        self.mailbox = mailbox
        self.mail = None
        self.uidvalidity = None

    def abrir(self) -> list:
        self.mail, uids = R._connect_and_search(self.criterio)
        self._examine()
        return uids

    def _examine(self) -> None:
        self.mail.select(self.mailbox, readonly=True)
        resp = self.mail.response("UIDVALIDITY")[1]
        bruto = resp[0] if resp else None
        if isinstance(bruto, (bytes, bytearray)):
            bruto = bruto.decode(errors="replace")
        achado = re.search(r"\d+", bruto or "")
        self.uidvalidity = achado.group(0) if achado else None

    def _reconectar(self) -> None:
        anterior = self.uidvalidity
        R._safe_logout(self.mail)
        self.mail, _ = R._connect_and_search(self.criterio)
        self._examine()
        if anterior and self.uidvalidity != anterior:
            raise CaixaMudou(
                f"UIDVALIDITY mudou no meio da varredura ({anterior} -> {self.uidvalidity}): "
                "os UIDs designam outras mensagens agora. Abortando."
            )

    def tamanho(self, uid) -> int:
        """Bytes da mensagem, SEM baixa-la (`RFC822.SIZE`).

        Sem reconexao de proposito, ao contrario de `mensagem()`: e um fetch minusculo, e uma
        queda aqui manda o uid para `falhados`, que volta para a fila na proxima execucao.
        """
        _, data = self.mail.uid("fetch", uid, "(RFC822.SIZE)")
        for item in data or []:
            texto = item if isinstance(item, (bytes, bytearray)) else (item or [b""])[0]
            achado = re.search(rb"RFC822\.SIZE\s+(\d+)", texto or b"")
            if achado:
                return int(achado.group(1))
        return 0

    def previa(self, uid) -> tuple:
        """(meta, raw, tamanho) so dos headers — um unico FETCH, para o dry-run raso.

        Junta `RFC822.SIZE` ao fetch de cabecalho de proposito: pedir os dois em chamadas
        separadas dobraria as idas ao servidor numa caixa de milhares de mensagens, sem ganho.
        """
        _, data = self.mail.uid(
            "fetch", uid,
            "(INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT MESSAGE-ID FROM DATE)])")
        meta, raw = R._rfc822_from_fetch(data)
        achado = re.search(rb"RFC822\.SIZE\s+(\d+)", meta or b"")
        return meta, raw, int(achado.group(1)) if achado else 0

    def mensagem(self, uid) -> tuple:
        """(meta, raw) da mensagem INTEIRA, com PEEK e com reconexao em falha transitoria."""
        ultimo = None
        for tentativa in range(1, FETCH_MAX_ATTEMPTS + 1):
            try:
                _, data = self.mail.uid("fetch", uid, "(INTERNALDATE BODY.PEEK[])")
                return R._rfc822_from_fetch(data)
            except R._IMAP_TRANSIENT as e:
                ultimo = e
                log.warning(f"  fetch do uid {_uid_str(uid)} falhou "
                            f"({tentativa}/{FETCH_MAX_ATTEMPTS}): {e} — reconectando")
                self._reconectar()
        raise RuntimeError(f"uid {_uid_str(uid)}: fetch falhou apos "
                           f"{FETCH_MAX_ATTEMPTS} tentativas ({ultimo})")

    def pastas(self) -> list:
        """(nome, quantidade) de cada pasta da conta. So para MEDIR o que ha fora da INBOX."""
        achados = []
        try:
            _, linhas = self.mail.list()
        except Exception as e:  # noqa: BLE001 — inventario informativo; nao derruba o run
            log.warning(f"nao foi possivel listar as pastas: {_sem_quebra(e)}")
            return achados
        for linha in linhas or []:
            texto = linha.decode(errors="replace") if isinstance(linha, bytes) else str(linha)
            # O nome vem por ultimo na resposta do LIST, entre aspas quando tem espaco
            # ("INBOX.Enviados" ou "Itens Enviados"). Cortar por espaco perderia o segundo caso.
            achado = re.search(r'"([^"]*)"\s*$', texto)
            nome = achado.group(1) if achado else texto.split(" ")[-1].strip()
            if not nome:
                continue
            try:
                _, dados = self.mail.select(nome, readonly=True)
                achados.append((nome, int((dados or [b"0"])[0] or 0)))
            except Exception:  # noqa: BLE001 — pasta inacessivel nao invalida o inventario
                achados.append((nome, -1))
        self._examine()  # volta para a caixa da varredura
        return achados

    def fechar(self) -> None:
        R._safe_logout(self.mail)


# =============================================================================================
# ESCRITAS — as UNICAS tres funcoes deste script que alteram algo
# =============================================================================================

def _patch_body_full(ec_id: int, body_text: str) -> str:
    """Preenche `body_full` SO quando a coluna esta NULA. Devolve gravado|ja_tinha|vazio|erro.

    O filtro `body_full=is.null` vai NA URL, nao num `if` do cliente: assim a condicao e avaliada
    pelo servidor no mesmo comando do UPDATE — atomico, sem read-modify-write, e imune a corrida
    com o reader agendado, que pode preencher a mesma linha entre o inventario e este PATCH.

    O teto do corpo vem de `R._body_full_for_storage` — FONTE UNICA, coerente com o
    `left(..., 100000)` da coluna gerada `body_search` (migration 105). Reimplementar o corte
    aqui criaria uma segunda regra que pode divergir e estourar o limite de 1 MB do tsvector,
    derrubando a gravacao da linha inteira.
    """
    corpo = R._body_full_for_storage(body_text)
    if not corpo:
        return "vazio"
    ok, resposta = rest_write(
        BASE, HEADERS, f"email_control?id=eq.{ec_id}&body_full=is.null",
        {"body_full": corpo}, method="PATCH", prefer="return=representation")
    if not ok:
        log.warning(f"    body_full (id {ec_id}): {_sem_quebra(resposta)}")
        return "erro"
    return "gravado" if resposta else "ja_tinha"


def _upload_object(chave: str, dados: bytes, content_type: str) -> str:
    """Sobe o anexo ao bucket SEM sobrescrever. Devolve subiu|ja_existe|erro."""
    estado, detalhe = storage_upload(BASE, HEADERS, BUCKET, chave, dados, content_type)
    if estado == "erro":
        log.warning(f"    upload {_sem_quebra(chave)}: {_sem_quebra(detalhe)}")
    return estado


def _registrar_fiscal(doc: dict, storage_key: str, ctx: dict) -> str:
    """INSERT idempotente em `fiscal_document`. Devolve inserido|duplicado|erro.

    Nao reusa `SupabaseControl.register_fiscal_document` porque ele confunde DUPLICATA com FALHA
    (ambas viram `False`), e aqui os tres desfechos precisam ser distinguiveis: e o que decide se
    o UID pode ser dado por concluido no checkpoint, e o que impede o relatorio de mentir.
    `return=representation` e o que permite a distincao — com `return=minimal` o PostgREST
    responde 201 mesmo sem inserir.
    """
    ok, resposta = rest_write(
        BASE, HEADERS, "fiscal_document?on_conflict=access_key",
        _fiscal_payload(doc, storage_key, ctx), method="POST",
        prefer="resolution=ignore-duplicates,return=representation")
    if not ok:
        log.warning(f"    fiscal {_sem_quebra(doc.get('access_key'))}: {_sem_quebra(resposta)}")
        return "erro"
    return "inserido" if resposta else "duplicado"


# =============================================================================================
# PDF -> texto
# =============================================================================================

def _texto_do_pdf(payload: bytes) -> str:
    """Texto do PDF a partir dos BYTES, via arquivo temporario descartado em seguida.

    O `pdfplumber` precisa de um caminho, mas o arquivo NAO pode ir para `data/pdfs_inbox` (ver
    invariante 4 no topo). O bucket e a copia duravel — este disco e so passagem.

    Best-effort em camadas: pdfplumber direto (que ja le PDF cifrado so com senha de DONO, caso
    SB Credito) e, se vier vazio, uma tentativa de decrypt com os candidatos de senha do CNPJ da
    empresa (caso OBER). PDF que nao entrega texto simplesmente nao produz chave — nunca derruba
    a mensagem.
    """
    with tempfile.TemporaryDirectory(prefix="varredura_") as td:
        caminho = Path(td) / "anexo.pdf"
        caminho.write_bytes(payload)
        texto = R._pdf_text(caminho)
        if texto.strip():
            return texto
        return _texto_apos_decrypt(caminho)


def _texto_apos_decrypt(caminho: Path) -> str:
    """Texto do PDF cifrado, apagando a copia aberta em seguida.

    `extract_pdf._decrypt_pdf` grava a versao DESCRIPTOGRAFADA via `tempfile.mkstemp` e devolve o
    Path — sem apagar. No reader isso e um arquivo por e-mail novo; numa varredura da caixa
    inteira seria um boleto LEGIVEL por anexo cifrado acumulado no diretorio temporario do
    usuario. O `finally` fecha esse vazamento.
    """
    aberto = None
    try:
        import extract_pdf as E

        candidatas = R.pdf_password_candidates(_company_cnpj())
        aberto = E._decrypt_pdf(caminho, candidatas)
        return R._pdf_text(aberto) if aberto else ""
    except Exception as e:  # noqa: BLE001 — decrypt e bonus; a mensagem segue sem ele
        log.debug(f"decrypt falhou: {e}")
        return ""
    finally:
        if aberto:
            try:
                Path(aberto).unlink(missing_ok=True)
            except OSError as e:
                log.debug(f"nao foi possivel apagar o temporario do decrypt: {e}")


_CNPJ_CACHE = {}


def _company_cnpj() -> str:
    if "valor" not in _CNPJ_CACHE:
        try:
            linhas = _rest("company?select=cnpj&sk_company=eq.1", order="sk_company")
            _CNPJ_CACHE["valor"] = re.sub(r"\D", "", (linhas[0].get("cnpj") or "")) if linhas else ""
        except RestError:
            _CNPJ_CACHE["valor"] = ""
    return _CNPJ_CACHE["valor"]


# =============================================================================================
# PROCESSAMENTO DE UMA MENSAGEM — recebe os bytes JA baixados; nao conhece IMAP
# =============================================================================================

def _processar_mensagem(estado: dict, uid, raw: bytes, meta) -> bool:
    """Processa uma mensagem. Devolve True quando pode ser marcada como concluida.

    `estado` carrega o inventario (`corpo_pendente`, `objetos`, `chaves_fiscais`), as opcoes e o
    `tally`. Recebe `raw` para que o fluxo inteiro seja testavel com uma mensagem sintetica, sem
    servidor IMAP nenhum.
    """
    tally = estado["tally"]
    msg = email.message_from_bytes(raw)
    ctx = _message_identity(msg, uid, meta)
    sem_falha = True

    # --- CORPO --------------------------------------------------------------------------
    ec_id = estado["corpo_pendente"].get(ctx["chave_indice"])
    if ec_id:
        corpo = R.get_body_text(msg) or R._html_to_text(R.get_body_html(msg))
        if estado["dry_run"]:
            tally["corpo_a_gravar"] += 1
        else:
            desfecho = _patch_body_full(ec_id, corpo)
            tally[f"corpo_{desfecho}"] += 1
            sem_falha = sem_falha and desfecho != "erro"
            if desfecho in ("gravado", "ja_tinha"):
                estado["corpo_pendente"].pop(ctx["chave_indice"], None)
    elif ctx["chave_indice"] not in estado["registrados"]:
        tally["fora_do_email_control"] += 1

    # --- ANEXOS -------------------------------------------------------------------------
    ref = _ref_date(ctx["received_at"])
    for anexo in _document_parts(msg):
        tally["anexos"] += 1
        texto = _texto_do_pdf(anexo["payload"]) if anexo["ext"] == ".pdf" else ""
        if not texto.strip():
            tally["sem_texto"] += 1
        docs = [d for d in (fiscal_key.parse_access_key(c, ref)
                            for c in fiscal_key.extract_access_keys(texto, ref)) if d]
        novos = [d for d in docs if d["access_key"] not in estado["chaves_fiscais"]]
        if docs:
            tally["com_chave"] += 1
        if not docs and not estado["upload_all"]:
            # Sem chave nao ha linha em `fiscal_document`, e a proxima purga apagaria o objeto
            # como orfao: subir seria pagar banda por algo destinado a ser deletado.
            tally["sem_chave"] += 1
            continue

        chave_obj, precisa_subir = storage_key_for(
            ctx["sender_email"], ctx["subject"], ctx["received_at"],
            anexo["filename"], anexo["ext"], anexo["payload"], estado["objetos"])

        if estado["dry_run"]:
            tally["objetos_a_subir"] += int(precisa_subir)
            tally["fiscal_a_inserir"] += len(novos)
            for d in novos[:1]:
                estado["amostra"].append((d["model_name"], d["access_key"], chave_obj))
            continue

        if precisa_subir:
            desfecho = _upload_object(chave_obj, anexo["payload"], anexo["content_type"])
            tally[f"objeto_{desfecho}"] += 1
            if desfecho == "erro":
                _quarentena(chave_obj, anexo["payload"])
                sem_falha = False
                continue
            estado["objetos"][chave_obj] = {"size": len(anexo["payload"])}
        else:
            tally["objeto_ja_existe"] += 1

        # Ordem upload -> registro, NUNCA o inverso: registro sem objeto e inofensivo (a purga
        # so LE `storage_key`), mas objeto sem registro vira orfao e a purga o apaga.
        for doc in docs:
            desfecho = _registrar_fiscal(doc, chave_obj, ctx)
            tally[f"fiscal_{desfecho}"] += 1
            if desfecho == "inserido":
                estado["chaves_fiscais"].add(doc["access_key"])
                log.info(f"    + [{doc['model_name']}] {doc['access_key']}  <- {chave_obj}")
            elif desfecho == "erro":
                sem_falha = False

    return sem_falha


def _dentro_de(base: Path, alvo: Path) -> bool:
    """True se `alvo` resolvido fica DENTRO de `base` — contencao contra path traversal.

    Espelha o `_is_within_inbox` do reader. `safe_filename` ja remove `..` e separadores, entao
    isto e defesa em profundidade: a chave nasce de assunto e remetente de e-mail, e escrever
    fora do diretorio previsto seria uma escrita arbitraria comandada por quem envia a mensagem.
    """
    try:
        return alvo.resolve() != base.resolve() and base.resolve() in alvo.resolve().parents
    except OSError:
        return False


def _quarentena(chave: str, dados: bytes) -> None:
    """Guarda em disco o PDF cujo upload falhou.

    Sem isto, uma falha de rede perderia DE VEZ um arquivo que so existia no IMAP — e a proxima
    execucao talvez nem passe por ele. Fica fora de `data/pdfs_inbox` de proposito.
    """
    destino = QUARENTENA_DIR / chave
    if not _dentro_de(QUARENTENA_DIR, destino):
        log.error(f"    quarentena RECUSADA (caminho fora do diretorio): {_sem_quebra(chave)}")
        return
    try:
        QUARENTENA_DIR.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(dados)
        log.warning(f"    quarentena: {_sem_quebra(chave)}")
    except OSError as e:
        log.error(f"    quarentena falhou ({_sem_quebra(chave)}): {_sem_quebra(e)}")


# =============================================================================================
# INVENTARIO (FASE 1) — so leitura; falha aqui ABORTA sem gravar nada
# =============================================================================================

def _inventario() -> dict:
    """Tudo o que o processamento precisa saber, lido de uma vez antes de qualquer escrita.

    `corpo_pendente` traz SO as linhas com `body_full` nulo E `keyword_matched` preenchido — o
    segundo filtro implementa a decisao de escopo de nao guardar o corpo dos e-mails sem keyword
    (`_register_ignored` grava `keyword_matched: None`, entao ele separa exatamente os dois
    grupos). `body_full` nao entra no `select`: trazer os corpos ja gravados seria dezenas de MB
    inuteis.
    """
    registrados = {r["message_id"] for r in _rest("email_control?select=message_id")
                   if r.get("message_id")}
    pendentes = _rest("email_control?select=id,message_id"
                      "&body_full=is.null&keyword_matched=not.is.null")
    sem_keyword = _rest("email_control?select=id&body_full=is.null&keyword_matched=is.null")
    chaves = {r["access_key"] for r in _rest("fiscal_document?select=access_key")
              if r.get("access_key")}
    objetos = _storage_list(com_metadata=True)
    return {
        "registrados": registrados,
        "corpo_pendente": {r["message_id"]: r["id"] for r in pendentes if r.get("message_id")},
        "sem_keyword": len(sem_keyword),
        "chaves_fiscais": chaves,
        "objetos": objetos,
    }


def _novo_tally() -> dict:
    return {k: 0 for k in (
        "mensagens", "puladas_tamanho", "erros_mensagem", "fora_do_email_control",
        "corpo_a_gravar", "corpo_gravado", "corpo_ja_tinha", "corpo_vazio", "corpo_erro",
        "anexos", "sem_texto", "com_chave", "sem_chave",
        "objetos_a_subir", "objeto_subiu", "objeto_ja_existe", "objeto_erro",
        "fiscal_a_inserir", "fiscal_inserido", "fiscal_duplicado", "fiscal_erro")}


# =============================================================================================
# ORQUESTRACAO
# =============================================================================================

def _contagens_iniciais(inv: dict) -> dict:
    """Fotografia numerica do inventario, tirada ANTES do laco.

    `estado = {**inv, ...}` e copia RASA: os dicionarios/sets sao os MESMOS objetos, e o
    processamento os muta (`pop` em `corpo_pendente`, `add` em `chaves_fiscais`, escrita em
    `objetos`). Sem esta foto, o relatorio final leria os valores JA consumidos e diria
    "com body_full NULO: 0 (candidatos)" logo apos gravar 400 corpos — apagando exatamente a
    base de comparacao que justifica a passada.
    """
    return {
        "registrados": len(inv["registrados"]),
        "corpo_pendente": len(inv["corpo_pendente"]),
        "sem_keyword": inv["sem_keyword"],
        "chaves_fiscais": len(inv["chaves_fiscais"]),
        "objetos": len(inv["objetos"]),
    }


def _relatorio(estado: dict, inicial: dict, total_uids: int, bytes_caixa: int,
               pastas: list) -> None:
    t = estado["tally"]
    log.info("=" * 70)
    if pastas:
        resumo = " | ".join(f"{n}({q})" for n, q in pastas)
        log.info(f"pastas na conta ............ {resumo}")
    log.info(f"mensagens em {MAILBOX} ............ {total_uids}")
    if bytes_caixa:
        rotulo = "bytes a baixar" if estado["dry_run"] else "bytes baixados"
        log.info(f"  {rotulo} ........... {_fmt_bytes(bytes_caixa)}")
    log.info(f"ja em email_control ........ {inicial['registrados']}")
    log.info(f"  com body_full NULO ....... {inicial['corpo_pendente']} (candidatos)")
    log.info(f"  sem keyword (fora) ....... {inicial['sem_keyword']}")
    log.info(f"fiscal_document antes ...... {inicial['chaves_fiscais']} chaves")
    log.info(f"objetos no bucket antes .... {inicial['objetos']}")
    log.info("-" * 70)
    log.info(f"mensagens processadas ...... {t['mensagens']}")
    if t["puladas_tamanho"]:
        log.info(f"  puladas por tamanho ...... {t['puladas_tamanho']}")
    if t["erros_mensagem"]:
        log.info(f"  com erro ................. {t['erros_mensagem']}")
    log.info(f"fora do email_control ...... {t['fora_do_email_control']} (nenhuma linha criada)")
    log.info(f"anexos inspecionados ....... {t['anexos']}")
    log.info(f"  sem texto (imagem/cifrado) {t['sem_texto']}")
    log.info(f"  com chave de acesso ...... {t['com_chave']}")
    log.info(f"  sem chave (nao sobe) ..... {t['sem_chave']}")

    if estado["dry_run"]:
        log.info("-" * 70)
        log.info(f"CORPOS que gravaria ........ {t['corpo_a_gravar']}")
        log.info(f"OBJETOS que subiria ........ {t['objetos_a_subir']}")
        log.info(f"CHAVES que inseriria ....... {t['fiscal_a_inserir']}")
        for modelo, chave, nome in estado["amostra"][:10]:
            log.info(f"    + [{modelo}] {chave}  <- {nome}")
        if len(estado["amostra"]) > 10:
            log.info(f"    ... e mais {len(estado['amostra']) - 10}")
        log.info("\n[dry-run] nada foi gravado.")
        return

    log.info("-" * 70)
    log.info(f"CORPOS gravados ............ {t['corpo_gravado']} "
             f"(ja tinham: {t['corpo_ja_tinha']} · vazios: {t['corpo_vazio']} "
             f"· erros: {t['corpo_erro']})")
    log.info(f"OBJETOS subidos ............ {t['objeto_subiu']} "
             f"(ja existiam: {t['objeto_ja_existe']} · erros: {t['objeto_erro']})")
    log.info(f"CHAVES inseridas ........... {t['fiscal_inserido']} "
             f"(duplicadas: {t['fiscal_duplicado']} · erros: {t['fiscal_erro']})")


def _estado_checkpoint(identidade: dict, total_uids: int, concluidos, falhados, tally) -> dict:
    agora = datetime.now(timezone.utc).isoformat()
    return {
        "versao": CHECKPOINT_VERSAO,
        **identidade,
        "atualizado_em": agora,
        "total_uids": total_uids,
        "concluidos": sorted(concluidos, key=lambda u: int(u) if str(u).isdigit() else 0),
        "falhados": falhados,
        "tally": tally,
    }


def _parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="so relata, sem gravar nada")
    ap.add_argument("--deep", action="store_true",
                    help="no dry-run, baixa a mensagem e conta anexos/chaves de verdade")
    ap.add_argument("--limit", type=int, default=0, help="processa no maximo N mensagens")
    ap.add_argument("--upload-all", action="store_true",
                    help="sobe tambem o anexo sem chave de acesso (a purga o apagara depois)")
    ap.add_argument("--max-message-bytes", type=int, default=MAX_MESSAGE_BYTES_DEFAULT,
                    help="pula (e reporta) mensagem acima deste tamanho")
    ap.add_argument("--checkpoint-every", type=int, default=25,
                    help="grava o checkpoint a cada N mensagens")
    ap.add_argument("--reset-checkpoint", action="store_true",
                    help="descarta o checkpoint anterior e comeca do zero")
    ap.add_argument("--sleep-ms", type=int, default=0,
                    help="espera entre mensagens, para aliviar o servidor")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(argv)
    if not BASE or not KEY:
        log.error("Configure SUPABASE_URL e SUPABASE_SERVICE_KEY no .env")
        return 1

    # FASE 1 — inventario. Falha aqui aborta ANTES de qualquer escrita: decidir o que gravar
    # com um inventario truncado e como a purga apagar o que nao devia.
    try:
        inv = _inventario()
    except RestError as e:
        log.error(f"Leitura incompleta — NADA foi gravado: {e}")
        return 1

    # Foto do inventario ANTES de qualquer mutacao — ver `_contagens_iniciais`.
    inicial = _contagens_iniciais(inv)
    # So ha relatorio a emitir depois que a varredura de fato comecou. Abortar no gate do
    # checkpoint e imprimir em seguida um relatorio inteiro zerado empurra a mensagem de erro
    # para fora da tela e sugere que algo rodou.
    varreu = False
    caixa = Caixa()
    estado = {
        **inv,
        "tally": _novo_tally(),
        "dry_run": args.dry_run,
        "upload_all": args.upload_all,
        "amostra": [],
    }
    concluidos, falhados = set(), {}
    total_uids = 0
    bytes_caixa = 0
    pastas = []
    # Identidade da caixa capturada NA ABERTURA — e ela que vai para o checkpoint, jamais a
    # `caixa.uidvalidity` corrente. Quando `_reconectar` aborta por UIDVALIDITY diferente, o
    # atributo ja foi atualizado para o valor NOVO; gravar esse valor ao lado dos UIDs do
    # inventario ANTIGO tornaria o checkpoint "compativel" na proxima execucao e ela retomaria
    # pulando as mensagens erradas — exatamente o desastre que a checagem existe para impedir.
    identidade = None

    try:
        uids = caixa.abrir()
        total_uids = len(uids)
        identidade = {"imap_user": os.getenv("IMAP_USER"), "mailbox": MAILBOX,
                      "uidvalidity": caixa.uidvalidity, "criterio": CRITERIO}

        # FASE 0 — checkpoint (depois de conhecer o UIDVALIDITY, que e o que o valida).
        salvo = {} if args.reset_checkpoint else _carrega_checkpoint(CHECKPOINT_PATH)
        incompativel = _checkpoint_compativel(salvo, identidade)
        if incompativel:
            log.error(f"Checkpoint INCOMPATIVEL ({_sem_quebra(incompativel)}).\n"
                      "Os UIDs salvos designam outras mensagens agora. Use --reset-checkpoint "
                      "para comecar do zero.")
            return 1
        concluidos = {str(u) for u in salvo.get("concluidos", [])}
        falhados = dict(salvo.get("falhados", {}))
        if concluidos:
            log.info(f"retomando: {len(concluidos)} uid(s) ja concluidos")

        if args.dry_run:
            pastas = caixa.pastas()

        pendentes = _uids_pendentes(uids, concluidos)
        if args.limit:
            pendentes = pendentes[:args.limit]
        log.info(f"a processar: {len(pendentes)} de {total_uids} mensagem(ns)")

        raso = args.dry_run and not args.deep
        varreu = True
        for i, uid in enumerate(pendentes, 1):
            us = _uid_str(uid)
            try:
                if raso:
                    # Dry-run raso: so headers + tamanho, num unico FETCH, para dimensionar a
                    # caixa sem baixar anexo nenhum.
                    meta, raw, tamanho = caixa.previa(uid)
                    bytes_caixa += tamanho
                    msg = email.message_from_bytes(raw)
                    ctx = _message_identity(msg, uid, meta)
                    if ctx["chave_indice"] in estado["corpo_pendente"]:
                        estado["tally"]["corpo_a_gravar"] += 1
                    elif ctx["chave_indice"] not in estado["registrados"]:
                        estado["tally"]["fora_do_email_control"] += 1
                    estado["tally"]["mensagens"] += 1
                    continue

                tamanho = caixa.tamanho(uid)
                bytes_caixa += tamanho
                if tamanho > args.max_message_bytes:
                    estado["tally"]["puladas_tamanho"] += 1
                    log.warning(f"  [{i}] uid {us} pulado: {_fmt_bytes(tamanho)} acima do teto")
                    continue

                meta, raw = caixa.mensagem(uid)
                estado["tally"]["mensagens"] += 1
                if _processar_mensagem(estado, uid, raw, meta):
                    concluidos.add(us)
                    falhados.pop(us, None)
                else:
                    falhados[us] = "sub-etapa falhou"
            except CaixaMudou:
                # NAO e "falha desta mensagem": a caixa inteira deixou de ser a mesma. Sobe para
                # o except externo, que reporta e encerra com exit != 0. Sem este ramo, o
                # `except Exception` abaixo engoliria o aborto e a varredura seguiria lendo os
                # UIDs seguintes numa caixa que ja nao corresponde ao inventario.
                raise
            except Exception as e:  # noqa: BLE001 — uma mensagem ruim nao derruba a varredura
                estado["tally"]["erros_mensagem"] += 1
                falhados[us] = _sem_quebra(e)
                log.exception(f"  [{i}] uid {us}: {_sem_quebra(e)}")

            if i % 25 == 0:
                log.info(f"  ... {i}/{len(pendentes)}")
            if not args.dry_run and args.checkpoint_every and i % args.checkpoint_every == 0:
                _salva_checkpoint(CHECKPOINT_PATH, _estado_checkpoint(
                    identidade, total_uids, concluidos, falhados, estado["tally"]))
            if args.sleep_ms:
                time.sleep(args.sleep_ms / 1000)
    except (RuntimeError, imaplib.IMAP4.error) as e:
        log.error(f"Varredura interrompida: {e}")
        return 1
    finally:
        # FASE 3 — o checkpoint e o relatorio saem mesmo em Ctrl+C ou excecao: e o progresso
        # que evita reiniciar do zero.
        if not args.dry_run and identidade and (concluidos or falhados):
            _salva_checkpoint(CHECKPOINT_PATH, _estado_checkpoint(
                identidade, total_uids, concluidos, falhados, estado["tally"]))
        caixa.fechar()
        if varreu:
            _relatorio(estado, inicial, total_uids, bytes_caixa, pastas)

    if falhados:
        # Exit != 0 porque o run NAO terminou limpo — os uids voltam para a fila, mas quem
        # chamou (pessoa ou agendador) precisa do sinal para rodar de novo.
        log.warning(f"{len(falhados)} uid(s) com falha — voltam para a fila na proxima execucao")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
