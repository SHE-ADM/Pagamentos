"""
read_emails.py — Leitura de e-mails financeiros via IMAP + controle Supabase
Projeto: pagamentos | Skill: email-reader | v2.0.0

Deduplicação: tabela email_control no Supabase (message_id UNIQUE).
Nunca reprocessa um e-mail já registrado, independente de onde o script rodar.
"""

import os, sys, re, time, socket, imaplib, email, argparse, logging, csv, json, tempfile, faulthandler, unicodedata, ipaddress
import urllib.request, urllib.error, urllib.parse, http.cookiejar, http.client
from html import unescape as html_unescape
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime
from datetime import datetime, timezone, timedelta
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parents[3] / ".env")

# ---------------------------------------------------------------------------
# Faulthandler — captura crashes nativos (segfault, stack overflow, etc.)
# Grava stack trace em arquivo antes do processo morrer.
# ---------------------------------------------------------------------------
_CRASH_LOG_DIR = Path(__file__).parents[3] / "logs" / "scheduler"
_CRASH_LOG_DIR.mkdir(parents=True, exist_ok=True)
_CRASH_LOG = _CRASH_LOG_DIR / f"crash_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
_crash_file = open(_CRASH_LOG, "w", encoding="utf-8")
_crash_file.write(f"faulthandler ativado em {datetime.now().isoformat()}\n")
_crash_file.flush()
faulthandler.enable(file=_crash_file, all_threads=True)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
log = logging.getLogger("email-reader")


# Falha de API na extracao (creditos/auth/rate-limit). Interrompe o run com
# seguranca: o e-mail NAO e marcado como processado, sendo reprocessado quando
# a API voltar. Evita gravar dados incompletos (fornecedor vazio, valor errado).
class ApiUnavailableError(RuntimeError):
    """API Anthropic indisponivel durante a extracao — para o pipeline."""


# Console do Windows (cp1252) nao encoda os simbolos de log (✓/→/✗).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ---------------------------------------------------------------------------
# Configurações
# ---------------------------------------------------------------------------
BASE_DIR       = Path(__file__).parents[3]
PDF_INBOX      = BASE_DIR / "data" / "pdfs_inbox"
CSV_OUTPUT     = BASE_DIR / "data" / "csv_output"
EXTRACT_SCRIPT = BASE_DIR / "skills" / "pdf-contas-pagar" / "scripts" / "extract_pdf.py"
EMAILS_LOG     = CSV_OUTPUT / "emails_log.csv"

# Content-Type por extensão do anexo (PDF ou imagem) para o upload no Storage.
_UPLOAD_CONTENT_TYPES = {
    ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
}


def _normalize_body_barcode(raw: str | None) -> str | None:
    """Normaliza o barcode extraido do CORPO reusando a funcao canonica do
    extract_pdf — mesma validacao do caminho de PDF (44/48 mantidos, 47 -> 44,
    outros comprimentos -> None). Antes o corpo usava um re.sub solto que aceitava
    qualquer sequencia de 44-48 digitos (ex.: 45/46), podendo gravar barcode
    invalido. Import e lazy para nao carregar pdfplumber/pandas no import do
    read_emails; em qualquer falha de import cai num fallback defensivo."""
    if not raw:
        return None
    try:
        if str(EXTRACT_SCRIPT.parent) not in sys.path:
            sys.path.insert(0, str(EXTRACT_SCRIPT.parent))
        from extract_pdf import normalize_barcode
        return normalize_barcode(raw)
    except Exception:
        digits = re.sub(r"\D", "", raw)
        return digits if 44 <= len(digits) <= 48 else None


def _apply_barcode_due_date(payload: dict) -> None:
    """Rede de seguranca UNIVERSAL contra inversao dia/mes do vencimento: a data de vencimento
    de um boleto e o FATOR DE VENCIMENTO do codigo de barras (deterministico), NAO a data lida —
    que o Vision/OCR pode inverter (falha grave: id 435 gravou 07/08 no lugar de 08/07). Antes de
    gravar QUALQUER conta com boleto FEBRABAN, sobrescreve o due_date pelo derivado do barcode se
    divergir. Aplicado em register_financial (choke point unico de toda gravacao do pipeline
    Python — PDF, corpo e reprocessos), alem da correcao em extract_pdf.build_record. So confia no
    fator quando o barcode e CONSISTENTE (valor embutido == amount — `authoritative_barcode_due_date`):
    um barcode mal lido pelo OCR (boleto escaneado) tem valor divergente e NAO dita a data (id 463).
    Best-effort: import lazy do extract_pdf; qualquer falha e ignorada (nao derruba a gravacao)."""
    if not payload.get("barcode"):
        return
    try:
        if str(EXTRACT_SCRIPT.parent) not in sys.path:
            sys.path.insert(0, str(EXTRACT_SCRIPT.parent))
        from extract_pdf import authoritative_barcode_due_date
        # GATES: so sobrescreve pelo fator quando o barcode e CONSISTENTE com o valor E o
        # vencimento derivado nao e anterior a emissao (fator stale de boleto securitizado).
        bc_due = authoritative_barcode_due_date(
            payload.get("barcode"), payload.get("amount"),
            payload.get("issue_date") or payload.get("extracted_at"),
            issue_date=payload.get("issue_date"))
    except Exception:
        return
    cur = str(payload.get("due_date") or "")[:10]
    if not bc_due or cur == bc_due:
        return
    payload["due_date"] = bc_due
    note = f"Vencimento corrigido pelo codigo de barras (fator FEBRABAN): {cur or '—'} -> {bc_due}"
    payload["processing_notes"] = (
        f'{payload["processing_notes"]} | {note}' if payload.get("processing_notes") else note)


def _is_boleto_barcode(barcode: str | None) -> bool:
    """True quando o barcode e um BOLETO pagavel (nao chave NF-e/CT-e). Reusa a
    funcao canonica do extract_pdf (44 FEBRABAN moeda '9' banco != '000', ou 48
    de arrecadacao); import lazy com fallback defensivo, como _normalize_body_barcode."""
    if not barcode:
        return False
    try:
        if str(EXTRACT_SCRIPT.parent) not in sys.path:
            sys.path.insert(0, str(EXTRACT_SCRIPT.parent))
        from extract_pdf import is_boleto_barcode
        return is_boleto_barcode(barcode)
    except Exception:
        d = re.sub(r"\D", "", barcode)
        return len(d) == 48 or (len(d) == 44 and d[3:4] == "9" and d[:3] != "000")

PDF_INBOX.mkdir(parents=True, exist_ok=True)
CSV_OUTPUT.mkdir(parents=True, exist_ok=True)

# Bucket de Storage onde os PDFs anexados sao publicados (migration 021).
# O frontend gera URL assinada a partir do source_file = nome do arquivo.
STORAGE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "attachments")

KEYWORDS_DEFAULT = [
    "boleto", "nota fiscal", "nf-e", "nfe", "fatura",
    "cobrança", "vencimento", "pagamento", "pagamentos",
    "pagamento fornecedor", "pagamentos fornecedores", "duplicata",
    "recibo", "nfs-e", "nfse", "notas fiscais", "danfe",
    # Guias de tributos federais/estaduais/municipais. Os acronimos curtos
    # (darf, das, dae, dam, duam, gru, gnre, gare, ipva, iptu, iss, itbi) casam
    # por PALAVRA INTEIRA — ver WORD_KEYWORDS/match_keyword — para nao casarem
    # dentro de palavras comuns ('das' em 'cadastro', 'iss' em 'emissao').
    "simples nacional", "simei", "darf", "das", "dae", "dam", "duam",
    "gps", "gru", "gnre", "gare", "ipva", "iptu", "iss", "itbi",
    "guia", "guia de pagamento", "guia de recolhimento",
    # Conhecimento de Transporte Eletronico
    "ct-e", "cte", "dacte", "transporte", "transportadora", "conhecimento de transporte",
    # Fechamento de conta / extrato mensal
    "fechamento",
    # Seguro
    "seguro",
    # Operacoes de cambio (le 'cambio' ou 'câmbio'; gravado como 'câmbio')
    "câmbio",
    # Honorários (serviços profissionais — geralmente pagos via PIX)
    "honorário", "honorários", "honorario", "honorarios",
    # Container (frete/demurrage/movimentação de contêineres)
    "container", "conteiner", "contêiner",
    # Cartório (custas de tabelionato/registro/protesto) — casa por substring (termo
    # distintivo, não colide com palavras comuns).
    "cartório", "cartorio", "tabelionato",
]

LOG_COLUMNS = [
    "message_id", "received_at", "sender_name", "sender_email",
    "subject", "body_preview", "has_attachment", "attachment_names",
    "attachment_saved", "pdf_extracted", "extraction_csv",
    "keyword_matched", "processed_at", "notes"
]

# Situacao (financial_account_control) — a FONTE UNICA e status_id (FK -> dimensao
# `status`). O pipeline ainda rotula internamente por TEXTO ('pendente'/'falha'); a
# traducao para status_id acontece num UNICO ponto (register_financial), antes do UPSERT.
# A trigger id-primaria (migration 068) recalcula 'a vencer'(3)/'vencido'(2) por vencimento
# e deriva o texto a partir do id. Mapa = tabela `status` (nomes exatos, com acento).
STATUS_ID_A_VENCER = 3   # default do banco (migration 067) — conta normal sem vencimento
_STATUS_NAME_TO_ID = {   # 'falha' -> 10 (estado fechado, a trigger preserva)
    "pendente": 1, "vencido": 2, "a vencer": 3, "prorrogado": 4, "baixado": 5,
    "protestado": 6, "cartório": 7, "pago": 8, "cancelado": 9, "falha": 10,
}


def _apply_status_id(payload: dict) -> None:
    """Traduz o `status` TEXTO do payload para `status_id` (fonte unica) e remove o texto.
    'pendente' (ou vazio) NAO seta status_id -> o banco aplica o DEFAULT 3 ('a vencer') e a
    trigger recalcula por vencimento. Demais estados (ex.: 'falha') viram o id correspondente.
    Chamado so na gravacao; o extractor/build seguem rotulando por texto internamente."""
    txt = (payload.pop("status", None) or "").strip().lower()
    if txt and txt != "pendente":
        payload["status_id"] = _STATUS_NAME_TO_ID.get(txt, STATUS_ID_A_VENCER)


# ---------------------------------------------------------------------------
# Supabase — controle de deduplicação
# ---------------------------------------------------------------------------
# Retry da checagem de duplicidade: um hiccup de rede na consulta faria _find
# retornar None ("sem duplicata") e o pipeline GRAVARIA uma conta duplicada. Por
# isso a consulta de dedup e re-tentada em falha transitoria antes de desistir.
DUP_QUERY_ATTEMPTS = int(os.getenv("DUP_QUERY_ATTEMPTS", "3"))
DUP_QUERY_BACKOFF  = float(os.getenv("DUP_QUERY_BACKOFF", "1.5"))  # segundos * tentativa


class SupabaseControl:
    """Gerencia a tabela email_control no Supabase."""

    def __init__(self):
        self.base = os.getenv("SUPABASE_URL", "").rstrip("/")
        self.key  = os.getenv("SUPABASE_SERVICE_KEY", "")
        self.headers = {
            "apikey":        self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type":  "application/json",
        }
        self._available = self._check_connection()

    def _check_connection(self) -> bool:
        try:
            req = urllib.request.Request(
                f"{self.base}/rest/v1/email_control?limit=1",
                headers=self.headers
            )
            urllib.request.urlopen(req, timeout=5)
            return True
        except Exception as e:
            log.warning(f"Supabase indisponível — usando deduplicação local: {e}")
            return False

    def company_cnpj(self) -> "str | None":
        """CNPJ (só dígitos) da empresa pagadora (company_id=1) — base das senhas
        candidatas de boletos protegidos (CNPJ[:4]/[:5]/[:6]). Cacheado por instância;
        None quando indisponível (o caller simplesmente não tenta descriptografar)."""
        if getattr(self, "_company_cnpj_cache", "__unset__") != "__unset__":
            return self._company_cnpj_cache
        self._company_cnpj_cache = None
        if self._available:
            try:
                req = urllib.request.Request(
                    f"{self.base}/rest/v1/company?company_id=eq.1&select=cnpj&limit=1",
                    headers=self.headers,
                )
                with urllib.request.urlopen(req, timeout=5) as r:
                    rows = json.loads(r.read())
                if rows and rows[0].get("cnpj"):
                    self._company_cnpj_cache = re.sub(r"\D", "", str(rows[0]["cnpj"])) or None
            except Exception as e:
                log.warning(f"Falha ao ler CNPJ da empresa (company_id=1): {e}")
        return self._company_cnpj_cache

    def is_processed(self, message_id: str) -> bool:
        """True se o message_id já existe na tabela."""
        if not self._available:
            return False
        try:
            mid_enc = urllib.parse.quote(message_id, safe="")
            req = urllib.request.Request(
                f"{self.base}/rest/v1/email_control"
                f"?message_id=eq.{mid_enc}&select=id&limit=1",
                headers=self.headers
            )
            with urllib.request.urlopen(req, timeout=5) as r:
                data = json.loads(r.read())
                return len(data) > 0
        except Exception as e:
            log.warning(f"Erro ao verificar duplicidade: {e}")
            return False

    def register(self, rec: dict) -> bool:
        """Insere registro na tabela. Ignora conflito de message_id."""
        if not self._available:
            return False
        payload = {
            "message_id":       rec.get("message_id"),
            "received_at":      rec.get("received_at"),
            "sender_name":      rec.get("sender_name"),
            "sender_email":     rec.get("sender_email"),
            "subject":          rec.get("subject"),
            "body_preview":     (rec.get("body_preview") or "")[:500],
            "keyword_matched":  rec.get("keyword_matched"),
            # has_attachment fica NULL quando desconhecido (e-mails 'ignorado', que
            # não são baixados) — assim não poluem o KPI "Sem anexo PDF" (eq.false).
            "has_attachment":   None if rec.get("has_attachment") is None else bool(rec.get("has_attachment")),
            "attachment_names": rec.get("attachment_names"),
            "attachment_saved": bool(rec.get("attachment_saved")),
            "pdf_extracted":    bool(rec.get("pdf_extracted")),
            "extraction_csv":   rec.get("extraction_csv"),
            "notes":            rec.get("notes"),
            # Status explícito (ex.: 'ignorado' p/ fora do filtro) tem prioridade;
            # caso contrário, deriva de pdf_extracted/attachment_saved/notes.
            "status":           rec.get("status") or self._derive_status(rec),
            "processed_at":     rec.get("processed_at"),
        }
        try:
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                f"{self.base}/rest/v1/email_control",
                data=data,
                headers={**self.headers, "Prefer": "resolution=ignore-duplicates"},
                method="POST"
            )
            urllib.request.urlopen(req, timeout=10)
            return True
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            if "duplicate" in body.lower() or e.code == 409:
                return False   # já existe — normal
            log.error(f"Erro ao registrar no Supabase: {e.code} {body[:150]}")
            return False
        except Exception as e:
            log.error(f"Erro ao registrar no Supabase: {e}")
            return False

    def register_error(self, email_rec: dict, error_type: str,
                       error_message: str, raw_payload: dict = None) -> bool:
        """Grava falha de processamento em email_processing_errors."""
        if not self._available:
            log.warning(f"[ERRO-LOG] {error_type}: {error_message[:120]}")
            return False
        payload = {
            "gmail_message_id": email_rec.get("message_id"),
            "sender_name":      email_rec.get("sender_name"),
            "sender_email":     email_rec.get("sender_email"),
            "subject":          email_rec.get("subject"),
            "received_at":      email_rec.get("received_at"),
            "source_file":      email_rec.get("source_file"),
            "error_type":       error_type,
            "error_message":    str(error_message)[:500],
            "raw_payload":      raw_payload,
        }
        try:
            data = json.dumps(payload, default=str).encode()
            req = urllib.request.Request(
                f"{self.base}/rest/v1/email_processing_errors",
                data=data,
                headers=self.headers,
                method="POST"
            )
            urllib.request.urlopen(req, timeout=10)
            log.warning(f"  [ERRO-LOG] {error_type}: {error_message[:120]}")
            return True
        except Exception as e:
            log.error(f"Falha ao gravar erro no Supabase: {e}")
            return False

    def register_financial(self, payload: dict) -> bool:
        """UPSERT de uma conta extraida em financial_account_control (service_role).

        Deduplica/atualiza por gmail_message_id. A situacao e gravada por status_id (FONTE
        UNICA): _apply_status_id traduz o `status` texto do payload -> status_id e remove o
        texto. 'pendente' cai no DEFAULT 3 do banco; a trigger id-primaria (068) recalcula
        'a vencer'/'vencido' por due_date x extracted_at quando em aberto (preserva 'falha').
        """
        if not self._available:
            return False
        try:
            payload = dict(payload)   # copia — nao muta o dict do chamador ao traduzir status
            _apply_barcode_due_date(payload)  # rede de seguranca: vencimento pelo fator do barcode
            _apply_status_id(payload)
            # Autoria (Etapa 1 — visibilidade por dono): dono = usuario do remetente
            # (sender_email -> UUID via RPC), padrao sentinela quando nao casa. So no INSERT;
            # se ja veio created_by, respeita. Falha/None -> DEFAULT da coluna (sentinela).
            if not payload.get("created_by"):
                owner = self.resolve_user(payload.get("sender_email"))
                if owner:
                    payload["created_by"] = owner
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                f"{self.base}/rest/v1/financial_account_control?on_conflict=gmail_message_id",
                data=data,
                headers={**self.headers, "Prefer": "resolution=merge-duplicates"},
                method="POST"
            )
            urllib.request.urlopen(req, timeout=10)
            return True
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            log.error(f"Erro ao gravar conta no Supabase: {e.code} {body[:200]}")
            return False
        except Exception as e:
            log.error(f"Erro ao gravar conta no Supabase: {e}")
            return False

    def unique_invoice_number(self, base: str) -> str:
        """Retorna o proximo invoice_number unico baseado em base.

        Se base nao existe na tabela, retorna base.
        Se existe, retorna base(2), base(3), etc., ate encontrar um livre.
        Em caso de falha na consulta, retorna base (nao bloqueia a insercao).
        """
        if not self._available:
            return base
        try:
            pattern = urllib.parse.quote(base + '%', safe='')
            req = urllib.request.Request(
                f"{self.base}/rest/v1/financial_account_control"
                f"?select=invoice_number&invoice_number=like.{pattern}&limit=50",
                headers=self.headers
            )
            with urllib.request.urlopen(req, timeout=5) as r:
                existing = {row["invoice_number"] for row in json.loads(r.read())}
        except Exception as e:
            log.warning(f"Nao foi possivel verificar invoice_number no banco: {e}")
            return base

        if base not in existing:
            return base

        n = 2
        while f"{base}({n})" in existing:
            n += 1
        return f"{base}({n})"

    def upload_attachment(self, pdf_path) -> bool:
        """Publica o PDF no bucket de Storage (service_role, ignora RLS).

        A chave do objeto e o proprio nome do arquivo (= source_file gravado em
        financial_account_control), para o frontend gerar a URL assinada direto.
        Idempotente (x-upsert). Falha de upload e NAO-fatal: a conta ja foi
        gravada; o anexo pode ser re-publicado depois. Retorna True em sucesso.
        """
        if not self._available:
            return False
        try:
            data = pdf_path.read_bytes()
        except Exception as e:
            log.warning(f"Falha ao ler PDF p/ upload {pdf_path.name}: {e}")
            return False
        key = urllib.parse.quote(pdf_path.name, safe="")
        # Content-Type por extensão (PDF ou imagem) — para o frontend exibir o
        # anexo corretamente pela URL assinada (antes era fixo em application/pdf).
        content_type = _UPLOAD_CONTENT_TYPES.get(
            Path(pdf_path).suffix.lower(), "application/octet-stream")
        try:
            req = urllib.request.Request(
                f"{self.base}/storage/v1/object/{STORAGE_BUCKET}/{key}",
                data=data,
                headers={
                    "apikey":        self.key,
                    "Authorization": f"Bearer {self.key}",
                    "Content-Type":  content_type,
                    "x-upsert":      "true",
                },
                method="POST",
            )
            urllib.request.urlopen(req, timeout=30)
            return True
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            log.warning(f"Falha ao subir anexo {pdf_path.name}: {e.code} {body[:150]}")
            return False
        except Exception as e:
            log.warning(f"Falha ao subir anexo {pdf_path.name}: {e}")
            return False

    def find_financial_duplicate(self, payload: dict) -> dict | None:
        """Retorna a conta existente que representa o MESMO documento, ou None.

        Cobre a duplicidade real que a dedup por message_id NAO pega: o mesmo
        remetente envia o MESMO documento em dois e-mails diferentes (Message-ID
        distintos). Considera duplicata se QUALQUER impressao digital casar:
          1. barcode (linha digitavel / codigo de barras / chave) — definitivo;
          2. fornecedor + numero do documento + valor — pega DAS reenviado com
             vencimento diferente (numero da guia identico);
          3. fornecedor + valor + vencimento (+ tipo) — pega o mesmo encargo
             emitido em documentos com numero proprio distinto (ex.: boleto x
             RPS da mesma fatura, ambos R$ X no mesmo vencimento). Quando o NOVO
             documento tem barcode (boleto autoritativo), casa a conta do CORPO/
             notificacao da mesma divida IGNORANDO o document_type — fecha o gap
             cross-e-mail em que o corpo gravou tipo generico ('outro') e o boleto
             chega depois como 'boleto' (ids 7/176, 217/218), que a exigencia de
             tipo igual deixava passar, criando conta duplicada.
        As impressoes 2 e 3 sao complementares — uma sozinha deixa passar casos
        que a outra pega; por isso ambas sao verificadas.

        Retorna a 1a conta encontrada (id, due_date, barcode) para o chamador
        decidir entre pular ou ATUALIZAR (ex.: reemissao com vencimento mais novo).
        Conservador: so deduplica com um identificador de fornecedor presente.
        Em caso de erro de consulta, retorna None (nao bloqueia a insercao).
        """
        if not self._available:
            return None

        def _eq_clause(col: str, v) -> str:
            if v in (None, ""):
                return f"{col}=is.null"
            sval = f"{float(v):.2f}" if col == "amount" else str(v)
            return f"{col}=eq.{urllib.parse.quote(sval, safe='')}"

        def _find(clauses: list) -> dict | None:
            # Re-tenta em falha TRANSITORIA (rede/timeout): uma consulta que falha
            # e retorna None seria lida como "sem duplicata" e criaria conta
            # duplicada. Um resultado vazio (rows == []) NAO e erro — retorna None
            # de imediato (nao re-tenta). Esgotadas as tentativas, retorna None
            # (nao bloqueia a insercao indefinidamente) apos logar.
            filters = "&".join(clauses)
            last_err = None
            for attempt in range(1, DUP_QUERY_ATTEMPTS + 1):
                try:
                    req = urllib.request.Request(
                        f"{self.base}/rest/v1/financial_account_control"
                        f"?{filters}&select=id,due_date,barcode&limit=1",
                        headers=self.headers,
                    )
                    with urllib.request.urlopen(req, timeout=5) as r:
                        rows = json.loads(r.read())
                        return rows[0] if rows else None
                except Exception as e:
                    last_err = e
                    if attempt < DUP_QUERY_ATTEMPTS:
                        time.sleep(DUP_QUERY_BACKOFF * attempt)
            log.warning(
                f"Falha na checagem de duplicidade de conteudo apos "
                f"{DUP_QUERY_ATTEMPTS} tentativas: {last_err}"
            )
            return None

        # 1. Barcode — identificador definitivo do documento de pagamento.
        barcode = (payload.get("barcode") or "").strip()
        if barcode:
            m = _find([f"barcode=eq.{urllib.parse.quote(barcode, safe='')}"])
            if m:
                return m

        # 2/3. Precisam do fornecedor ja resolvido (sk_supplier). A resolucao
        # (incl. normalizacao de nome/CNPJ via resolve_supplier_id) acontece em
        # _finalize_supplier ANTES da dedup, entao aqui basta casar por sk_supplier.
        sk_supplier = payload.get("sk_supplier")
        if not sk_supplier:
            return None  # sem fornecedor resolvido — nao deduplica

        supplier_clause = f"sk_supplier=eq.{int(sk_supplier)}"

        # 2. fornecedor + numero do documento + valor (numero substancial).
        # IGNORA numero SINTETICO (PIX_/{tipo}_{ddmmaa}): ele colide entre boletos
        # distintos do mesmo fornecedor/valor/vencimento (ex.: parcelas com
        # vencimento defaultado p/ a data da extracao), causando falso-positivo de
        # duplicidade. So o numero PROPRIO do documento e chave confiavel aqui; o
        # codigo de barras distingue os demais (impressoes 1 e 3).
        invoice = str(payload.get("invoice_number") or "").strip()
        if len(invoice) >= 6 and not _is_synthetic_invoice_number(invoice):
            m = _find([
                supplier_clause,
                f"invoice_number=eq.{urllib.parse.quote(invoice, safe='')}",
                _eq_clause("amount", payload.get("amount")),
            ])
            if m:
                return m

        # 3. fornecedor + valor + vencimento — MESMA divida, INDEPENDENTE do tipo.
        # Regra de negocio: se fornecedor + valor + vencimento coincidem, e a mesma
        # conta a pagar (o tipo varia entre os documentos que a descrevem — 'boleto'
        # no PDF, 'fatura'/'outro'/'pix' no corpo). Exigir tipo igual deixava passar
        # duplicatas cross-e-mail em QUALQUER ordem de chegada (ids 7/176, 217/218,
        # 511/512). O document_type NAO entra mais na impressao 3.
        base3 = [supplier_clause,
                 _eq_clause("amount", payload.get("amount")),
                 _eq_clause("due_date", payload.get("due_date"))]
        if barcode:
            # NOVO doc tem codigo de barras: so casa candidatos SEM barcode. Barcode
            # presente e DIFERENTE = documento distinto (a impressao 1 ja teria casado
            # se fossem o mesmo) — assim boletos distintos de mesmo valor/vencimento
            # (parcelas, guias GNRE de R$ 399,03) NAO se fundem, cada um com sua linha
            # digitavel. O candidato sem barcode e a conta do corpo/notificacao da
            # mesma divida.
            return _find(base3 + ["barcode=is.null"])
        # NOVO sem barcode (corpo / notificacao / reemissao): casa qualquer conta da
        # mesma divida (fornecedor+valor+vencimento), inclusive um boleto ja gravado
        # com barcode — o documento sem linha digitavel nunca e um 2o pagavel legitimo.
        return _find(base3)

    def resolve_supplier(self, payload: dict) -> int | None:
        """Resolve/cria o fornecedor via RPC resolve_supplier_for_account e devolve
        sk_supplier (surrogate key). Reusa a mesma logica antes embutida no trigger
        trg_fe_resolve_supplier (resolve_supplier_id por CNPJ->CPF->e-mail->nome->auto-insert
        + anexa o e-mail do remetente). Em erro de consulta, retorna None (o chamador trata
        como falha)."""
        if not self._available:
            return None
        body = json.dumps({
            "p_cnpj":  payload.get("supplier_cnpj"),
            "p_cpf":   payload.get("supplier_cpf"),
            "p_name":  payload.get("supplier_name"),
            "p_email": payload.get("sender_email"),
        }).encode()
        try:
            req = urllib.request.Request(
                f"{self.base}/rest/v1/rpc/resolve_supplier_for_account",
                data=body, headers=self.headers, method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read())  # RPC escalar → o proprio bigint
        except Exception as e:
            log.warning(f"Falha ao resolver fornecedor (RPC): {e}")
            return None

    def resolve_user(self, sender_email: str | None) -> str | None:
        """Resolve o UUID do usuario dono da conta a partir do e-mail do remetente,
        via RPC resolve_user_for_account (migration 076). A RPC ja devolve o usuario-
        padrao (teste@otimotex.com.br) quando o e-mail nao casa nenhum usuario — mantem
        100% do relacionamento. Em erro/sem e-mail retorna None (o DEFAULT da coluna
        created_by assume o sentinela)."""
        if not self._available or not sender_email:
            return None
        body = json.dumps({"p_email": sender_email}).encode()
        try:
            req = urllib.request.Request(
                f"{self.base}/rest/v1/rpc/resolve_user_for_account",
                data=body, headers=self.headers, method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read())  # RPC escalar → UUID (str)
        except Exception as e:
            log.warning(f"Falha ao resolver usuario dono (RPC): {e}")
            return None

    def supplier_defaults(self, sk_supplier: int) -> tuple[int, int]:
        """Le a classificacao contabil DEFAULT do fornecedor (migration 052) para
        pre-preencher a conta na extracao. Retorna (cost_center_id, chart_account_id);
        (0, 0) em ausencia/erro (sentinela 'nao informado')."""
        if not self._available or not sk_supplier:
            return (0, 0)
        try:
            req = urllib.request.Request(
                f"{self.base}/rest/v1/supplier"
                f"?sk_supplier=eq.{int(sk_supplier)}"
                f"&select=cost_center_id,chart_account_id&limit=1",
                headers=self.headers,
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                rows = json.loads(r.read())
            if not rows:
                return (0, 0)
            row = rows[0]
            return (int(row.get("cost_center_id") or 0), int(row.get("chart_account_id") or 0))
        except Exception as e:
            log.warning(f"Falha ao ler classificacao do fornecedor {sk_supplier}: {e}")
            return (0, 0)

    def update_financial(self, record_id, fields: dict) -> bool:
        """PATCH de uma conta existente — ex.: atualizar vencimento/boleto de uma
        guia reemitida para os dados de pagamento mais recentes. Ignora campos None."""
        if not self._available:
            return False
        clean = {k: v for k, v in fields.items() if v not in (None, "")}
        if not clean:
            return False
        try:
            data = json.dumps(clean).encode()
            req = urllib.request.Request(
                f"{self.base}/rest/v1/financial_account_control?id=eq.{record_id}",
                data=data,
                headers={**self.headers, "Prefer": "return=minimal"},
                method="PATCH",
            )
            urllib.request.urlopen(req, timeout=10)
            return True
        except urllib.error.HTTPError as e:
            log.error(f"Falha ao atualizar conta {record_id}: {e.code} {e.read().decode(errors='replace')[:150]}")
            return False
        except Exception as e:
            log.error(f"Falha ao atualizar conta {record_id}: {e}")
            return False

    def update_supplier_classification(self, sk_supplier, cost_center_id, chart_account_id) -> bool:
        """Write-back da classificacao contabil no cadastro do fornecedor (PATCH supplier).
        Equivalente Python do TS setSupplierClassification. Best-effort: falha NAO derruba a
        gravacao da conta. O chamador (apply_forced_classification) ja garante a excecao da
        OTIMOTEX (sk=1); aqui so validamos disponibilidade e sk.
        NOTA: fornecedor de FUNCIONARIO (trade_name com 'funcionario') e mantido em 0 pela
        trigger trg_supplier_no_funcionario_classification (migration 070) — este write-back
        vira no-op para eles (a despesa de funcionario varia por conta, sem default no cadastro)."""
        if not self._available or not sk_supplier:
            return False
        try:
            data = json.dumps({
                "cost_center_id":  int(cost_center_id),
                "chart_account_id": int(chart_account_id),
            }).encode()
            req = urllib.request.Request(
                f"{self.base}/rest/v1/supplier?sk_supplier=eq.{int(sk_supplier)}",
                data=data,
                headers={**self.headers, "Prefer": "return=minimal"},
                method="PATCH",
            )
            urllib.request.urlopen(req, timeout=10)
            return True
        except urllib.error.HTTPError as e:
            log.warning(f"Falha no write-back de classificacao do fornecedor {sk_supplier}: "
                        f"{e.code} {e.read().decode(errors='replace')[:150]}")
            return False
        except Exception as e:
            log.warning(f"Falha no write-back de classificacao do fornecedor {sk_supplier}: {e}")
            return False

    def classification_for_account_code(self, account_code: str) -> tuple[int, int]:
        """Resolve (cost_center_id, chart_account_id) da linha de financial_chart_of_account
        com o `account_code` informado (regra DAM/DUAM: classificacao vem do plano 4.1.06).
        Retorna a classificacao PROPRIA daquela linha (seu cost_center_id + seu chart_account_id,
        que e a PK/id do plano). (0, 0) quando indisponivel/ausente. Cacheado por codigo."""
        cache = getattr(self, "_chart_code_cache", None)
        if cache is None:
            cache = self._chart_code_cache = {}
        if account_code in cache:
            return cache[account_code]

        result = (0, 0)
        if self._available:
            try:
                code = urllib.parse.quote(account_code, safe="")
                req = urllib.request.Request(
                    f"{self.base}/rest/v1/financial_chart_of_account"
                    f"?account_code=eq.{code}&select=chart_account_id,cost_center_id&limit=1",
                    headers=self.headers,
                )
                rows = json.loads(urllib.request.urlopen(req, timeout=10).read())
                if rows:
                    row = rows[0]
                    result = (int(row.get("cost_center_id") or 0),
                              int(row.get("chart_account_id") or 0))
            except Exception as e:
                log.warning(f"Falha ao resolver classificacao do plano {account_code!r}: {e}")
        cache[account_code] = result
        return result

    def load_known_ids(self) -> set:
        """Carrega todos os message_id de email_control em um set local.

        Substitui N chamadas individuais is_processed() por uma única consulta,
        eliminando a latência por e-mail no loop principal de deduplicação.
        """
        if not self._available:
            return set()
        all_ids, offset, chunk = set(), 0, 1000
        try:
            while True:
                req = urllib.request.Request(
                    f"{self.base}/rest/v1/email_control"
                    f"?select=message_id&limit={chunk}&offset={offset}",
                    headers=self.headers,
                )
                with urllib.request.urlopen(req, timeout=15) as r:
                    rows = json.loads(r.read())
                all_ids.update(row["message_id"] for row in rows if row.get("message_id"))
                if len(rows) < chunk:
                    break
                offset += chunk
            return all_ids
        except Exception as e:
            log.warning(f"Falha ao carregar IDs em lote: {e}")
            return set()

    @staticmethod
    def _derive_status(rec: dict) -> str:
        # email_control.status (CHECK migration 022). Fallback quando process_message
        # nao definiu o status explicitamente (ex.: caminho de excecao).
        if rec.get("notes") and "erro" in str(rec.get("notes", "")).lower():
            return "falha"
        if rec.get("pdf_extracted"):
            return "extraído" if rec.get("has_attachment") else "recebido"
        if rec.get("attachment_saved"):
            return "pendente"
        return "falha"


import urllib.parse  # necessário para quote no is_processed

# ---------------------------------------------------------------------------
# Helpers de decodificação e utilitários
# ---------------------------------------------------------------------------
def decode_str(value: str) -> str:
    if not value: return ""
    parts = decode_header(value)
    result = []
    for part, enc in parts:
        if isinstance(part, bytes):
            try:
                result.append(part.decode(enc or "utf-8", errors="replace"))
            except LookupError:
                # Charset desconhecido (ex: "unknown-8bit") — fallback para latin-1
                result.append(part.decode("latin-1", errors="replace"))
        else:
            result.append(str(part))
    return " ".join(result).strip()


def get_body_text(msg) -> str:
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            cd = str(part.get("Content-Disposition", ""))
            if ct == "text/plain" and "attachment" not in cd:
                charset = part.get_content_charset() or "utf-8"
                try:
                    body += part.get_payload(decode=True).decode(charset, errors="replace")
                except Exception:
                    pass
    else:
        if msg.get_content_type() == "text/plain":
            charset = msg.get_content_charset() or "utf-8"
            try:
                body = msg.get_payload(decode=True).decode(charset, errors="replace")
            except Exception:
                pass
    return body.strip()


def get_body_html(msg) -> str:
    """Extrai a parte HTML do e-mail para busca de links."""
    html = ""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            cd = str(part.get("Content-Disposition", ""))
            if ct == "text/html" and "attachment" not in cd:
                charset = part.get_content_charset() or "utf-8"
                try:
                    html += part.get_payload(decode=True).decode(charset, errors="replace")
                except Exception:
                    pass
    else:
        if msg.get_content_type() == "text/html":
            charset = msg.get_content_charset() or "utf-8"
            try:
                html = msg.get_payload(decode=True).decode(charset, errors="replace")
            except Exception:
                pass
    return html


def _html_to_text(html: str) -> str:
    """Converte HTML em texto plano para a extracao de corpo de e-mails SO-HTML
    (ex.: Correios), onde get_body_text() volta vazio. Remove script/style, troca
    quebras de bloco por '\\n', tira as demais tags, desescapa entidades e colapsa
    espacos — preservando rotulos como 'Fatura nº: 3918439' e 'R$ 1.530,47'."""
    if not html:
        return ""
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", html)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|tr|li|h[1-6]|table)>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_unescape(text)
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


# Remetente (dominio) -> nome de fornecedor conhecido. Usado na extracao de corpo
# quando NAO ha rotulo ("Fornecedor:") nem CNPJ/CPF: para esses remetentes o nome
# real e estavel e o corpo nao o traz. Ex.: Correios envia de
# noreply_componentes@correios.com.br e o corpo so diz "Email Correios".
_SENDER_SUPPLIER_MAP = {"correios.com.br": "Correios"}


def _supplier_from_sender(sender_email: str | None) -> "str | None":
    """Nome de fornecedor conhecido a partir do dominio do remetente, ou None."""
    domain = (sender_email or "").split("@")[-1].lower().strip()
    if not domain:
        return None
    for known, name in _SENDER_SUPPLIER_MAP.items():
        if domain == known or domain.endswith("." + known):
            return name
    return None


# Assunto como ULTIMO recurso para o nome do fornecedor/favorecido.
# E-mails internos de pagamento ("PAGAMENTO BOLETO HYOSUNG 181063-3",
# "PAGAMENTO PIX FULANO") nomeiam o favorecido no assunto, mas o anexo/imagem
# nem sempre traz nome/CNPJ/CPF e o remetente interno (@otimotex/@lebianco) e
# BLOQUEADO como fornecedor (migration 046) — sem este fallback a conta (com
# valor e codigo de barras) era PERDIDA como db_erro. Remove prefixos de
# encaminhamento (ENC:/RES:/RE:/FWD:), as palavras de ACAO de pagamento e a
# cauda de numero de documento, devolvendo o nome do favorecido.
_SUBJECT_FWD_PREFIX_RE = re.compile(
    r"^\s*(?:enc|res|re|fw|fwd|encaminhar|encaminhado)\s*[:.]\s*", re.IGNORECASE)
_SUBJECT_PAYMENT_PREFIX_RE = re.compile(
    r"^(?:\s*(?:pagamento|pagar|pgto|pgmto|boleto|bol|pix|ted|doc|"
    r"transfer[eê]ncia|dep[oó]sito|fatura|guia|t[ií]tulo|cobran[cç]a|"
    r"comprovante|recibo)\b[ \t.:\-/]*)+",
    re.IGNORECASE)
# Cauda de numero de documento ("181063-3", "Nº 12345", "- 998407913").
_SUBJECT_DOCNUM_TAIL_RE = re.compile(
    r"[ \t]*[-–—]?[ \t]*(?:n[º°o.]?\s*)?\d[\d.\-/_]*\s*$", re.IGNORECASE)

# Siglas de razao social brasileira. Servem de ANCORA para achar o nome do
# fornecedor no assunto quando a extracao nao trouxe nome/CNPJ/CPF: a razao social
# quase sempre TERMINA numa dessas formas (o usuario pediu LTDA explicitamente; as
# demais sao formas societarias comuns). Casam como palavra inteira, sem acento/caixa.
# 'ME'/'SA' isolados (sem separador) ficam de fora — ruidosos demais.
_LEGAL_SUFFIX_RE = re.compile(
    r"\b(?:ltda|eireli|epp|mei)\b\.?"   # LTDA / EIRELI / EPP / MEI (+ ponto opcional)
    r"|\bs\s*[./]\s*a\b\.?",            # S/A, S.A, S.A. (formas com separador)
    re.IGNORECASE)
# Separadores que quebram o assunto em segmentos — o nome esta no segmento da sigla
# (o prefixo "FATURAMENTO --" / "ENC:" fica em outro segmento). Hifen SIMPLES nao
# separa (nomes usam hifen); virgula tambem nao (pode compor razao social).
_SUBJECT_SEGMENT_SPLIT_RE = re.compile(r"\s*(?:-{2,}|[–—|:])\s*")
# Ruido de assunto de faturamento/cobranca removido do inicio do nome quando ele
# NAO foi isolado por um separador ("FATURAMENTO ACME LTDA" -> "ACME LTDA").
_SUBJECT_NOISE_PREFIX_RE = re.compile(
    r"^(?:\s*(?:faturamento|faturas|financeiro|cobran[cç]a)\b[ \t.:\-/]*)+",
    re.IGNORECASE)


def _norm_term(s: str | None) -> str:
    """Normaliza (NFD strip de acentos + lowercase) para comparar termos."""
    return unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()


# Termos que NUNCA sao fornecedor — TIPOS DE DOCUMENTO + TIPOS DE PAGAMENTO (e os
# acronimos de tributo). Um e-mail interno "ENC: GUIA GNRE" reduzia para "GNRE"
# (um tipo de documento) e virava fornecedor — errado. A lista espelha o CHECK de
# document_type (+ keywords de tributo de WORD_KEYWORDS / _DOC_TYPE_NORM) e os
# PAYMENT_METHODS do @sheild/shared. Tudo normalizado (sem acento, minusculo).
_NON_SUPPLIER_TERMS = frozenset(_norm_term(t) for t in {
    # tipos de documento (CHECK + sinonimos de extracao)
    "boleto", "cte", "ct-e", "nfe", "nf-e", "nfse", "nfs-e", "nota fiscal",
    "tributo", "seguro", "recibo", "contrato", "fatura", "fechamento",
    "cobranca", "cobrança", "outro", "outros", "honorario", "honorarios",
    "honorário", "honorários", "container", "conteiner", "contêiner",
    "conhecimento de transporte", "dacte", "guia", "cambio", "câmbio",
    "conta de agua", "conta de água", "conta de luz",
    "conta de telefone", "internet", "conta de telefone / internet",
    # acronimos de tributo / guias
    "darf", "gps", "das", "simples nacional", "simei", "gru", "dae", "dare",
    "gnre", "ipva", "iptu", "dam", "duam", "dam / duam", "iss", "itbi", "gare",
    "multa", "penalidade",
    # tipos de pagamento (PAYMENT_METHODS)
    "pix", "ted", "doc", "cartao", "cartão", "deposito", "depósito",
    "duplicata", "bancario", "bancário", "carteira", "vale", "credito",
    "crédito", "debito", "débito", "dinheiro", "transferencia", "transferência",
    "cheque",
})


def _is_non_supplier_term(name: str | None) -> bool:
    """True quando `name` E, no todo, um tipo de documento/pagamento (ex.: 'GNRE',
    'Boleto', 'PIX', 'DARF SP') — robustez para nao cadastrar um TIPO como
    fornecedor. NAO rejeita nomes que apenas CONTÊM a palavra ('Porto Seguro',
    'Vale Fertilizantes' permanecem fornecedores validos)."""
    n = re.sub(r"\s+", " ", _norm_term(name)).strip(" .-/")
    if not n:
        return False
    if n in _NON_SUPPLIER_TERMS:
        return True
    # acronimo isolado + ruido (UF de 2 letras / numero solto): "gnre mg", "darf sp".
    core = [t for t in re.split(r"[\s/]+", n) if t and not t.isdigit() and len(t) > 2]
    return len(core) == 1 and core[0] in _NON_SUPPLIER_TERMS


# Tipos de documento que sao IMPOSTO/tributo (guia de arrecadacao). Lista definida
# com o usuario. Para esses, quando a extracao NAO traz favorecido real, o credor e o
# orgao arrecadador (Fisco), que a extracao nao captura — a conta e lancada sob a
# OTIMOTEX (a empresa pagadora). Ver _finalize_supplier. NAO inclui 'gps' (INSS) por
# decisao do usuario; 'multa' tambem fica de fora (pode ter fornecedor proprio).
_TAX_DOCUMENT_TYPES = frozenset({
    "darf", "das", "gru", "dae", "dare", "gnre", "ipva", "iptu",
    "dam", "duam", "dam / duam", "iss", "itbi", "gare", "tributo",
})

# sk_supplier (= supplier_id) da OTIMOTEX, a propria empresa pagadora (constante do
# sistema). Guias de imposto sem favorecido identificavel sao lancadas sob a OTIMOTEX.
OTIMOTEX_SK_SUPPLIER = 1

# Fornecedores EXCLUIDOS da classificacao contabil TRIBUTARIA deterministica. Ex.: "Dr. Ricardo"
# (sk 1262) e um despachante — suas contas sao REEMBOLSO de tributos, honorarios e outros tipos
# JURIDICOS (Juridico/Reembolsos), NUNCA conta fiscal/tributaria pura, ainda que o documento seja
# uma guia de arrecadacao (Junta Comercial etc.). Para esses, a regra tributaria NAO forca —
# preserva o default do fornecedor / o valor da extracao. Ver memoria dr-ricardo-reembolso.
TAX_CLASSIFICATION_EXCLUDED_SK_SUPPLIERS = frozenset({1262})


def _is_tax_document(document_type: str | None) -> bool:
    """True quando o document_type e uma guia de IMPOSTO/tributo (darf/das/gnre/...)."""
    return _norm_term(document_type) in _TAX_DOCUMENT_TYPES


def _supplier_name_by_legal_suffix(subject: str | None) -> str:
    """Deriva o nome do fornecedor do ASSUNTO ancorando na SIGLA de razao social
    (LTDA/EIRELI/EPP/MEI/S.A.). A sigla — LTDA em especial — quase sempre faz parte
    do nome do fornecedor, entao serve de ancora confiavel quando a extracao nao
    trouxe nome/CNPJ/CPF do favorecido. Toma o SEGMENTO do assunto que termina na
    sigla, descartando prefixos ("FATURAMENTO --", "ENC:", "PAGAMENTO") e a cauda de
    data/numero apos a sigla. Ex.:
      "ENC: FATURAMENTO -- MOVVI LOGISTICA LTDA 03/07/2026" -> "MOVVI LOGISTICA LTDA"
      "PAGAMENTO ACME COMERCIO S/A - 12345"                 -> "ACME COMERCIO S/A"
    Retorna '' quando nao ha sigla ou o nome resultante e curto/invalido."""
    if not subject:
        return ""
    s = " ".join(str(subject).split())
    m = None
    for m in _LEGAL_SUFFIX_RE.finditer(s):
        pass  # fica com a ULTIMA ocorrencia da sigla no assunto
    if m is None:
        return ""
    head = s[:m.end()]                                   # descarta data/numero apos a sigla
    segment = _SUBJECT_SEGMENT_SPLIT_RE.split(head)[-1]  # nome esta no ultimo segmento
    segment = _SUBJECT_FWD_PREFIX_RE.sub("", segment)    # ENC:/RE: no mesmo segmento
    segment = _SUBJECT_PAYMENT_PREFIX_RE.sub("", segment)  # PAGAMENTO/BOLETO/FATURA inicial
    segment = _SUBJECT_NOISE_PREFIX_RE.sub("", segment)  # FATURAMENTO/FINANCEIRO inicial
    segment = segment.strip(" -–—:.\t")
    if len(segment) < 4 or not re.search(r"[A-Za-zÀ-ÿ]", segment):
        return ""
    return segment


def _supplier_name_from_subject(subject: str | None) -> str:
    """Deriva um nome de fornecedor/favorecido do ASSUNTO (ultimo recurso).

    Retorna '' quando o assunto nao rende um nome utilizavel (vazio, so numeros,
    curto demais OU um TIPO DE DOCUMENTO/PAGAMENTO — ex.: 'GNRE', 'BOLETO').
    Conservador de proposito — so deve ser usado quando a extracao NAO trouxe
    nome/CNPJ/CPF do fornecedor. Ex.:
      "PAGAMENTO BOLETO HYOSUNG 181063-3"        -> "HYOSUNG"
      "ENC: PAGAMENTO PIX SORTEIO BLUSAS - JOAO" -> "SORTEIO BLUSAS - JOAO"
      "FATURAMENTO -- MOVVI LOGISTICA LTDA"      -> "MOVVI LOGISTICA LTDA" (ancora LTDA)
      "ENC: GUIA GNRE"                           -> ""  (tipo de documento)
    """
    if not subject:
        return ""
    # Preferencia: ancorar na SIGLA de razao social (LTDA/EIRELI/S.A./...), que quase
    # sempre nomeia o fornecedor real — nome mais limpo/assertivo que a heuristica
    # generica ("FATURAMENTO -- MOVVI LOGISTICA LTDA" -> "MOVVI LOGISTICA LTDA",
    # descartando o prefixo "FATURAMENTO --").
    by_suffix = _supplier_name_by_legal_suffix(subject)
    if by_suffix and not _is_non_supplier_term(by_suffix):
        return by_suffix
    s = " ".join(str(subject).split())  # colapsa espacos e quebras de linha
    # remove prefixos de encaminhamento repetidos (ENC: RES: RE: FWD:)
    prev = None
    while prev != s:
        prev = s
        s = _SUBJECT_FWD_PREFIX_RE.sub("", s)
    s = _SUBJECT_PAYMENT_PREFIX_RE.sub("", s).strip()
    s = _SUBJECT_DOCNUM_TAIL_RE.sub("", s).strip(" -–—:.\t")
    # precisa restar pelo menos uma LETRA e tamanho minimo (evita "12345", "-")
    if len(s) < 3 or not re.search(r"[A-Za-zÀ-ÿ]", s):
        return ""
    # robustez: um tipo de documento/pagamento nao e fornecedor (ex.: "GNRE").
    if _is_non_supplier_term(s):
        return ""
    return s


def safe_filename(text: str, max_len: int = 40) -> str:
    # Remove acentos e caracteres nao-ASCII (ex.: º, ª, ç, ã). O nome vira a
    # chave do objeto no Supabase Storage, que rejeita chaves com esses
    # caracteres (erro InvalidKey) — e tambem o source_file gravado no banco,
    # entao disco, source_file e Storage ficam consistentes.
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    text = re.sub(r"[^\w\s-]", "", text)   # agora ASCII: mantem [A-Za-z0-9_], espaco, hifen
    text = re.sub(r"\s+", "_", text.strip())
    return text[:max_len]


# Acronimos de guias/tributos + cambio: casam como PALAVRA inteira (fronteira
# \b), nao substring — evita falsos positivos ('das' em 'cadastro'/'vendas',
# 'iss' em 'emissao', 'gru' em 'grupo', 'cambio' em 'intercambio'). A comparacao
# remove acentos e baixa a caixa, entao a chave 'cambio' casa 'cambio'/'câmbio'/
# 'CÂMBIO' e a forma gramatical correta 'câmbio' fica gravada como keyword.
WORD_KEYWORDS = frozenset({
    "darf", "das", "dae", "dare", "dam", "duam", "gps", "gru", "gnre", "gare",
    "ipva", "iptu", "iss", "itbi", "cambio",
})

# Termos de NF-e/NFS-e no assunto. Um e-mail "puro" de NF-e (so notificacao de
# documento fiscal, sem indicio de pagavel) que nao gera conta vira 'ignorado'.
NFE_SUBJECT_TERMS = ("notas fiscais", "nota fiscal", "nfe", "nf-e", "nfse", "nfs-e")

# Indicios de que o e-mail traz algo PAGAVEL. Se aparecerem junto da NF-e no
# assunto (ex.: 'Boleto e NFS-e', 'NFSe e FATURA'), NAO classificar como
# 'ignorado' — pode ser um boleto/fatura cuja extracao falhou e precisa revisao.
PAYABLE_HINT_TERMS = ("boleto", "fatura", "cobranca", "guia", "pix", "duplicata",
                      "vencimento", "vencer", "pagar", "darf", "das", "dae",
                      "dare", "dam", "duam", "gps", "gru", "gnre", "gare", "ipva",
                      "iptu", "iss", "itbi", "tributo", "imposto", "taxa", "multa")


def _strip_accents_lower(s: str) -> str:
    """NFD + drop non-ASCII + lower — base da comparacao de keyword (sem acento)."""
    return unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()


def _has_word(s_norm: str, term_norm: str) -> bool:
    """True se term_norm aparece como PALAVRA inteira em s_norm (ambos ja sem acento)."""
    return bool(term_norm) and re.search(rf"\b{re.escape(term_norm)}\b", s_norm) is not None


def match_keyword(subject: str, keywords: list) -> str | None:
    """Retorna a keyword casada (forma original) ou None. Comparacao sem acento;
    acronimos de tributo/cambio (WORD_KEYWORDS) exigem palavra inteira, o resto
    e substring."""
    s = _strip_accents_lower(subject)
    for kw in keywords:
        kw_norm = _strip_accents_lower(kw)
        if not kw_norm:
            continue
        if kw_norm in WORD_KEYWORDS:
            if re.search(rf"\b{re.escape(kw_norm)}\b", s):
                return kw
        elif kw_norm in s:
            return kw
    return None


def subject_is_pure_nfe(subject: str) -> bool:
    """True se o assunto e de NF-e/NFS-e SEM nenhum indicio de pagavel — usado
    para classificar como 'ignorado' quando nenhuma conta a pagar e gerada.

    Os termos casam por PALAVRA inteira: 'nfe' como substring casaria 'co-nfe-ccoes'
    (CONFECCOES), classificando erroneamente um aviso de transporte como NF-e pura.
    """
    s = _strip_accents_lower(subject)
    has_nfe = any(_has_word(s, _strip_accents_lower(t)) for t in NFE_SUBJECT_TERMS)
    if not has_nfe:
        return False
    return not any(_has_word(s, _strip_accents_lower(t)) for t in PAYABLE_HINT_TERMS)


# Termos de NOTIFICACAO: e-mails de aviso/confirmacao que, SEM anexo e SEM conta
# no corpo (i.e., nenhuma conta a pagar gerada), sao 'ignorado' em vez de 'falha'
# — sao notificacoes, nao contas a pagar. Diferente do PAYABLE_HINT do pure_nfe:
# aqui NAO ha exclusao por boleto/fatura, porque o gatilho ja exige ausencia de
# anexo/conta — se nao veio anexo nem dado no corpo, e so um aviso.
#   - palavra inteira (curtos/sigla): evita casar dentro de outras palavras.
#   - frase (substring): expressoes inequivocas de notificacao.
NOTIFICATION_WORD_TERMS = frozenset({
    "nfe", "nf-e", "informe", "sieg",
    # CT-e/transporte: documento FISCAL. A notificacao de disponibilizacao de CT-e
    # (ou aviso de OCORRENCIA de entrega) SEM boleto anexo/no corpo nao e conta a
    # pagar — vira 'ignorado'. Um boleto de transporte real gera conta ANTES (o
    # 'notification' e o ultimo criterio), entao nao e escondido por estes termos.
    "cte", "ct-e", "dacte",
})
NOTIFICATION_PHRASE_TERMS = (
    "informativo", "confirmado o pagamento", "confirmado pagamento",
    "confirmacao de pagamento", "confirmacao do pagamento", "pagamento confirmado",
    "pagamento processado", "aviso de vencimento",
    "titulo a vencer", "lembrete de vencimento", "titulos proximos do vencimento",
    "comprovante de pix", "protesto", "protestado", "cartorio", "comunicado",
    # Aviso/lembrete de fatura a vencer (ex.: transitobrasil "Aviso de fatura a
    # vencer") — e so um AVISO, nao a cobranca em si; sem anexo/conta → 'ignorado'.
    "fatura a vencer", "aviso de fatura",
    # Notificacao de disponibilizacao de CT-e (SSW/transportadora) sem boleto.
    "conhecimento de transporte",
)


def subject_is_ignorable_notification(subject: str) -> bool:
    """True se o assunto e de uma NOTIFICACAO (aviso/confirmacao/informe/SIEG/NF-e)
    que, sem anexo e sem conta no corpo, deve virar 'ignorado' em vez de 'falha'."""
    s = _strip_accents_lower(subject)
    if any(_has_word(s, t) for t in NOTIFICATION_WORD_TERMS):
        return True
    return any(_strip_accents_lower(t) in s for t in NOTIFICATION_PHRASE_TERMS)


# Confirmacao/comprovante de PAGAMENTO — o pagamento JA foi realizado, logo o e-mail NAO
# e conta a pagar e deve ser IGNORADO sempre (mesmo com keyword no assunto). Regex sobre o
# assunto sem acento. Diferente de NOTIFICATION_PHRASE_TERMS (que so vira 'ignorado' na
# ausencia de anexo/conta): aqui o e-mail e ignorado ANTES de baixar/extrair. O conector
# opcional (foi/ja) cobre "pagamento FOI processado"; o participio no PASSADO
# (confirmado/efetuado/…) evita casar "REALIZAR pagamento"/"pagamento A realizar" (conta a
# pagar). "confirmacao de/do pagamento" e "comprovante de pagamento/pix" sao inequivocos.
_PAYMENT_CONFIRMATION_RE = re.compile(
    r"confirmac[ao]{2} (de|do) pagamento"
    r"|comprovante (de )?(pagamento|pix|transferencia|deposito)"
    r"|confirmado o? ?pagamento"
    r"|pagamento (foi |ja |ja foi )?(confirmado|processado|efetuado|realizado|aprovado|recebido)"
)


def subject_is_payment_confirmation(subject: str) -> bool:
    """True se o assunto e de uma CONFIRMACAO/COMPROVANTE de pagamento (pagamento JA
    realizado). Esses e-mails NUNCA sao conta a pagar — devem ser ignorados sempre, mesmo
    com keyword financeira no assunto. Comparacao sem acento."""
    return bool(_PAYMENT_CONFIRMATION_RE.search(_strip_accents_lower(subject)))


# LEMBRETE — e-mail cujo ASSUNTO traz a palavra "lembrete" e um AVISO/lembrete, nao a cobranca em
# si. Decisao do usuario: existindo "lembrete" no assunto, ignorar SEMPRE (antes de baixar/extrair,
# mesmo com keyword/anexo). O foco e a palavra "lembrete": "vencimento" sozinho pode ser um boleto
# REAL ("Boleto vencimento 10/07"), entao NAO entra na condicao. Cobre "Lembrete de vencimento" e o
# caso real "Lembrete de Pagamento: vencimento DD/MM" (boleto@smartwebservices). Substring (sem
# acento) — pega o plural "lembretes"; "lembrete" nao e substring de outra palavra comum.


def subject_is_reminder(subject: str) -> bool:
    """True se o assunto contem a palavra 'lembrete' — e um lembrete/aviso, nao conta a pagar;
    ignorado SEMPRE (decisao do usuario)."""
    return "lembrete" in _strip_accents_lower(subject)


# Remetentes de SISTEMA (NDR/bounce/aviso de servidor) — nunca sao conta a pagar.
# Match pelo local-part (antes do @), case-insensitive, em QUALQUER dominio.
IGNORED_SENDER_LOCALPARTS = {"postmaster"}


def is_ignored_sender(sender_email: str | None) -> bool:
    """True se o remetente e um endereco de SISTEMA (ex.: postmaster@) cuja
    mensagem (NDR/bounce/aviso de entrega) deve virar 'ignorado' sem baixar nem
    extrair — MESMO que o assunto case uma keyword financeira."""
    local = (sender_email or "").split("@")[0].strip().lower()
    return local in IGNORED_SENDER_LOCALPARTS


def append_log_csv(record: dict):
    """Fallback local: acrescenta registro no CSV. Falhas são logadas e ignoradas."""
    try:
        write_header = not EMAILS_LOG.exists()
        with open(EMAILS_LOG, "a", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=LOG_COLUMNS, delimiter=";",
                               extrasaction="ignore")
            if write_header:
                w.writeheader()
            w.writerow(record)
    except Exception as e:
        log.warning(f"Falha ao gravar log CSV local: {e}")


# ---------------------------------------------------------------------------
# Gravacao da conta extraida em financial_account_control
# ---------------------------------------------------------------------------
# Colunas geradas pelo extract_pdf.py (na mesma ordem do CSV de saida).
FINANCIAL_FIELDS = [
    "source_file", "document_type", "extraction_source",
    "supplier_name", "supplier_cnpj", "supplier_cpf", "invoice_number",
    "competence_date", "due_date", "issue_date",
    "amount", "currency", "payment_method",
    "barcode", "description", "status",
    "nosso_numero", "discount", "other_deductions",
    "fine_interest", "other_additions", "amount_charged",
    "payer_name", "payer_cnpj",
    "processing_notes", "extracted_at",
]

# Campos de valor do boleto: em branco -> 0 (regra de negocio).
FINANCIAL_VALUE_FIELDS = [
    "discount", "other_deductions", "fine_interest",
    "other_additions", "amount_charged",
]

# Tipos de documento que NAO geram conta a pagar.
# Valores em lowercase — comparados com dtype.lower() em extract_and_store_accounts().
SKIP_ACCOUNT_TYPES = ("nfe", "nfse")


def _none_if_blank(value):
    """Normaliza vazios do CSV ('', 'None', 'nan') para None."""
    if value is None:
        return None
    s = str(value).strip()
    return None if s == "" or s.lower() in ("none", "nan", "null") else s


def read_extracted_rows(csv_path: str) -> list:
    """Le as linhas de um CSV gerado pelo extract_pdf.py (utf-8-sig, sep ';')."""
    try:
        with open(csv_path, encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f, delimiter=";"))
    except Exception as e:
        log.warning(f"Falha ao ler CSV de extracao {csv_path}: {e}")
        return []


def build_financial_payload(row: dict, gmail_message_id: str,
                            received_at: str | None = None,
                            subject: str | None = None) -> dict:
    """Converte uma linha do CSV de extracao em payload para financial_account_control.

    Sanitiza os campos com restricao no schema (CHAR(14) do CNPJ e
    NUMERIC do amount) para evitar rejeicao do INSERT. A situacao de vencimento
    NAO e calculada aqui — a trigger grava em `status` no banco (migration 034).
    Aplica os mesmos fallbacks do caminho de corpo: emissao->data do e-mail
    (received_at); vencimento->emissao; numero->"{tipo}_{ddmmyy}".

    Conta de concessionaria (agua/luz/telefone-internet) e classificada pelo ASSUNTO
    do e-mail com precedencia maxima (o extract_pdf.py e cego ao assunto), antes do
    fallback de invoice_number para o tipo entrar no numero sintetico.
    """
    payload = {f: _none_if_blank(row.get(f)) for f in FINANCIAL_FIELDS}

    # CNPJ: CHAR(14) — exatamente 14 digitos
    cnpj = re.sub(r"\D", "", payload.get("supplier_cnpj") or "")
    payload["supplier_cnpj"] = cnpj if len(cnpj) == 14 else None

    pcnpj = re.sub(r"\D", "", payload.get("payer_cnpj") or "")
    payload["payer_cnpj"] = pcnpj if len(pcnpj) == 14 else None

    # CPF: CHAR(11) — exatamente 11 digitos
    cpf = re.sub(r"\D", "", payload.get("supplier_cpf") or "")
    payload["supplier_cpf"] = cpf if len(cpf) == 11 else None

    # amount NUMERIC(15,2): garante numero ou None
    payload["amount"] = _to_decimal(payload.get("amount"), None)

    # Campos de valor do boleto: em branco -> 0 (NOT NULL DEFAULT 0 no banco)
    for vf in FINANCIAL_VALUE_FIELDS:
        payload[vf] = _to_decimal(payload.get(vf), 0)

    # Emissão ausente → data do e-mail (received_at).
    if not payload.get("issue_date") and received_at:
        payload["issue_date"] = received_at[:10]

    # Vencimento ausente (ex.: CT-e/DACTE não traz vencimento) → emissão; sem
    # emissão, a data de hoje.
    if not payload.get("due_date"):
        payload["due_date"] = payload.get("issue_date") or datetime.now().strftime("%Y-%m-%d")

    # Conta de concessionária pelo assunto ou pela marca no nome do fornecedor
    # (precedência máxima) — antes do fallback de invoice abaixo, para o nº sintético
    # usar o tipo correto.
    utility = (_classify_utility_doc_type(subject)
               or _classify_utility_by_supplier(payload.get("supplier_name")))
    if utility:
        payload["document_type"] = utility
    else:
        # Guia tributária pelo ACRÔNIMO no assunto (DARE/GARE/GNRE/DARF…) sobrepõe a
        # classificação do PDF — guias estaduais são quase idênticas e o Claude troca
        # uma pela outra; o assunto traz o tipo que o remetente declarou.
        tax_subject = _classify_tax_doc_type_from_subject(subject)
        if tax_subject:
            payload["document_type"] = tax_subject

    # Boleto de TRANSPORTE (contexto cte/transporte/transportadora ou fornecedor de
    # transporte) → document_type='cte' (regra 4). Abaixo de utility/tax (uma
    # transportadora que manda um DARF continua DARF), acima de 'boleto'. Antes do
    # nº sintético para o prefixo usar 'cte'.
    payload["document_type"] = _apply_transport_boleto_doc_type(
        payload.get("document_type"), subject, payload.get("supplier_name"),
        payload.get("barcode"))

    # Cartório (contexto "cartorio" no assunto/fornecedor) → document_type='cartório'.
    # Abaixo de utility/tax/transporte; só re-rotula tipos genéricos. Antes do nº
    # sintético para o prefixo usar 'cartório'.
    payload["document_type"] = _apply_cartorio_doc_type(
        payload.get("document_type"), subject, payload.get("supplier_name"))

    # Nº documento em branco → sintético (pagamento PIX + tipo 'outro': 'pix_' + valor;
    # demais: tipo+vencimento) — mesma regra do corpo.
    if not payload.get("invoice_number"):
        synthetic = _synthetic_invoice_number(
            payload.get("document_type"), payload.get("amount"),
            payload.get("due_date") or payload.get("issue_date"),
            payload.get("payment_method"))
        if synthetic:
            payload["invoice_number"] = synthetic

    # Honorários: PIX por padrão, EXCETO quando há código de barras / linha digitável
    # de boleto válido — aí paga-se como boleto (honorário emitido em boleto). Boleto
    # vence a regra do PIX; a chave NF-e/CT-e de 44 dígitos não casa (segue pix).
    if (payload.get("document_type") or "").lower() == "honorários":
        payload["payment_method"] = (
            "boleto" if _is_boleto_barcode(payload.get("barcode")) else "pix")

    payload["currency"] = payload.get("currency") or "BRL"
    payload["status"]   = payload.get("status") or "pendente"
    payload["gmail_message_id"] = gmail_message_id
    return payload


def _resolve_supplier_by_payer(ctrl: "SupabaseControl", payload: dict) -> int | None:
    """ULTIMO RECURSO: usa o PAGADOR (payer_name/payer_cnpj — ex.: OTIMOTEX) como
    fornecedor, apenas quando TODAS as outras formas (nome/CNPJ/CPF/e-mail/assunto)
    falharam e o pagador esta claro. Garante que a conta a pagar nunca se perca por
    falta de fornecedor identificavel; o operador reclassifica depois em /consulta.

    Retorna sk_supplier ou None (pagador ausente/indefinido)."""
    payer_name = (payload.get("payer_name") or "").strip()
    payer_cnpj = re.sub(r"\D", "", str(payload.get("payer_cnpj") or ""))
    # filtro de robustez: nome do pagador nunca pode ser um tipo de documento/pagamento.
    if _is_non_supplier_term(payer_name):
        payer_name = ""
    if not payer_name and len(payer_cnpj) != 14:
        return None  # pagador nao esta claro — nao inventa fornecedor
    probe = dict(payload)
    probe["supplier_name"] = payer_name or None
    probe["supplier_cnpj"] = payer_cnpj if len(payer_cnpj) == 14 else None
    probe["supplier_cpf"]  = None
    sk = ctrl.resolve_supplier(probe)
    if sk:
        log.info(f"    [FORNECEDOR-PAGADOR] fornecedor ausente — usando o pagador: "
                 f"{(payer_name or payer_cnpj)!r}")
    return sk


def _finalize_supplier(ctrl: "SupabaseControl", payload: dict) -> bool:
    """Resolve o fornecedor (RPC), grava payload['sk_supplier'] e REMOVE as colunas
    denormalizadas supplier_name/supplier_cnpj/supplier_cpf — o fornecedor passa a
    ser referenciado APENAS pela FK sk_supplier (fonte de verdade: tabela supplier).

    Deve ser chamado APOS a validacao 'sem_fornecedor' (que usa os campos brutos
    extraidos) e ANTES de find_financial_duplicate (a dedup casa por sk_supplier).
    Retorna False quando a resolucao falha (chamador trata como erro de gravacao).

    Ordem de fallback (cada um so quando o anterior esgota):
      1. nome/CNPJ/CPF EXTRAIDOS (descartando o nome que for um TIPO de
         documento/pagamento — robustez: 'GNRE'/'BOLETO' nao e fornecedor);
      2. nome derivado do ASSUNTO (idem filtro de tipo) — e-mail interno de
         pagamento ("PAGAMENTO BOLETO HYOSUNG 181063-3") nomeia o favorecido;
      3. e-mail do remetente (nao interno) — dentro da RPC resolve_supplier;
      4. ULTIMO RECURSO: o PAGADOR (payer_name/payer_cnpj, ex.: OTIMOTEX) — so
         quando TODAS as formas acima falham e o pagador esta claro; garante que a
         conta a pagar nunca se perca e fique rastreavel pelo pagador."""
    # robustez: um TIPO de documento/pagamento extraido como "fornecedor" e descartado.
    if _is_non_supplier_term(payload.get("supplier_name")):
        payload.pop("supplier_name", None)
    # O CNPJ da PROPRIA empresa pagadora (OTIMOTEX) NAO e o fornecedor. E-mails de
    # faturamento reencaminhados trazem o bloco do destinatario ("TEXTIL E CONF.OTIMOTEX
    # / CNPJ: 47273917/0001-23") e a extracao capturava esse CNPJ como se fosse do
    # fornecedor, gravando a conta sob a OTIMOTEX (sk=1) — quando o favorecido real esta
    # nomeado no assunto (ex.: "MOVVI LOGISTICA LTDA"). Descarta o CNPJ do pagador para
    # que a resolucao siga pelo nome/assunto (a sigla LTDA no assunto costuma nomear o
    # fornecedor real). Nao afeta a regra de imposto nem o fallback de pagador, que
    # gravam OTIMOTEX explicitamente quando NAO ha favorecido.
    own_cnpj = ctrl.company_cnpj() if hasattr(ctrl, "company_cnpj") else None
    if own_cnpj:
        extracted_cnpj = re.sub(r"\D", "", str(payload.get("supplier_cnpj") or ""))
        if extracted_cnpj and extracted_cnpj == own_cnpj:
            payload.pop("supplier_cnpj", None)
            log.info("    [FORNECEDOR] CNPJ do pagador (OTIMOTEX) ignorado como "
                     "fornecedor — segue pelo nome/assunto")
    has_real_supplier = any(str(payload.get(k) or "").strip()
                            for k in ("supplier_name", "supplier_cnpj", "supplier_cpf"))
    # Regra de IMPOSTO: guia de tributo (darf/das/gnre/gare/dare/iss/...) SEM favorecido
    # real extraido do documento — o credor e o orgao arrecadador (Fisco), que a
    # extracao nao captura. Lanca sob a OTIMOTEX (a empresa pagadora) em vez de derivar
    # um "fornecedor" generico do assunto (ex.: "IMPOSTOS", "GNRE -PAGAMENTO", "DARE -
    # REF"). Curto-circuita os fallbacks de assunto e pagador. Favorecido real extraido
    # (ex.: "PREFEITURA DE SP") NAO dispara a regra e e preservado.
    if not has_real_supplier and _is_tax_document(payload.get("document_type")):
        for col in ("supplier_name", "supplier_cnpj", "supplier_cpf"):
            payload.pop(col, None)
        payload["sk_supplier"] = OTIMOTEX_SK_SUPPLIER
        log.info("    [FORNECEDOR-IMPOSTO] guia de tributo sem favorecido — "
                 f"gravando OTIMOTEX (sk={OTIMOTEX_SK_SUPPLIER})")
        cost_center_id, chart_account_id = ctrl.supplier_defaults(OTIMOTEX_SK_SUPPLIER)
        if cost_center_id:
            payload["cost_center_id"] = cost_center_id
        if chart_account_id:
            payload["chart_account_id"] = chart_account_id
        return True
    # fallback 2: nome do assunto (tambem filtra tipo de documento/pagamento).
    if not has_real_supplier:
        guessed = _supplier_name_from_subject(payload.get("subject"))
        if guessed:
            payload["supplier_name"] = guessed
            log.info(f"    [FORNECEDOR-ASSUNTO] nome derivado do assunto: {guessed!r}")
    sk_supplier = ctrl.resolve_supplier(payload)
    # fallback 4: PAGADOR (ultimo recurso) — esgotaram nome/CNPJ/CPF/e-mail/assunto.
    if not sk_supplier:
        sk_supplier = _resolve_supplier_by_payer(ctrl, payload)
    for col in ("supplier_name", "supplier_cnpj", "supplier_cpf"):
        payload.pop(col, None)
    if not sk_supplier:
        return False
    payload["sk_supplier"] = sk_supplier
    # Default de classificacao contabil do fornecedor (migration 052): a nova conta
    # herda cost_center_id/chart_account_id do supplier quando > 0. Ausentes => a
    # coluna NOT NULL DEFAULT 0 do banco assume 0 (nao enviamos None, que violaria o
    # NOT NULL). So leitura — o write-back (modal) e responsabilidade da Next API.
    cost_center_id, chart_account_id = ctrl.supplier_defaults(sk_supplier)
    if cost_center_id:
        payload["cost_center_id"] = cost_center_id
    if chart_account_id:
        payload["chart_account_id"] = chart_account_id
    return True


def _to_decimal(value, default):
    """Converte texto/numero em float (2 casas) ou retorna default."""
    if value is None:
        return default
    s = str(value).strip().replace(",", ".")
    if s == "" or s.lower() in ("none", "nan", "null"):
        return default
    try:
        return round(float(s), 2)
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# Extracao a partir do corpo do e-mail (sem anexo valido)
# ---------------------------------------------------------------------------
# Pedido informal de pagamento a fornecedor — nome, valor e dados bancarios no
# proprio corpo da mensagem (geralmente PIX), sem PDF anexado. O schema ja
# reserva extraction_source='email_body' para esse caso (migration 001).
#
# Rotulo de fornecedor no inicio de uma linha do corpo. Inclui os termos pedidos
# pelo usuario (fornecedor/responsavel/prestador/nome) + variantes ja usadas.
# O separador ":"/"-" e OPCIONAL (pode vir so um espaco, ex.: "Nome MATEUS ...").
# Para NAO capturar continuacoes de frase ("Responsável pela compra", "Empresa de
# transporte"), o valor deve comecar por LETRA MAIUSCULA ou digito (nome proprio):
# o char class `[A-ZÀ-Þ0-9]` e case-SENSITIVE (so o rotulo e case-insensitive via
# `(?i:...)`); `\b` evita casar o rotulo como prefixo ("Nomeação").
_BODY_NAME_RE    = re.compile(
    r"^[ \t]*"
    r"(?i:fornecedor|favorecido|benefici[aá]rio|cedente|raz[aã]o\s+social|"
    r"empresa|nome|respons[aá]vel|prestador)"
    r"\b[ \t]*[:\-]?[ \t]*([A-ZÀ-Þ0-9][^\r\n]*?)[ \t\r]*$",
    re.MULTILINE,
)
# Valor monetario. Tolera separadores entre "R$" e o numero ("R$:", "R$ -")
# porque varios e-mails internos escrevem "R$:  297,08".
_BODY_AMOUNT_RE  = re.compile(r"R\$\s*[:\-]?\s*([\d.,]+)")
# Valor rotulado como "Total" / "Valor Total" — tem PRECEDENCIA: quando o corpo
# lista parcelas somadas/subtraidas, o total e o valor a pagar (nao a 1a parcela).
_BODY_TOTAL_RE   = re.compile(
    r"(?i)(?:valor\s+)?total\s*[:\-]?\s*R\$\s*[:\-]?\s*([\d.,]+)")
# Valor LIQUIDO / A PAGAR — o montante EFETIVO do documento (apos descontos). Tem
# precedencia MAXIMA (antes de "Total" e da soma). Rotulos que denotam o unico
# valor a pagar, jamais uma parcela. Cobre faturas que REPETEM o mesmo valor em
# varios rotulos (ex.: Rodonaves "Valor da fatura" == "Valor liquido"), que a soma
# das parcelas duplicava; e, quando ha desconto, o liquido e o correto (nao o bruto).
# So os rotulos INEQUIVOCOS do valor final: "liquido" e "a pagar". NAO inclui
# "valor da fatura"/"do documento"/"do boleto" (podem ser o BRUTO, antes de juros)
# — se ha varios rotulos com o MESMO valor, a dedup da soma (regra 2) ja resolve;
# se ha desconto real, so o "liquido"/"a pagar" e a fonte de verdade.
_BODY_NET_RE     = re.compile(
    r"(?i)valor\s+(?:l[ií]quido|a\s+pagar)"
    r"\s*[:\-]?\s*R\$\s*[:\-]?\s*([\d.,]+)")
# Valor ROTULADO sem "R$" (ex.: "Valor 50,00", "Valor: 1.250,00", "Total 304,04",
# "o valor de 172,39"). So usado como FALLBACK quando nao ha nenhum valor com "R$".
# Exige o rotulo (valor/total) E o formato monetario BR com EXATAMENTE 2 casas
# decimais — assim nao captura numeros soltos (quantidades, "NF 1087", datas).
# Tolera um conectivo curto (de/da/do) entre o rotulo e o numero ("valor de 172,39")
# sem casar substring ("valor desconto" nao casa: o numero nao segue o conectivo).
# group(1)=rotulo, group(2)=numero. "Total"/"Valor Total" tem precedencia sobre "Valor".
# Aceita 2-3 casas decimais: o 3º digito e digitacao com zero a mais (ex.: "VALOR:
# 1.799,960" → 1799,96, id 186) — o _brl_to_decimal normaliza. Continua exigindo >=2
# casas (nao captura numero solto/quantidade/"NF 1087").
_BODY_LABELED_AMT_RE = re.compile(
    r"(?i)\b(valor\s+total|total|valor)\b(?:\s+(?:de|da|do))?\s*[:\-]?\s*"
    r"(\d{1,3}(?:\.\d{3})*,\d{2,3}|\d+,\d{2,3})(?!\d)")
# Tabela de boletos/parcelas no corpo: cada título é uma sequência de 6 campos —
# documento, parcela, emissão (data), vencimento (data), valor (R$) e dias — que o
# webmail quebra em linhas separadas (\r). Detecta a OBER e similares. A linha
# "Total R$ ..." NÃO casa (não tem documento/parcela/datas antes). Usada para criar
# UMA conta por boleto — nunca uma conta somada com o total (regra de negócio).
_BODY_INSTALLMENTS_RE = re.compile(
    r"(\d{4,})\s+(\d{1,3})\s+(\d{2}/\d{2}/\d{2,4})\s+(\d{2}/\d{2}/\d{2,4})\s+"
    r"R\$\s*([\d.]*\d,\d{1,2})\s+\d{1,4}")
_BODY_PIX_RE     = re.compile(r"\bpix\b", re.IGNORECASE)
_BODY_DUE_RE     = re.compile(r"(?i)venc(?:imento|to)?\D{0,15}?(\d{2}/\d{2}/\d{2,4})")
# "DATA (PARA/DE/DO) PAGAMENTO: DD/MM/AA" — rotulo de vencimento usado nas notas
# internas de pagamento (ex.: "DATA PARA PAGAMENTO: 22/06/26", id 186). Fallback
# apos "vencimento" e antes de usar a data de emissao/extracao.
_BODY_PAYDATE_RE = re.compile(
    r"(?i)data\s+(?:para|de|do)?\s*pagamento\D{0,10}?(\d{2}/\d{2}/\d{2,4})")
_BODY_ISSUE_RE   = re.compile(r"(?i)emiss[aã]o\D{0,10}?(\d{2}/\d{2}/\d{2,4})")
_BODY_INVOICE_RE = re.compile(r"(?i)\b(?:nf(?:[- ]?e)?|nota\s+fiscal|fatura\s+n[º°.]?)\s*[n°.:]?\s*(\d{3,})")
# Nº de documento rotulado EXPLICITAMENTE como "Número do documento" — valor
# ALFANUMÉRICO (ex.: boleto Sabesp "SOR202659903949", CATAGUASES "014696-001").
# Usado como fallback quando _BODY_INVOICE_RE (NF/fatura + dígitos) não casa.
# Conservador de propósito: só o rótulo "número do documento" (varredura confirmou
# 0 falso positivo; rótulos frouxos como "documento nº" capturavam "Banco").
_BODY_DOCNUM_RE  = re.compile(
    r"(?i)n[uú]mero\s+do\s+documento\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9./-]{3,})")
# ID estável da fatura no link da SIEG (app.sieg.com/faturas?bill=NNN). Sem nº de
# documento no texto, é o identificador que faz os DOIS lembretes da mesma fatura
# ("Vencimento Próximo" + "Hoje") deduplicarem — antes geravam 2 contas/mês porque
# o corpo só tinha data relativa ("vence hoje") → nº fabricado por data divergia.
_BODY_SIEG_BILL_RE = re.compile(r"app\.sieg\.com/faturas\?bill=(\d+)", re.IGNORECASE)
# CNPJ: o "/NNNN-NN" e altamente distintivo — baixo risco de falso positivo.
_BODY_CNPJ_RE    = re.compile(r"\b\d{2}\.?\d{3}\.?\d{3}/\d{4}-?\d{2}\b")
# CPF: so quando rotulado, para nao casar outros numeros de 11 digitos.
_BODY_CPF_RE     = re.compile(r"(?i)cpf\D{0,5}(\d{3}\.?\d{3}\.?\d{3}-?\d{2})")
# Linha digitavel / codigo de barras de boleto (47) ou guia de arrecadacao (48).
_BODY_BARCODE_RE = re.compile(
    r"(?i)(?:linha\s+digit[aá]vel|c[oó]digo\s+de\s+barras)\D{0,10}([\d.\s]{47,60})"
)
# Fallback de nome do fornecedor (sem rotulo e sem CNPJ/CPF), em ordem de confianca:
#   1) "pix/pagar/transferir ... p/|para <Nome>" — destinatario do pagamento.
#   2) Assinatura titulada "Prof./Dr./Sr. <Nome>" — quem prestou o servico.
# Caso classico: honorarios de profissional ("pix p/ Wesley" + "Prof. Wesley S. Paixao").
# Tokens capitalizados (preservam acento); o verbo/rotulo e case-insensitive.
_NAME_TOKEN = r"[A-ZÀ-Ý][A-Za-zÀ-ÿ.'-]+"
_NAME_SEQ   = r"(" + _NAME_TOKEN + r"(?:\s+" + _NAME_TOKEN + r"){0,3})"
_BODY_PAYTO_RE = re.compile(
    r"(?i:\b(?:pix|pag\w*|transfer\w*|dep[oó]sit\w*)\b)[^.\n]{0,15}?"
    r"(?i:p/|\bpra\b|\bpara\b)\s+" + _NAME_SEQ
)
_BODY_SIGN_RE  = re.compile(r"(?i:\b(?:prof|dr|dra|sr|sra)\b)\.?\s+" + _NAME_SEQ)
# Palavras que NAO fazem parte de nome — cortam a captura (evita "Wesley Ref...").
_NAME_STOPWORDS = {
    "ref", "refer", "total", "valor", "obs", "att", "atenciosamente", "hoje",
    "amanha", "favor", "gentileza", "conta", "banco", "ag", "cc", "pix", "obg",
    "obrigado", "obrigada", "desde", "ja", "agradeco",
}

def _clean_person_name(raw: str) -> "str | None":
    """Limpa a captura de nome: corta no primeiro stopword e exige >= 3 chars."""
    out = []
    for tok in (raw or "").split():
        if tok.strip(".,").lower() in _NAME_STOPWORDS:
            break
        out.append(tok)
    name = " ".join(out).strip(" .,")
    return name if len(name) >= 3 else None

def _supplier_from_signals(body_text: str) -> "str | None":
    """Tenta extrair o nome do fornecedor sem rotulo: assinatura titulada
    (mais completa) e, depois, o destinatario do pagamento ('p/ <Nome>')."""
    for rx in (_BODY_SIGN_RE, _BODY_PAYTO_RE):
        m = rx.search(body_text or "")
        if m:
            name = _clean_person_name(m.group(1))
            if name:
                return name
    return None
# Comprovante de pagamento ja feito / "pix recebido" / confirmacao — NAO e conta
# a pagar. Inclui o aviso da SIEG "identificamos o pagamento da fatura" e
# "pagamento processado" (confirma pagamento ja realizado, nao cobra).
_BODY_RECEIPT_RE = re.compile(
    r"(?i)comprovante\s+de\s+(?:pix\s+)?recebido|pix\s+recebido\s+de|"
    r"pagamento\s+(?:recebido|confirmado|processado)|"
    r"identificamos\s+o\s+pagamento"
)
# Sinais de que o e-mail PEDE um pagamento (afasta o falso positivo de comprovante).
_BODY_PAYMENT_REQUEST_RE = re.compile(
    r"(?i)fazer\s+o\s+pagamento|favor\s+pagar|por\s+gentileza|efetuar\s+o\s+pagamento"
)

# Tabela de keywords por tipo de documento — verificada contra o corpo do e-mail.
# Ordem importa: termos mais específicos antes dos fallbacks genéricos.
_BODY_DOC_KEYWORDS: list[tuple[str, list[str]]] = [
    # Notas fiscais (NF-e / NFS-e) — NAO geram conta a pagar (ver SKIP_ACCOUNT_TYPES).
    # Tipos em lowercase para casar com o CHECK de financial_account_control e o skip.
    # Mais específico primeiro: NFS-e (serviço) antes de NF-e (mercadoria).
    ("nfse",       ["nota fiscal de servico", "nota fiscal eletronica de servico",
                    "nota fiscal de servicos eletronica", "nfs-e", "nfse"]),
    ("nfe",        ["nota fiscal eletronica", "danfe", "nf-e", "nfe"]),
    # Honorários (serviços profissionais) — tipo próprio; pagamento sempre PIX.
    ("honorários", ["honorario", "honorarios"]),
    # Container (frete/demurrage/movimentação de contêineres).
    ("container",  ["container", "conteiner"]),
    ("DARF",       ["darf"]),
    ("GPS",        ["guia da previdencia social", "guia previdencia social", "gps"]),
    ("DAS",        ["simples nacional", "das-simples", "das simples",
                    "documento de arrecadacao do simples", "simei"]),
    ("GRU",        ["guia de recolhimento da uniao", "gru"]),
    ("DAE",        ["documento de arrecadacao do esocial", "dae"]),
    ("DARE",       ["documento de arrecadacao de receitas estaduais", "dare"]),
    ("GNRE",       ["guia nacional de recolhimento", "gnre"]),
    ("IPVA",       ["guia de ipva", "ipva"]),
    ("IPTU",       ["guia de iptu", "iptu"]),
    ("DAM / DUAM", ["documento de arrecadacao municipal", "duam"]),
    ("ISS",        ["recolhimento de iss", "guia de iss", "guia iss", "iss a recolher"]),
    ("ITBI",       ["imposto de transmissao", "guia de itbi", "itbi"]),
    ("GARE",       ["gare"]),
    ("tributo",    ["guia de recolhimento", "guia de pagamento",
                    "documento de arrecadacao"]),
    # Multa / penalidade avulsa (auto de infracao, juros/multa isolados).
    ("multa",      ["auto de infracao", "multa", "penalidade"]),
    # Fatura generica (ex.: Correios "Valor da fatura") — fallback antes de 'outro'.
    ("fatura",     ["fatura"]),
]


def _ns_body(s: str) -> str:
    """Strip accents + lowercase — para busca de keywords no corpo do e-mail."""
    return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()


def _classify_body_doc_type(body_text: str) -> str:
    """Detecta o tipo de documento tributário a partir do corpo do e-mail.

    Retorna o primeiro tipo cujo algum termo for encontrado (case-insensitive,
    sem acentos). Retorna 'outro' se nenhum termo corresponder.
    PIX sobrescreve este resultado — tratar no chamador.

    Casa por PALAVRA inteira (_has_word), não substring: 'nfe' como substring
    casaria 'co-nfe-ccoes' (CONFECCOES) e classificaria erroneamente uma FATURA
    como NF-e (que é pulada em SKIP_ACCOUNT_TYPES) — bug real do e-mail da RTE,
    endereçado a "TEXTIL E CONFECCOES". Mesma proteção já usada em subjects.
    """
    text = _ns_body(body_text)
    for doc_type, terms in _BODY_DOC_KEYWORDS:
        if any(_has_word(text, term) for term in terms):
            return doc_type
    return "outro"


# Forma de pagamento DECLARADA no corpo do e-mail. Regra de negocio: o pagador escreve
# como pagou (ex.: "PAGAMENTO EM DINHEIRO", "pago deposito", "pagamento via pix"). Termos
# sem acento (casados por _ns_body) e por PALAVRA inteira (_has_word). O valor a gravar e
# o do enum PAYMENT_METHODS (com acento). Ordem = precedencia: credito/debito ANTES de
# cartao (para "cartao de credito" cair em 'crédito', nao 'cartão'); dinheiro primeiro
# (caso do usuario). PIX e boleto tem tratamento proprio antes (has_pix / codigo de
# barras) — aqui servem so de fallback se aquele ramo nao tiver resolvido.
_BODY_PAYMENT_METHOD_KEYWORDS: list[tuple[str, list[str]]] = [
    ("dinheiro",          ["dinheiro", "especie"]),
    ("pix",               ["pix"]),
    ("depósito",          ["deposito"]),
    # 'débito automático' ANTES de 'débito' (mais específico): "Débito Automático" casa aqui,
    # não no 'débito' genérico (cartão-débito). Ambos são valores próprios do enum.
    ("débito automático", ["debito automatico", "debito em conta"]),
    ("crédito",           ["cartao de credito", "credito"]),
    ("débito",            ["cartao de debito", "debito"]),
    ("cartão",            ["cartao"]),
    ("ted",               ["ted"]),
    ("transferência",     ["transferencia"]),
    ("cheque",            ["cheque"]),
    ("vale",              ["vale", "vale refeicao", "vale transporte", "vale alimentacao"]),
    ("boleto",            ["boleto"]),
    ("duplicata",         ["duplicata"]),
]


def _classify_body_payment_method(*texts: str | None) -> str | None:
    """Detecta a FORMA DE PAGAMENTO declarada no corpo/assunto (ex.: 'PAGAMENTO EM
    DINHEIRO' -> 'dinheiro', 'pago deposito' -> 'depósito'), casando por PALAVRA inteira
    sem acento. Retorna o valor do enum PAYMENT_METHODS (com acento) ou None se nada
    casar. Usado para preencher payment_method quando o ramo principal deixaria 'outro'.

    Precedência POR TEXTO (não por lista): cada texto é avaliado na ordem recebida e o
    primeiro que casar vence — chamando com (body, subject), o CORPO tem precedência sobre
    o ASSUNTO (caso id 325: corpo 'TED AGÊNCIA...' vs assunto 'PAGAMENTO PIX' → 'ted').
    Dentro de um mesmo texto, a ordem de _BODY_PAYMENT_METHOD_KEYWORDS desempata
    (crédito/débito antes de cartão)."""
    for t in texts:
        if not t:
            continue
        norm = _ns_body(t)
        for method, terms in _BODY_PAYMENT_METHOD_KEYWORDS:
            if any(_has_word(norm, term) for term in terms):
                return method
    return None


# Contas de concessionaria — classificadas por FRASE do assunto/corpo (regra de
# negocio). Tem PRECEDENCIA sobre boleto/fatura/PIX: o assunto "PAGAMENTO CONTA DE
# AGUA" define o tipo mesmo que o corpo pareca uma fatura. Termos sem acento (casados
# por _ns_body) e por PALAVRA inteira (_has_word). "vivo"/"fibra" sao termos do
# usuario para o tipo telefone/internet (a marca Vivo / fibra optica).
_UTILITY_DOC_KEYWORDS: list[tuple[str, list[str]]] = [
    ("conta de água", ["conta de agua", "conta agua"]),
    ("conta de luz",  ["conta de luz", "conta luz"]),
    ("conta de telefone / internet",
        ["conta de telefone", "conta telefone", "conta vivo", "vivo conta",
         "conta de internet", "conta internet", "vivo", "fibra"]),
]


def _classify_utility_doc_type(*texts: str | None) -> str | None:
    """Detecta conta de agua/luz/telefone-internet a partir das frases do assunto e/ou
    corpo. Retorna o tipo (primeiro que casar, na ordem da lista) ou None se nenhum."""
    blob = _ns_body(" ".join(t for t in texts if t))
    for doc_type, terms in _UTILITY_DOC_KEYWORDS:
        if any(_has_word(blob, term) for term in terms):
            return doc_type
    return None


# Marcas de concessionaria → tipo, casadas SOMENTE contra o NOME DO FORNECEDOR
# (regra de negocio). Escopo restrito de proposito: "claro"/"tim"/"vivo" sao
# palavras comuns no corpo ("esta claro", "ao vivo"), entao casar no corpo livre
# geraria falso positivo — por isso so o supplier_name alimenta este match.
_UTILITY_SUPPLIER_BRANDS: list[tuple[str, list[str]]] = [
    ("conta de luz",                  ["enel", "eletropaulo"]),
    ("conta de telefone / internet",  ["vivo", "claro", "tim"]),
    ("conta de água",                 ["sabesp"]),
]


def _classify_utility_by_supplier(supplier_name: str | None) -> str | None:
    """Detecta conta de concessionaria pela MARCA no nome do fornecedor (enel/
    eletropaulo→luz; vivo/claro/tim→telefone-internet; sabesp→água). Palavra inteira,
    sem acento. Retorna o tipo ou None."""
    if not supplier_name:
        return None
    blob = _ns_body(supplier_name)
    for doc_type, brands in _UTILITY_SUPPLIER_BRANDS:
        if any(_has_word(blob, brand) for brand in brands):
            return doc_type
    return None


# ---------------------------------------------------------------------------
# Transporte / CT-e — regra de negocio: o CT-e (documento FISCAL de transporte)
# NAO gera conta a pagar; so o BOLETO de frete gera. Um boleto de transporte fica
# rotulado como document_type='cte' (relatorio). Ver regras 1-5 do plano CTe.
# ---------------------------------------------------------------------------
# Termos de transporte no ASSUNTO (frase/sigla), sem acento (casados via _ns_body).
_TRANSPORT_SUBJECT_TERMS = (
    "cte", "ct-e", "dacte", "conhecimento de transporte", "transporte", "transportadora",
)

# Palavras no NOME DO FORNECEDOR que o identificam como transportadora (palavra
# inteira, sem acento). Escopo restrito ao supplier_name — termos como "frete"/
# "cargas" sao comuns; casar no corpo livre geraria falso positivo (mesmo criterio
# de _UTILITY_SUPPLIER_BRANDS).
_TRANSPORT_SUPPLIER_TERMS = (
    "transporte", "transportes", "transportadora", "logistica", "cargas",
    "encomendas", "frete", "fretes",
)


def _is_transport_supplier(supplier_name: str | None) -> bool:
    """True se o nome do fornecedor indica transportadora (transporte(s)/
    transportadora/logistica/cargas/encomendas/frete(s)). Palavra inteira, sem acento."""
    if not supplier_name:
        return False
    blob = _ns_body(supplier_name)
    return any(_has_word(blob, term) for term in _TRANSPORT_SUPPLIER_TERMS)


def _is_transport_context(subject: str | None, supplier_name: str | None,
                          document_type: str | None) -> bool:
    """True se o e-mail/documento e de TRANSPORTE por qualquer uma das fontes:
    assunto com termo de transporte, fornecedor de transporte (nome) ou
    document_type ja classificado como 'cte'. Base da regra: transporte SEM boleto
    e pulado (nao gera conta); boleto DE transporte vira document_type='cte'."""
    if (document_type or "").strip().lower() == "cte":
        return True
    if _is_transport_supplier(supplier_name):
        return True
    if subject:
        s = _ns_body(subject)
        if any(_has_word(s, t) if " " not in t else (t in s)
               for t in _TRANSPORT_SUBJECT_TERMS):
            return True
    return False


# Tipos "genericos" cujo rotulo pode virar 'cte' quando o documento e um BOLETO de
# transporte. NAO inclui guias/utilities (darf/gnre/conta de luz…): uma transportadora
# que manda um DARF continua DARF — o rotulo transporte so vale para o proprio boleto.
_TRANSPORT_RELABELABLE_TYPES = ("boleto", "cte", "outro", "pix", "")


def _apply_transport_boleto_doc_type(document_type: str | None, subject: str | None,
                                     supplier_name: str | None, barcode: str | None) -> str | None:
    """Regra 4: um BOLETO de transporte (contexto cte/transporte/transportadora ou
    fornecedor de transporte) e rotulado como document_type='cte'. So relabela tipos
    genericos (_TRANSPORT_RELABELABLE_TYPES) — guias/utilities sao preservadas. Exige
    codigo de barras de BOLETO valido (chave NF-e/CT-e nao casa). Idempotente."""
    if not _is_boleto_barcode(barcode):
        return document_type
    if (document_type or "").strip().lower() not in _TRANSPORT_RELABELABLE_TYPES:
        return document_type
    if _is_transport_context(subject, supplier_name, document_type):
        return "cte"
    return document_type


# ---------------------------------------------------------------------------
# Cartorio — pagamento DE/EM cartorio (custas de tabelionato/registro/protesto).
# Um boleto/custa de cartorio e rotulado document_type='cartório'. Sinal: a palavra
# "cartorio" (ou tabelionato/tabeliao) no ASSUNTO ou no NOME DO FORNECEDOR — nao no
# corpo livre (mesma cautela do transporte: casar no corpo geraria falso positivo,
# ex.: "reconhecer firma em cartorio" num e-mail de outra cobranca).
# ---------------------------------------------------------------------------
_CARTORIO_TERMS = ("cartorio", "tabelionato", "tabeliao")

# Tipos "genericos" cujo rotulo pode virar 'cartório'. NAO inclui guias/utilities/cte/
# honorarios: um ITBI pago no cartorio continua ITBI (o rotulo cartorio so vale para a
# custa generica que chega como boleto/outro/pix).
_CARTORIO_RELABELABLE_TYPES = ("boleto", "outro", "pix", "")


def _is_cartorio_context(subject: str | None, supplier_name: str | None) -> bool:
    """True se o e-mail/documento e de CARTORIO: palavra "cartorio" (ou tabelionato/
    tabeliao) no assunto OU no nome do fornecedor. Palavra inteira, sem acento
    (_has_word/_ns_body) — evita casar dentro de outra palavra."""
    for text in (subject, supplier_name):
        if text and any(_has_word(_ns_body(text), t) for t in _CARTORIO_TERMS):
            return True
    return False


def _apply_cartorio_doc_type(document_type: str | None, subject: str | None,
                             supplier_name: str | None) -> str | None:
    """Rotula como document_type='cartório' um pagamento de cartorio (contexto
    "cartorio" no assunto/fornecedor). So relabela tipos genericos
    (_CARTORIO_RELABELABLE_TYPES) — guias/utilities/cte/honorarios sao preservadas.
    Idempotente ('cartório' ja nao esta no set de relabelaveis)."""
    if (document_type or "").strip().lower() not in _CARTORIO_RELABELABLE_TYPES:
        return document_type
    if _is_cartorio_context(subject, supplier_name):
        return "cartório"
    return document_type


# ---------------------------------------------------------------------------
# Classificacao contabil FORCADA por tipo/contexto de documento (regra de negocio,
# so na extracao de e-mail). Alguns documentos vao SEMPRE para uma conta contabil fixa,
# independentemente do default do fornecedor; parte deles tambem propaga a classificacao
# ao supplier (write-back). Ver "Classificacao contabil forcada" no CLAUDE.md.
# ---------------------------------------------------------------------------
# Centro de custo / plano de contas do TRANSPORTE (regra NAO-tributaria — CT-e/frete).
CC_LOGISTICA       = 4    # financial_cost_center: LOG — Logistica
CA_TRANSPORTADORAS = 339  # financial_chart_of_account: 48.2.01 — Servicos de Transportadoras

# document_type canonico da GNRE (usado no gatilho @lebianco de ICMS-ST).
GNRE_DOC_TYPE = "gnre"

# ICMS Substituicao Tributaria — frases EXPLICITAS (sem acento, substring). So GNRE com esse
# sinal vira 4.1.02; GNRE so com codigo de receita/protocolo NAO casa (decisao do usuario).
# "subst.tribut"/"subst tribut" cobrem a forma abreviada dos documentos ("ICMS SUBST.TRIBUT").
_ICMS_ST_PHRASES = ("substituicao tributaria", "subst.tribut", "subst tribut",
                    "subst. tribut", "icms st", "icms-st", "icms substituicao")

# Dominio interno cujo setor envia as guias de ICMS-ST. Uma GNRE vinda deste remetente vira
# 4.1.02 mesmo SEM a frase de ST no texto (gatilho adicional ao _ICMS_ST_PHRASES) — decisao
# do usuario. Casa o dominio (e subdominios); as regras FIXAS (ICMS Importacao) tem precedencia.
LEBIANCO_DOMAIN = "lebianco.com.br"


def _is_lebianco_sender(sender_email: str | None) -> bool:
    """True quando o remetente tem dominio lebianco.com.br (ou subdominio)."""
    domain = (sender_email or "").split("@")[-1].lower().strip()
    return domain == LEBIANCO_DOMAIN or domain.endswith("." + LEBIANCO_DOMAIN)

# ICMS de importacao — frases (sem acento, substring). NUNCA casar "icms" sozinho: ICMS/GNRE
# normal nao deve cair aqui — exige o par icms+importacao.
_ICMS_IMPORT_PHRASES = ("icms importacao", "icms de importacao",
                        "icms na importacao", "importacao icms")


# ---------------------------------------------------------------------------
# Relacao TRIBUTARIA -> plano de contas (financial_chart_of_account). ESTRITA e
# EXCLUSIVAMENTE para _is_tax_document. Determina o account_code do plano a partir do
# TIPO/CONTEXTO do imposto (nunca do supplier) e resolve para (cost_center_id,
# chart_account_id) via classification_for_account_code (segue o cadastro). Precedencia
# MAXIMA (vence o default do fornecedor) e write-back True (o supplier e atualizado com o
# mesmo destino — exceto OTIMOTEX/funcionario, barrados em apply_forced_classification).
# ---------------------------------------------------------------------------
# Nivel 2 — por document_type, quando a guia JA determina o imposto (sem palavra-chave).
# GNRE = veiculo de ICMS interestadual -> conta propria "GNRE a Recolher" (a menos que ST/
# importacao, tratados antes, no nivel 1); GARE = ICMS/SP. Vem ANTES do scan generico para
# nao rebaixar GNRE (que costuma citar "icms") a 4.1.01.
_TAX_DOCTYPE_CHART_CODES = {
    "gnre": "4.4.01",   # GNRE a Recolher
    "gare": "4.1.01",   # ICMS a Recolher (GARE = ICMS/SP)
    "iss":  "4.1.06",   # ISS a Recolher
    "ipva": "6.4.02",   # IPVA
    "iptu": "6.4.01",   # IPTU
    "das":  "4.4.04",   # Taxas Federais a Recolher (Simples Nacional — sem conta dedicada)
}
# Nivel 3 — fallback por ESFERA do document_type, quando o imposto especifico nao foi
# identificado (ex.: "PAGAMENTO IMPOSTOS" tipo darf, "DARE T05"). 'tributo' (sem esfera)
# NAO entra -> nao forca (evita mis-forcar boleto de fornecedor mal-rotulado).
_TAX_SPHERE_CHART_CODES = {
    "darf": "4.4.04", "gru": "4.4.04", "dae": "4.4.04",           # federal
    "dare": "4.4.02",                                             # estadual
    "dam": "4.4.03", "duam": "4.4.03", "dam / duam": "4.4.03", "itbi": "4.4.03",  # municipal
}
# Nivel 1 — palavra-chave DISTINTIVA do imposto (assunto+descricao), especifico->generico.
# (termo palavra-inteira, account_code). ICMS-import/ICMS-ST/II/PIS-COFINS-CSLL sao tratados
# a parte em _resolve_tax_chart_code (frases/combinacoes). 'das'/'gare'/'gnre'/'dare'/'dam'
# NAO entram aqui (colidem com palavras do PT ou sao ambiguos) — resolvem por doctype/esfera.
_TAX_KEYWORD_CHART_CODES = (
    ("irrf",   "4.2.03"),   # IRRF a Recolher
    ("irpj",   "4.2.01"),   # IRPJ a Recolher
    ("csll",   "4.2.02"),   # CSLL a Recolher
    ("inss",   "4.2.04"),   # INSS Retido a Recolher
    ("iss",    "4.1.06"),   # ISS a Recolher
    ("ipi",    "4.1.03"),   # IPI a Recolher
    ("cofins", "4.1.05"),   # COFINS a Recolher
    ("pis",    "4.1.04"),   # PIS a Recolher
    ("icms",   "4.1.01"),   # ICMS a Recolher
    ("ipva",   "6.4.02"),   # IPVA
    ("iptu",   "6.4.01"),   # IPTU
)


def _resolve_tax_chart_code(document_type: str | None, blob: str,
                            *, sender_email: str | None = None) -> str | None:
    """account_code do plano de contas para uma GUIA TRIBUTARIA, do TIPO/CONTEXTO do imposto
    (nunca do supplier). `blob` = assunto+descricao(+corpo) JA normalizado (`_ns_body`, sem
    acento). Ordem: (1) imposto distintivo por frase/palavra; (2) por document_type especifico;
    (3) palavra-chave distintiva no texto; (4) fallback por esfera. Retorna account_code ou
    None (nao determinavel -> o chamador nao forca)."""
    dt = (document_type or "").strip().lower()
    # (1) frases/combinacoes especificas (maior prioridade)
    if any(p in blob for p in _ICMS_IMPORT_PHRASES):
        return "4.3.05"                                    # ICMS Importacao a Recolher
    if any(p in blob for p in _ICMS_ST_PHRASES) or (
            dt == GNRE_DOC_TYPE and _is_lebianco_sender(sender_email)):
        return "4.1.02"                                    # ICMS-ST a Recolher
    if "imposto de importacao" in blob:
        return "4.3.01"                                    # Imposto de Importacao (II) a Recolher
    if _has_word(blob, "pis") and _has_word(blob, "cofins") and (
            _has_word(blob, "csll") or "retid" in blob):
        return "4.2.05"                                    # PIS/COFINS/CSLL Retidos
    # (2) document_type que JA determina o imposto (GNRE/GARE/ISS/IPVA/IPTU/DAS)
    if dt in _TAX_DOCTYPE_CHART_CODES:
        return _TAX_DOCTYPE_CHART_CODES[dt]
    # (3) palavra-chave distintiva do imposto no texto (refina DARF/DARE/GRU)
    for term, code in _TAX_KEYWORD_CHART_CODES:
        if _has_word(blob, term):
            return code
    # (4) fallback por esfera do document_type
    return _TAX_SPHERE_CHART_CODES.get(dt)


def resolve_forced_classification(ctrl, document_type: str | None, subject: str | None,
                                  *extra_texts: str | None,
                                  sender_email: str | None = None,
                                  sk_supplier: int | None = None) -> tuple[int, int, bool] | None:
    """Classificacao contabil FORCADA (retorna (cost_center_id, chart_account_id, write_back)
    ou None).

    Precedencia MAXIMA para GUIA TRIBUTARIA (`_is_tax_document`): a conta e relacionada ao
    plano de contas pelo TIPO/CONTEXTO do imposto (`_resolve_tax_chart_code` ->
    `classification_for_account_code`), VENCENDO o default do fornecedor. Grava com write-back
    (write_back=True; a exclusao OTIMOTEX/funcionario fica em apply_forced_classification). Se a
    guia nao permite determinar (sem sinal, ou codigo ausente no cadastro), NAO forca (cai no
    comportamento atual — default do fornecedor).

    EXCLUSAO: fornecedores em `TAX_CLASSIFICATION_EXCLUDED_SK_SUPPLIERS` (ex.: Dr. Ricardo,
    despachante — reembolso/honorarios/juridico) NAO recebem classificacao tributaria forcada —
    a regra e pulada e a conta mantem o default do fornecedor / o valor da extracao.

    Abaixo (NAO-tributario): TRANSPORTE — CT-e/frete -> Logistica / Servicos de Transportadoras
    (com write-back). So assunto + document_type (nao a descricao/corpo — evita falso positivo)."""
    if (_is_tax_document(document_type)
            and sk_supplier not in TAX_CLASSIFICATION_EXCLUDED_SK_SUPPLIERS):
        blob = " ".join(_ns_body(t) for t in (subject, *extra_texts) if t)
        code = _resolve_tax_chart_code(document_type, blob, sender_email=sender_email)
        if code:
            cost_center_id, chart_account_id = ctrl.classification_for_account_code(code)
            if cost_center_id or chart_account_id:
                return (cost_center_id, chart_account_id, True)
    if _is_transport_context(subject, None, document_type):
        return (CC_LOGISTICA, CA_TRANSPORTADORAS, True)
    return None


def apply_forced_classification(ctrl, payload: dict, extra_text: str | None = None) -> None:
    """Aplica as regras de classificacao FORCADA (extracao de e-mail): forca
    cost_center_id/chart_account_id na conta por tipo de documento e, quando a regra pede,
    grava a mesma classificacao no supplier (write-back).

    Deve rodar APOS _finalize_supplier (que ja setou sk_supplier + o default do fornecedor)
    e ANTES da gravacao — a classificacao forcada SOBREPOE o default do fornecedor. Textos
    escaneados: assunto + descricao do documento (extraida) + `extra_text` (o corpo do e-mail
    no caminho de corpo). O remetente (`sender_email`) tambem e um sinal: GNRE de @lebianco
    vira ICMS-ST. Write-back nunca ocorre para a OTIMOTEX (sk_supplier=1)."""
    override = resolve_forced_classification(
        ctrl, payload.get("document_type"),
        payload.get("subject"), payload.get("description"), extra_text,
        sender_email=payload.get("sender_email"),
        sk_supplier=payload.get("sk_supplier"),
    )
    if not override:
        return
    cost_center_id, chart_account_id, write_back = override
    payload["cost_center_id"] = cost_center_id
    payload["chart_account_id"] = chart_account_id

    sk_supplier = payload.get("sk_supplier")
    # Write-back so quando a regra pede E o fornecedor nao e a OTIMOTEX (sk=1). Best-effort.
    if write_back and sk_supplier and sk_supplier != OTIMOTEX_SK_SUPPLIER:
        ctrl.update_supplier_classification(sk_supplier, cost_center_id, chart_account_id)


# Acronimos/frases de GUIA TRIBUTARIA no ASSUNTO -> document_type canonico (lowercase,
# como no CHECK do banco e no enum @sheild/shared). O ASSUNTO e o sinal MAIS confiavel
# do tipo de guia: quem encaminha o pagamento digita o tipo certo ("PAGAMENTO DARE -
# REF. T05S1"), enquanto as guias estaduais sao visualmente quase identicas (DARE x GARE
# x GNRE) e o PDF/Claude troca uma pela outra. Casado por PALAVRA INTEIRA (_has_word),
# sem acento. CONSERVADOR: acronimos que colidem com palavras do portugues ('das' =
# artigo, 'dam') NAO sao casados pela forma pura — so por frase inequivoca ('simples
# nacional'/'simei') para nao gerar falso positivo em "pagamento DAS contas".
_SUBJECT_TAX_DOC_KEYWORDS: list[tuple[str, list[str]]] = [
    ("darf",       ["darf"]),
    ("gps",        ["gps"]),
    ("das",        ["simples nacional", "simei"]),
    ("gru",        ["gru"]),
    ("dare",       ["dare"]),
    ("dae",        ["dae"]),
    ("gnre",       ["gnre"]),
    ("gare",       ["gare"]),
    ("ipva",       ["ipva"]),
    ("iptu",       ["iptu"]),
    ("iss",        ["iss"]),
    ("itbi",       ["itbi"]),
    ("dam / duam", ["duam"]),
    ("multa",      ["multa", "penalidade", "auto de infracao"]),
]


def _classify_tax_doc_type_from_subject(subject: str | None) -> str | None:
    """Detecta a GUIA TRIBUTARIA pelo ACRONIMO EXPLICITO no assunto (DARE/GARE/GNRE/
    DARF/...). Precedencia sobre a classificacao do PDF: o remetente declarou o tipo no
    assunto e as guias estaduais confundem o extrator. Casa por PALAVRA INTEIRA, sem
    acento. Retorna o document_type canonico (lowercase) ou None."""
    if not subject:
        return None
    blob = _ns_body(subject)
    for doc_type, terms in _SUBJECT_TAX_DOC_KEYWORDS:
        if any(_has_word(blob, term) for term in terms):
            return doc_type
    return None


def _brl_to_decimal(raw: str | None):
    """Converte valor em formato BR ('8.650,00' ou '8650,00') para float.

    O _to_decimal acima nao trata separador de milhar — necessario aqui pois
    o valor vem direto do texto do e-mail, nao normalizado pelo extract_pdf.
    """
    if not raw:
        return None
    s = re.sub(r"[^\d,.]", "", raw)
    # Vírgula = separador decimal BR. Aceita 1-3 casas: um 3º dígito é digitação com
    # zero a mais (ex.: "1.799,960" → 1799,96) — o round(…,2) normaliza. Sem esse
    # tolerância, "1.799,960" caía no ramo de milhar e virava 1,8 (bug real, id 186).
    if re.search(r",\d{1,3}$", s):
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", "")
    try:
        return round(float(s), 2)
    except ValueError:
        return None


def _extract_body_amount(body_text: str) -> "float | None":
    """Determina o valor a pagar a partir do corpo do e-mail.

    Regra (decisao de negocio):
      0. Valor "liquido"/"a pagar" (montante efetivo, apos descontos) tem
         precedencia MAXIMA — Ex.: fatura Rodonaves "Valor liquido R$ 12.985,52".
      1. Valor rotulado como "Total"/"Valor Total" tem precedencia — quando o
         corpo lista parcelas (lado a lado, somando ou subtraindo), o total e o
         valor a pagar. Ex.: "Valor: R$ 297,08 + R$ 6,96 / Total: R$ 304,04".
      2. Sem rotulo de total e com varios valores → soma as parcelas (fallback),
         MAS valores identicos repetidos (mesmo montante sob rotulos diferentes,
         ex.: "Valor da fatura" == "Valor liquido") contam como UM so — nunca
         somar; e R$ 0,00 (ex.: "Decrescimo R$ 0,00") e ignorado.
      3. Um unico valor → o proprio valor.
      4. Sem "R$": valor ROTULADO ("Valor 50,00"/"Total 304,04") — precedencia ao total.
      5. Nenhum valor → None.
    """
    net_match = _BODY_NET_RE.search(body_text)
    if net_match:
        return _brl_to_decimal(net_match.group(1))

    total_match = _BODY_TOTAL_RE.search(body_text)
    if total_match:
        return _brl_to_decimal(total_match.group(1))

    # Ignora R$ 0,00 (linhas "Decrescimo/Desconto R$ 0,00" nao sao valor a pagar).
    valores = [v for v in (_brl_to_decimal(m) for m in _BODY_AMOUNT_RE.findall(body_text))
               if v is not None and v > 0]
    if len(valores) == 1:
        return valores[0]
    if valores:
        # Valores todos IDENTICOS = o mesmo montante repetido (subtotal/liquido/
        # total sob rotulos distintos) → e UM valor, nao parcelas. Somar duplicava
        # (caso Rodonaves). So soma quando ha valores REALMENTE distintos (parcelas).
        if len(set(valores)) == 1:
            return valores[0]
        return round(sum(valores), 2)

    # Fallback sem "R$": numero rotulado por "Valor"/"Total" (precedencia ao total).
    rotulados = _BODY_LABELED_AMT_RE.findall(body_text)  # [(rotulo, numero), ...]
    if rotulados:
        totais = [num for (lbl, num) in rotulados if "total" in lbl.lower()]
        return _brl_to_decimal(totais[0] if totais else rotulados[0][1])
    return None


def _extract_body_installments(body_text: str) -> "list[dict]":
    """Detecta uma TABELA de boletos/parcelas no corpo (documento, parcela, emissão,
    vencimento, valor, dias) e devolve uma lista de parcelas individuais.

    Regra de negócio (NÃO regredir): quando o corpo lista MÚLTIPLOS títulos com
    documentos/parcelas e vencimentos diferentes, NUNCA criar uma conta somada com o
    total — criar UMA conta por boleto. Esta função alimenta esse caminho.

    Retorna [] quando não há tabela aplicável: menos de 2 linhas, OU todas as linhas
    com o MESMO vencimento E a MESMA (documento, parcela) — aí não é um conjunto de
    parcelas distintas e o caminho de valor único/total continua valendo.
    """
    rows: list[dict] = []
    for doc, parcela, emis, venc, valor in _BODY_INSTALLMENTS_RE.findall(body_text or ""):
        amount = _brl_to_decimal(valor)
        if amount is None:
            continue
        rows.append({
            "doc": doc,
            "parcela": parcela,
            "issue_date": _br_date_to_iso(emis),
            "due_date": _br_date_to_iso(venc),
            "amount": amount,
        })
    if len(rows) < 2:
        return []
    distinct_due = {r["due_date"] for r in rows}
    distinct_doc = {(r["doc"], r["parcela"]) for r in rows}
    if len(distinct_due) < 2 and len(distinct_doc) < 2:
        return []
    return rows


def _br_date_to_iso(raw: str | None) -> str | None:
    """Converte data 'dd/mm/aaaa' ou 'dd/mm/aa' do corpo do e-mail para 'aaaa-mm-dd'."""
    if not raw:
        return None
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _iso_date_to_ddmmyy(iso_date: str | None) -> str | None:
    """Converte data 'aaaa-mm-dd' para 'ddmmaa' — usado para compor invoice_number."""
    if not iso_date:
        return None
    try:
        return datetime.strptime(iso_date[:10], "%Y-%m-%d").strftime("%d%m%y")
    except ValueError:
        return None


def _format_brl(value) -> str:
    """Formata um valor numerico como moeda BR: 10999.99 -> 'R$ 10.999,99'."""
    # f-string usa formato US ('10,999.99'); troca os separadores para o padrao BR.
    s = f"{float(value):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {s}"


def _synthetic_invoice_number(document_type, amount, iso_date, payment_method="") -> str | None:
    """N documento sintetico quando o documento nao traz numero proprio.

    Regra de negocio:
    - Pagamento PIX sem tipo claro (payment_method='pix' E document_type='outro'):
      forma de pagamento + '_' + valor BR. Ex.: 'pix_R$ 10.999,99'.
    - Demais tipos: '{tipo}_{ddmmaa(vencimento|emissao)}' quando ha data.
    Retorna None quando nao ha base para gerar (sem regra PIX e sem data).
    """
    pm = (payment_method or "").lower()
    if pm == "pix" and (document_type or "").lower() == "outro" and amount is not None:
        return f"{pm}_{_format_brl(amount)}"
    ddmmyy = _iso_date_to_ddmmyy(iso_date)
    if ddmmyy:
        return f"{document_type or 'outro'}_{ddmmyy}"
    return None


# Numero de documento SINTETICO (gerado por _synthetic_invoice_number quando o
# documento nao traz numero proprio): 'PIX_R$ ...' ou '{tipo}_{ddmmaa}'. NAO e um
# identificador confiavel — dois boletos distintos do mesmo fornecedor, mesmo valor
# e mesmo vencimento (ou vencimento DEFAULTADO p/ a data da extracao) colidem nesse
# numero. Por isso a dedup de conteudo (impressao 2) o IGNORA: o codigo de barras
# (impressao 1) distingue os documentos.
_SYNTHETIC_INVOICE_RE = re.compile(r"_\d{6}(?:\(\d+\))?$")


def _is_synthetic_invoice_number(invoice: str | None) -> bool:
    s = (invoice or "").strip()
    if s.upper().startswith("PIX_"):
        return True
    return bool(_SYNTHETIC_INVOICE_RE.search(s))


def extract_from_email_body(body_text: str, received_at: str, message_id: str,
                            sender_email: str | None = None,
                            subject: str | None = None) -> dict | None:
    """Monta um payload de financial_account_control a partir do corpo do e-mail.

    Retorna None (sem log de erro) quando nenhum sinal financeiro e encontrado
    (sem valor R$ nem numero de documento). O chamador deve ignorar silenciosamente.

    Regras de extracao:
      - amount      : valor rotulado 'Total'/'Valor Total' (precedencia); sem
                       rotulo, soma as parcelas; valor unico → ele mesmo (_extract_body_amount)
      - invoice_number: 'NF XXXX', 'NFe XXXX', 'nota fiscal XXXX', 'fatura N° XXXX'
      - issue_date  : 'emissao DD/MM/AA(AA)'; fallback = data de envio do e-mail
      - due_date    : 'vencimento/vencto DD/MM/AA(AA)'; fallback = issue_date
      - supplier_name: 'Fornecedor:'/'Favorecido:'/'Nome:'/... no corpo;
                       fallback = sender_email (so quando nao ha rotulo nem CNPJ/CPF)
      - supplier_cnpj/cpf: extraidos do corpo (CNPJ por padrao; CPF so rotulado)
      - barcode     : linha digitavel / codigo de barras (boleto 47 / arrecadacao 48)
      - payment_method: 'pix' no corpo → 'pix'; boleto (barcode) → 'boleto'; senao a
                       FORMA DECLARADA no corpo/assunto (dinheiro/depósito/cheque/cartão/
                       crédito/débito/ted/transferência/duplicata — _classify_body_payment_method);
                       nada casando → 'outro'
      - document_type: 'PIX' quando PIX; senao keywords de tributo; fallback 'outro'
      - invoice_number fallback: PIX -> 'PIX_' + valor BR ('PIX_R$ 10.999,99');
        demais tipos -> '{document_type}_{ddmmyy}' quando nao encontrado

    Guarda: corpos de comprovante de pagamento ja feito / 'pix recebido' (sem
    pedido de pagamento) retornam None — nao sao conta a pagar.
    """
    if not body_text:
        return None

    # Guarda: comprovante de pagamento ja feito / "pix recebido" que NAO pede
    # pagamento — nao e conta a pagar (afasta phishing tipo "Comprovante de Pix
    # Recebido"). Skip silencioso.
    if (_BODY_RECEIPT_RE.search(body_text)
            and not _BODY_PAYMENT_REQUEST_RE.search(body_text)):
        return None

    # Campos extraidos do corpo
    name_match    = _BODY_NAME_RE.search(body_text)
    supplier_name = name_match.group(1).strip() if name_match else None

    # CNPJ (somente digitos, exatamente 14) / CPF rotulado (exatamente 11).
    cnpj_match    = _BODY_CNPJ_RE.search(body_text)
    supplier_cnpj = re.sub(r"\D", "", cnpj_match.group(0)) if cnpj_match else None
    if supplier_cnpj and len(supplier_cnpj) != 14:
        supplier_cnpj = None

    cpf_match     = _BODY_CPF_RE.search(body_text)
    supplier_cpf  = re.sub(r"\D", "", cpf_match.group(1)) if cpf_match else None
    if supplier_cpf and len(supplier_cpf) != 11:
        supplier_cpf = None

    # Barcode: linha digitavel / codigo de barras. Normalizacao canonica (mesma
    # do caminho de PDF): 44/48 digitos mantidos, 47 -> 44, outros -> None.
    barcode_match = _BODY_BARCODE_RE.search(body_text)
    barcode       = _normalize_body_barcode(barcode_match.group(1)) if barcode_match else None

    amount         = _extract_body_amount(body_text)

    inv_match      = _BODY_INVOICE_RE.search(body_text)
    invoice_number = inv_match.group(1).strip() if inv_match else None
    # Fallback: rótulo explícito "Número do documento" (valor alfanumérico) — pega
    # boletos de concessionária/cobrança cujo nº não é NF/fatura+dígitos.
    if not invoice_number:
        doc_match = _BODY_DOCNUM_RE.search(body_text)
        if doc_match:
            invoice_number = doc_match.group(1).strip()
    # Sem nº no texto, mas com link de fatura SIEG: usa o bill como nº estável, para
    # os dois lembretes ("Vencimento Próximo" + "Hoje") da MESMA fatura deduplicarem
    # (a dedup por nome+nº+valor casa; antes o nº saía de data relativa e divergia).
    if not invoice_number:
        bill = _BODY_SIEG_BILL_RE.search(body_text)
        if bill:
            invoice_number = f"sieg_{bill.group(1)}"

    # Sem sinal financeiro (valor ou numero de documento) — ignorar silenciosamente
    if not amount and not invoice_number:
        return None

    # Fornecedor sem rotulo nem identificador: tenta sinais (destinatario do pix
    # "p/ <Nome>" / assinatura "Prof. <Nome>") e o mapa por remetente
    # (ex.: correios.com.br -> "Correios"). Havendo CNPJ/CPF, deixa o nome vazio.
    #
    # REGRA (robusta — nao regredir): sem NENHUM nome confiavel, o nome fica VAZIO de
    # proposito. O e-mail do remetente (sender_email) NAO vira nome aqui — ele e passado
    # a RPC resolve_supplier_id como chave propria (busca por email/email2/email3/email4).
    # Se o e-mail JA constar em um fornecedor, casa com ele; SO quando o e-mail NAO for
    # encontrado e que o auto-insert da RPC usa o e-mail como nome (ULTIMO RECURSO). Assim
    # o e-mail nunca vira nome ANTES da busca, evitando criar fornecedor DUPLICADO quando o
    # e-mail ja pertence a um cadastrado (ex.: financeiro@... no email2 de um fornecedor).
    # E-mail de dominio interno nunca identifica nem cria fornecedor (migration 046).
    if not supplier_name and not supplier_cnpj and not supplier_cpf:
        supplier_name = _supplier_from_signals(body_text) or _supplier_from_sender(sender_email)

    has_pix = bool(_BODY_PIX_RE.search(body_text))

    issue_match = _BODY_ISSUE_RE.search(body_text)
    issue_date  = _br_date_to_iso(issue_match.group(1)) if issue_match else None
    if not issue_date:
        issue_date = (received_at or "")[:10] or None

    due_match = _BODY_DUE_RE.search(body_text)
    due_date  = _br_date_to_iso(due_match.group(1)) if due_match else None
    if not due_date:
        # "DATA PARA PAGAMENTO: DD/MM/AA" (nota interna) → vencimento.
        pay_match = _BODY_PAYDATE_RE.search(body_text)
        due_date  = _br_date_to_iso(pay_match.group(1)) if pay_match else None
    if not due_date:
        due_date = issue_date  # sem vencimento explicito, usa data de emissao
    if not due_date:
        # Regra de negocio: sem nenhuma data, usa a data da extracao (hoje).
        due_date = datetime.now().strftime("%Y-%m-%d")

    # Conta de concessionária (água/luz/telefone-internet) tem PRECEDÊNCIA MÁXIMA:
    # a frase no assunto/corpo define o tipo mesmo que pareça fatura/boleto/PIX.
    # payment_method permanece o detectado (pix se houver) — utility não força forma.
    # Depois: GUIA TRIBUTÁRIA pelo acrônimo no assunto (DARE/GARE/GNRE/DARF…) →
    # honorários (precedência sobre PIX) → PIX → classificação por keyword do corpo.
    utility = (_classify_utility_doc_type(subject, body_text)
               or _classify_utility_by_supplier(supplier_name))
    tax_subject = _classify_tax_doc_type_from_subject(subject)
    classified = _classify_body_doc_type(body_text)
    if utility:
        document_type, payment_method = utility, ("pix" if has_pix else "outro")
    elif tax_subject:
        document_type, payment_method = tax_subject, ("pix" if has_pix else "outro")
    elif classified == "honorários":
        document_type, payment_method = "honorários", "pix"
    else:
        # PIX é FORMA DE PAGAMENTO, não tipo de documento: o tipo fica o classificado
        # ('outro' quando nada casou) e o PIX detectado reflete só no payment_method.
        document_type = classified            # 'outro' quando nada casou
        payment_method = "pix" if has_pix else "outro"

    # Boleto com PIX: linha digitavel / codigo de barras de BOLETO valido tem
    # precedencia sobre TODOS os ramos acima (inclusive has_pix e honorarios) —
    # paga-se como boleto. Chave NF-e/CT-e (44 sem moeda '9') nao casa -> segue pix.
    if barcode and _is_boleto_barcode(barcode):
        payment_method = "boleto"
        if (document_type or "outro").lower() in ("pix", "outro", ""):
            document_type = "boleto"

    # Forma de pagamento DECLARADA no corpo (dinheiro/depósito/cheque/cartão/…): preenche
    # quando os ramos acima deixaram 'outro' — pix e boleto já foram resolvidos e têm
    # precedência (não sobrescreve). Corpo tem precedência sobre o assunto. Caso de origem:
    # id 442 "PAGAMENTO EM DINHEIRO" gravava 'outro' → agora 'dinheiro'.
    if payment_method == "outro":
        payment_method = _classify_body_payment_method(body_text, subject) or "outro"

    # Boleto de TRANSPORTE → document_type='cte' (regra 4). Mesma regra do caminho de
    # PDF; roda depois do override de boleto (o boleto ja foi identificado acima).
    document_type = _apply_transport_boleto_doc_type(
        document_type, subject, supplier_name, barcode)

    # Cartório (contexto "cartorio" no assunto/fornecedor) → document_type='cartório'.
    # Mesma regra do caminho de PDF; só re-rotula tipos genéricos.
    document_type = _apply_cartorio_doc_type(document_type, subject, supplier_name)

    # Numero de documento: valor encontrado no corpo ou sintetico (pagamento PIX +
    # tipo 'outro': 'pix_' + valor; demais: tipo+ddmmyy do vencimento/emissao).
    if not invoice_number:
        invoice_number = _synthetic_invoice_number(
            document_type, amount, due_date or issue_date, payment_method) or invoice_number

    payload = {f: None for f in FINANCIAL_FIELDS}
    payload.update({
        "document_type":     document_type,
        "extraction_source": "email_body",
        "supplier_name":     supplier_name,
        "supplier_cnpj":     supplier_cnpj,
        "supplier_cpf":      supplier_cpf,
        "amount":            amount,
        "currency":          "BRL",
        "payment_method":    payment_method,
        "barcode":           barcode,
        "due_date":          due_date,
        "issue_date":        issue_date,
        "invoice_number":    invoice_number,
        # Sempre 'pendente' — a baixa/atualizacao do status e feita pelo usuario.
        "status":            "pendente",
        "extracted_at":      datetime.now(timezone.utc).isoformat(),
    })
    for vf in FINANCIAL_VALUE_FIELDS:
        payload[vf] = 0
    payload["amount_charged"]     = amount or 0
    payload["gmail_message_id"]   = message_id
    payload["email_body_excerpt"] = body_text.strip()
    return payload


# ---------------------------------------------------------------------------
# Download de anexos PDF
# ---------------------------------------------------------------------------
def _is_within_inbox(dest_path: Path) -> bool:
    """True se dest_path resolvido fica DENTRO de PDF_INBOX — invariante explícito contra
    path traversal (safe_filename já remove `..`/separadores; isto é defesa em profundidade)."""
    try:
        inbox = PDF_INBOX.resolve()
        resolved = dest_path.resolve()
        return resolved == inbox or inbox in resolved.parents
    except OSError:
        return False


# Anexos de IMAGEM (foto/scan de recibo, comprovante, "Valor do porte" dos Correios)
# também são lidos — via Claude Vision no extract_pdf. Mapeia extensão→media_type.
_IMAGE_ATTACHMENT_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp")
_IMAGE_ATTACHMENT_CTS  = {"image/jpeg", "image/png", "image/gif", "image/webp"}
# Tamanho mínimo (bytes) para uma imagem INLINE ser considerada um documento e não
# um logo/assinatura/ícone embutido. Recibos/comprovantes colados no corpo passam
# bem disso (centenas de KB); logos típicos ficam abaixo. Named constant — sem magia.
_IMAGE_INLINE_MIN_BYTES = 50_000


def _attachment_image_ext(content_type: str, filename_lower: str) -> str:
    """Extensão de imagem a usar no arquivo salvo (do nome do anexo ou do MIME)."""
    for ext in _IMAGE_ATTACHMENT_EXTS:
        if filename_lower.endswith(ext):
            return ext
    return {"image/jpeg": ".jpg", "image/png": ".png",
            "image/gif": ".gif", "image/webp": ".webp"}.get(content_type, ".img")


def _unique_inbox_path(base_stem: str, ext: str) -> Path:
    """Caminho único em PDF_INBOX para base_stem+ext, somando sufixo _N se já existir."""
    dest = PDF_INBOX / f"{base_stem}{ext}"
    counter = 1
    while dest.exists():
        dest = PDF_INBOX / f"{base_stem}_{counter}{ext}"
        counter += 1
    return dest


def save_attachments(msg, sender_email: str, subject: str,
                     received_at: str) -> list:
    saved = []
    date_tag    = received_at[:10].replace("-", "")
    sender_tag  = safe_filename(sender_email.split("@")[0], 20)
    subject_tag = safe_filename(subject, 30)

    for part in msg.walk():
        cd    = str(part.get("Content-Disposition", ""))
        ct    = part.get_content_type()
        fname = decode_str(part.get_filename() or "")
        fl    = fname.lower()
        is_pdf = (ct == "application/pdf"
                  or fl.endswith(".pdf")
                  or ("attachment" in cd and "pdf" in fl))
        # Imagem: SÓ quando é anexo explícito (Content-Disposition: attachment) —
        # evita salvar logos/assinaturas embutidas (inline / Content-ID), que não
        # são documentos financeiros. Recibo/foto do documento vem como anexo.
        is_image = ("attachment" in cd.lower()
                    and (ct in _IMAGE_ATTACHMENT_CTS or fl.endswith(_IMAGE_ATTACHMENT_EXTS)))
        if not (is_pdf or is_image):
            continue

        ext       = ".pdf" if is_pdf else _attachment_image_ext(ct, fl)
        orig      = safe_filename(Path(fname).stem, 20) if fname else "anexo"
        dest_path = _unique_inbox_path(f"{sender_tag}_{subject_tag}_{date_tag}_{orig}", ext)

        payload = part.get_payload(decode=True)
        if payload:
            if not _is_within_inbox(dest_path):
                log.warning(f"    Anexo ignorado (caminho fora de PDF_INBOX): {dest_path.name}")
                continue
            dest_path.write_bytes(payload)
            saved.append(dest_path)
            log.info(f"    Anexo salvo: {dest_path.name}")
    return saved


def save_inline_images(msg, sender_email: str, subject: str, received_at: str) -> list:
    """Fallback: salva a MAIOR imagem INLINE (>= _IMAGE_INLINE_MIN_BYTES) do corpo
    para leitura via Claude Vision. Usado SÓ quando não houve anexo (PDF/imagem) nem
    PDF por link — imagem inline (Content-ID, sem 'attachment') costuma ser o próprio
    documento colado no corpo (recibo/comprovante). Pega só a MAIOR (o documento é a
    imagem mais proeminente) para evitar logos/2ª imagem e limitar chamadas ao Vision;
    loga quantas imagens inline menores foram ignoradas.
    """
    date_tag    = received_at[:10].replace("-", "")
    sender_tag  = safe_filename(sender_email.split("@")[0], 20)
    subject_tag = safe_filename(subject, 30)

    candidates = []  # (tamanho, payload, filename, content_type)
    for part in msg.walk():
        ct = part.get_content_type()
        if not ct.startswith("image/"):
            continue
        cd = str(part.get("Content-Disposition", "")).lower()
        if "attachment" in cd:
            continue  # anexo explícito já tratado por save_attachments
        payload = part.get_payload(decode=True)
        if not payload or len(payload) < _IMAGE_INLINE_MIN_BYTES:
            continue
        candidates.append((len(payload), payload, decode_str(part.get_filename() or ""), ct))

    if not candidates:
        return []
    candidates.sort(key=lambda c: c[0], reverse=True)  # maior primeiro
    size, payload, fname, ct = candidates[0]
    skipped = len(candidates) - 1

    ext       = _attachment_image_ext(ct, fname.lower())
    orig      = safe_filename(Path(fname).stem, 20) if fname else "imagem"
    dest_path = _unique_inbox_path(f"{sender_tag}_{subject_tag}_{date_tag}_{orig}", ext)
    if not _is_within_inbox(dest_path):
        log.warning(f"    Imagem inline ignorada (caminho fora de PDF_INBOX): {dest_path.name}")
        return []
    dest_path.write_bytes(payload)
    extra = f" — {skipped} imagem(ns) inline menor(es) ignorada(s)" if skipped else ""
    log.info(f"    Imagem inline salva (maior, {size} bytes): {dest_path.name}{extra}")
    return [dest_path]


# ---------------------------------------------------------------------------
# Download de PDFs a partir de links no corpo do e-mail
# ---------------------------------------------------------------------------
# Texto âncora que sugere um documento de cobrança
_LINK_TEXT_RE = re.compile(
    r"boleto|fatura|segunda\s*via|download|baixar|pagar|pagamento|"
    r"clique\s*aqui|acesse|emitir|emiss[aã]o|vencimento|cobran[cç]a|slip",
    re.IGNORECASE,
)
# Segmento de URL que sugere boleto/PDF. Inclui 'protocolo' para reconhecer
# portais de fatura via link (ex.: BRASPRESS /protocoloweb?protocolo=...), em que
# a URL nao traz 'boleto'/'fatura' no caminho.
_LINK_URL_RE = re.compile(
    r"boleto|fatura|invoice|bill|download|pdf|pagamento|documento|cobranca|protocolo",
    re.IGNORECASE,
)
# Portal BRASPRESS: o link do e-mail (/protocoloweb?protocolo=CHAVE) abre uma pagina
# cujo botao "Download" chama faturaPDF(chave), que baixa de
# /fatura/download?protocolo=CHAVE&protocoloWeb=true (exige cookie de sessao).
_BRASPRESS_PROTO_RE = re.compile(r"protocolo=([0-9A-Za-z]+)", re.IGNORECASE)

def _braspress_download_url(page_url: str) -> "str | None":
    """Se page_url for um link de fatura por protocolo BRASPRESS, retorna a URL
    direta de download do PDF; caso contrario None. Funcao pura (testavel)."""
    low = page_url.lower()
    if "braspress" not in low or "protocolo" not in low:
        return None
    m = _BRASPRESS_PROTO_RE.search(page_url)
    if not m:
        return None
    return ("https://www.braspress.com.br/fatura/download"
            f"?protocolo={m.group(1)}&protocoloWeb=true")

# Wrappers de redirecionamento/rastreamento de cliques usados em phishing — a
# Locaweb marca mensagens com esses links como "potencialmente suspeitas".
# Nao seguir (poderiam baixar malware no lugar do boleto). Ex.: redirect do Bing
# (bing.com/ck/a?...&u=a1<base64 do destino>), SafeLinks, Proofpoint URL Defense.
_SUSPICIOUS_LINK_RE = re.compile(
    r"(?i)("
    r"bing\.com/ck/|"                    # Bing click redirect
    r"/ck/a\?|"                          # padrao /ck/a? de redirect ofuscado
    r"safelinks\.protection\.outlook|"   # Microsoft SafeLinks
    r"urldefense\.(?:com|proofpoint)|"   # Proofpoint URL Defense
    r"[?&]u=a1aHR0c"                     # destino em base64 ('aHR0c' = 'http')
    r")"
)

def _is_suspicious_link(url: str) -> bool:
    """True se a URL for um redirect/rastreador ofuscado que a Locaweb classifica
    como suspeito — esses links nao sao seguidos para download. Funcao pura."""
    return bool(_SUSPICIOUS_LINK_RE.search(url or ""))

# Aviso da Locaweb para link suspeito ("Tem certeza que deseja acessar este link?"
# / "identificada como potencialmente suspeita"). NOTA: normalmente esse aviso e um
# modal do webmail exibido APOS o clique — nao costuma estar no corpo bruto (IMAP).
# A defesa primaria e o padrao da URL (_is_suspicious_link); esta verificacao de
# corpo e uma rede secundaria (ex.: aviso citado/encaminhado dentro do corpo).
_SUSPICIOUS_BODY_RE = re.compile(
    r"(?i)tem\s+certeza\s+que\s+deseja\s+acessar\s+este\s+link"
    r"|identificada\s+como\s+potencialmente\s+suspeita"
)

def _body_has_suspicious_warning(text: str, html: str) -> bool:
    """True se o corpo trouxer o aviso de link suspeito da Locaweb. Funcao pura."""
    return bool(_SUSPICIOUS_BODY_RE.search((text or "") + " " + (html or "")))

_LINK_HREF_RE = re.compile(
    r'<a[^>]+href=["\']([^"\']{10,})["\'][^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_LINK_IN_TEXT_RE = re.compile(r"https?://[^\s\"'<>]{15,}")

# SSW (sistema de transportadoras — sswsistemas.com.br). O e-mail "Sua fatura Nº... está
# disponível" traz VÁRIOS links ssw.inf.br/cgi-local/ssw1188?id=<hex>, e o 1º BYTE do `id`
# (hex→ASCII) indica o tipo do documento: 'F' = Fatura (traz o BOLETO no rodapé) · 'D'/'E'/'X'
# = DACTE/CT-e (documento FISCAL, sem boleto). A âncora da fatura é genérica ("AQUI"/número) e
# não casa as heurísticas de boleto/fatura/download; já a do DACTE é "Download do arquivo"
# (casa 'download'). Sem tratamento, extract_pdf_links baixava o DACTE (sem linha digitável) e a
# conta caía em 'ignorado' (regra CT-e/transporte sem boleto). Preferimos a FATURA e descartamos
# os DACTE. Ver "Boleto por link (sem anexo)" no CLAUDE.md.
_SSW_LINK_RE = re.compile(r"ssw\.inf\.br/cgi-local/ssw1188\?id=([0-9a-fA-F]{2,})", re.IGNORECASE)


def _ssw_doc_kind(url: str) -> "str | None":
    """Classifica um link SSW ssw1188?id=<hex> pelo 1º byte decodificado do id:
    'fatura' (id começa com 'F' — traz o boleto), 'dacte' ('D'/'E'/'X' — CT-e/DACTE fiscal,
    sem boleto). None se não for link SSW ou o tipo for desconhecido (deixa a heurística
    normal decidir). Função pura."""
    m = _SSW_LINK_RE.search(url or "")
    if not m:
        return None
    try:
        first = bytes.fromhex(m.group(1)[:2]).decode("ascii", "ignore").upper()
    except ValueError:
        return None
    if first == "F":
        return "fatura"
    if first in ("D", "E", "X"):
        return "dacte"
    return None

_MAX_PDF_LINK_BYTES = 50 * 1024 * 1024  # 50 MB
_LINK_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def extract_pdf_links(text: str, html: str) -> list[str]:
    """Extrai URLs candidatas a PDF do texto simples e HTML do e-mail.

    Inclui links HTML cujo texto-âncora ou caminho da URL sugira boleto/fatura.
    Limita a 10 candidatas por e-mail para evitar downloads em massa.
    """
    # Aviso de link suspeito da Locaweb no corpo → não seguir nenhum link.
    if _body_has_suspicious_warning(text, html):
        log.info("    Aviso de link suspeito (Locaweb) no corpo — links ignorados")
        return []

    candidates, seen = [], set()
    ssw_faturas: list[str] = []  # links SSW de FATURA (id=F) — têm PRIORIDADE (trazem o boleto)

    def _add(url: str, *, front: bool = False):
        # Desescapa entidades HTML (&amp; → &) — links de boleto vêm escapados no
        # HTML e quebrariam os parâmetros (ex.: SIEG/Vindi ?b=…&m=…&t=…).
        u = html_unescape(url.strip()).rstrip(".,;)>\"'")
        # Ignora links que a Locaweb entende como suspeitos (redirect/ofuscados).
        if u and u not in seen and u.startswith("http") and not _is_suspicious_link(u):
            seen.add(u)
            (ssw_faturas if front else candidates).append(u)

    for m in _LINK_HREF_RE.finditer(html or ""):
        url         = m.group(1).strip()
        anchor_text = re.sub(r"<[^>]+>", "", m.group(2)).strip()
        if not url.startswith("http"):
            continue
        # SSW: o link de FATURA (id=F) traz o boleto; o de DACTE (id=D/E/X) é fiscal, sem
        # boleto. Preferimos a fatura (prioridade máxima) e DESCARTAMOS os DACTE — senão o
        # pipeline baixava o DACTE e a conta caía em 'ignorado' (regra CT-e/transporte).
        ssw_kind = _ssw_doc_kind(url)
        if ssw_kind == "fatura":
            _add(url, front=True)
            continue
        if ssw_kind == "dacte":
            continue
        url_path = url.lower().split("?")[0]
        if (_LINK_TEXT_RE.search(anchor_text)
                or url_path.endswith(".pdf")
                or _LINK_URL_RE.search(url)):
            _add(url)

    for url in _LINK_IN_TEXT_RE.findall(text or ""):
        if _ssw_doc_kind(url) == "dacte":
            continue  # nunca seguir o DACTE do SSW pelo texto puro
        if _ssw_doc_kind(url) == "fatura":
            _add(url, front=True)
            continue
        url_path = url.lower().split("?")[0]
        if url_path.endswith(".pdf") or _LINK_URL_RE.search(url):
            _add(url)

    # Faturas SSW primeiro (trazem o boleto), depois as demais candidatas.
    return (ssw_faturas + candidates)[:10]


# ── Guarda anti-SSRF do download por link ───────────────────────────────────
# Conteúdo de remetente DESCONHECIDO controla a URL; sem guarda, o servidor pode ser
# forçado a requisitar alvos internos (metadata cloud 169.254.169.254, localhost, LAN,
# portas internas). Bloqueamos scheme != http(s), porta fora de {80,443} e host que
# resolve para IP interno — no URL inicial E a cada redirect (_SafeRedirectHandler).
_ALLOWED_SCHEMES = ("http", "https")
_ALLOWED_PORTS = {80, 443}


def _safe_host_ips(host: str) -> "list[str]":
    """Resolve `host` e devolve os IPs SE todos forem externos; [] se a resolução falhar OU
    qualquer IP for interno (privado/loopback/link-local/reservado/multicast/unspecified).
    Base compartilhada por _host_is_safe (compat) e pelo pin de IP (anti-DNS-rebinding): o
    download conecta ao IP JÁ validado aqui, sem re-resolver o nome no socket."""
    if not host:
        return []
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError, OSError):
        return []
    ips: "list[str]" = []
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return []
        # S4-3: normaliza IPv6 IPv4-mapeado (ex.: ::ffff:169.254.169.254) para o IPv4
        # embutido ANTES das checagens — em runtimes < 3.13 as flags is_private/is_link_local
        # podem não delegar ao IPv4 mapeado. Defesa em profundidade (produção roda 3.14).
        # getattr: só IPv6Address tem `ipv4_mapped`; IPv4Address não → None (sem AttributeError).
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None:
            ip = mapped
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return []
        ips.append(str(ip))
    return ips


def _host_is_safe(host: str) -> bool:
    """False se o host resolve para QUALQUER IP interno — barra SSRF para metadata cloud e
    rede interna. Wrapper de _safe_host_ips (mantido para compat de chamadas/testes)."""
    return bool(_safe_host_ips(host))


def _pin_ip_for_host(host: str) -> "str | None":
    """IP EXTERNO validado para FIXAR no socket (fecha a janela de DNS rebinding entre a
    validação e o connect). None quando o host não resolve ou resolve para algum IP interno."""
    ips = _safe_host_ips(host)
    return ips[0] if ips else None


def _is_safe_download_url(url: str) -> bool:
    """Valida a URL contra SSRF: scheme http(s), porta padrão e host que NÃO resolve para
    IP interno. Aplicada ao URL inicial e revalidada a cada redirect."""
    try:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in _ALLOWED_SCHEMES:
            return False
        host = parts.hostname
        port = parts.port  # pode levantar ValueError em porta malformada
    except ValueError:
        return False
    if not host:
        return False
    if port is not None and port not in _ALLOWED_PORTS:
        return False
    return _host_is_safe(host)


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Revalida o destino de CADA redirect contra SSRF (impede bypass do guard via 302
    para alvo interno). O limite de saltos do urllib (max_redirections) segue ativo."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        if not _is_safe_download_url(newurl):
            raise urllib.error.HTTPError(
                newurl, code, "redirect para destino não permitido (SSRF)", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection que conecta a um IP JÁ VALIDADO e FIXADO, preservando o Host original
    no request. O socket não re-resolve o nome → fecha a janela de DNS rebinding (S4-1)."""

    def __init__(self, *args, pinned_ip: "str | None" = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self):  # noqa: D102
        target = self._pinned_ip or self.host
        self.sock = self._create_connection((target, self.port), self.timeout, self.source_address)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        if self._tunnel_host:
            self._tunnel()


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Como _PinnedHTTPConnection, com TLS: o SNI / validação de certificado usa o HOSTNAME
    ORIGINAL (self.host), não o IP fixado — pin sem quebrar a verificação de certificado."""

    def __init__(self, *args, pinned_ip: "str | None" = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self):  # noqa: D102
        target = self._pinned_ip or self.host
        self.sock = self._create_connection((target, self.port), self.timeout, self.source_address)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        if self._tunnel_host:
            self._tunnel()
            server_hostname = self._tunnel_host
        else:
            server_hostname = self.host
        self.sock = self._context.wrap_socket(self.sock, server_hostname=server_hostname)


def _pinned_conn_factory(conn_cls, url: str):
    """Fábrica de conexão que RESOLVE + VALIDA o host uma vez e FIXA o IP externo. Levanta
    URLError se o destino resolve para IP interno (ou não resolve) — cobre também cada
    redirect, pois o salto reentra pelo handler com a nova URL."""
    host = urllib.parse.urlsplit(url).hostname
    pinned = _pin_ip_for_host(host or "")
    if pinned is None:
        raise urllib.error.URLError("destino resolve para IP interno ou não resolve (SSRF)")

    def _make(chost, **kwargs):
        return conn_cls(chost, pinned_ip=pinned, **kwargs)

    return _make


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    """Substitui o HTTPHandler default no opener: fixa o IP validado no connect (S4-1)."""

    def http_open(self, req):  # noqa: D102
        return self.do_open(_pinned_conn_factory(_PinnedHTTPConnection, req.full_url), req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    """Substitui o HTTPSHandler default: fixa o IP e mantém o context/SNI (verificação de
    certificado preservada) — o server_hostname continua sendo o hostname original."""

    def https_open(self, req):  # noqa: D102
        return self.do_open(
            _pinned_conn_factory(_PinnedHTTPSConnection, req.full_url), req,
            context=self._context, check_hostname=self._check_hostname)


def _build_safe_opener(*handlers: "urllib.request.BaseHandler") -> "urllib.request.OpenerDirector":
    """Opener com: pin de IP anti-rebinding (_Pinned*Handler substituem os HTTP/HTTPS
    handlers default por serem subclasses deles) + revalidação de CADA redirect
    (_SafeRedirectHandler) + handlers extras (ex.: cookies para BRASPRESS)."""
    return urllib.request.build_opener(
        _SafeRedirectHandler(), _PinnedHTTPHandler(), _PinnedHTTPSHandler(), *handlers)


def _fetch_url(url: str, timeout: int = 30,
               opener: "urllib.request.OpenerDirector | None" = None
               ) -> "tuple[bytes, str, str] | None":
    """GET em url; retorna (conteúdo, content_type, url_final) ou None.

    Quando `opener` é informado (build_opener com HTTPCookieProcessor), a chamada
    reutiliza a mesma sessão/cookies — necessário para portais que exigem cookie
    de sessão entre a página e o download (ex.: BRASPRESS JSESSIONID). O opener deve
    incluir o _SafeRedirectHandler; o caminho sem opener usa um opener seguro próprio."""
    if not _is_safe_download_url(url):
        log.info(f"    Link bloqueado (destino não permitido / SSRF): {url[:70]}")
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _LINK_UA})
        _open = opener.open if opener is not None else _build_safe_opener().open
        with _open(req, timeout=timeout) as resp:
            return (
                resp.read(_MAX_PDF_LINK_BYTES),
                resp.headers.get("Content-Type", "").lower(),
                resp.geturl(),
            )
    except urllib.error.HTTPError as e:
        log.info(f"    HTTP {e.code}: {url[:70]}")
        return None
    except Exception as e:
        log.info(f"    Falha ao acessar link ({type(e).__name__}): {url[:70]}")
        return None


def _save_pdf_data(data: bytes, sender_email: str, subject: str,
                   received_at: str) -> "Path | None":
    date_tag    = received_at[:10].replace("-", "")
    sender_tag  = safe_filename((sender_email or "").split("@")[0], 20)
    subject_tag = safe_filename(subject, 30)
    dest_name   = f"{sender_tag}_{subject_tag}_{date_tag}_link.pdf"
    dest_path   = PDF_INBOX / dest_name
    counter = 1
    while dest_path.exists():
        dest_path = PDF_INBOX / f"{dest_name[:-4]}_{counter}.pdf"
        counter += 1
    if not _is_within_inbox(dest_path):
        log.warning(f"    PDF de link ignorado (caminho fora de PDF_INBOX): {dest_name}")
        return None
    dest_path.write_bytes(data)
    log.info(f"    PDF via link salvo: {dest_path.name} ({len(data) // 1024} KB)")
    return dest_path


def download_pdf_from_url(url: str, sender_email: str, subject: str,
                           received_at: str) -> Path | None:
    """Baixa um PDF de uma URL, seguindo até um nível de página HTML intermediária.

    Fluxo:
      1. Faz GET na URL (segue redirects; usa sessão com cookies).
      2. Se a resposta contiver bytes PDF (%PDF), salva e retorna.
      3. Portal conhecido (BRASPRESS protocoloweb): monta a URL direta de
         download da fatura e baixa com o mesmo cookie de sessão.
      4. Se a resposta for HTML (landing page / tracking redirect),
         varre os links da página em busca de um link PDF e tenta baixá-lo.
      5. Qualquer outro conteúdo é ignorado.
    """
    # Sessão com cookies — necessária para portais que exigem JSESSIONID entre a
    # página inicial e o download (ex.: BRASPRESS). O cookiejar do http.cookiejar só
    # envia cookies a domínios correspondentes (sem vazamento cross-domain). O
    # _SafeRedirectHandler revalida cada redirect contra SSRF.
    cj = http.cookiejar.CookieJar()
    opener = _build_safe_opener(urllib.request.HTTPCookieProcessor(cj))

    result = _fetch_url(url, opener=opener)
    if not result:
        return None
    data, content_type, final_url = result

    if final_url != url:
        log.info(f"    Redirecionou para: {final_url[:80]}")

    # Caso 1: PDF direto (checa assinatura %PDF independente do Content-Type)
    if b"%PDF" in data[:32]:
        return _save_pdf_data(data, sender_email, subject, received_at)

    # Caso 2: portal BRASPRESS — a página inicial setou o JSESSIONID; agora baixa
    # a fatura pela URL direta (mesma sessão/cookies).
    bp_url = _braspress_download_url(url)
    if bp_url:
        log.info(f"    Portal BRASPRESS — baixando fatura: {bp_url[:80]}")
        inner = _fetch_url(bp_url, timeout=60, opener=opener)
        if inner and b"%PDF" in inner[0][:32]:
            return _save_pdf_data(inner[0], sender_email, subject, received_at)
        log.info(f"    Download BRASPRESS não retornou PDF")

    # Caso 3: página HTML intermediária — busca link PDF na página
    is_html = "text/html" in content_type or b"<html" in data[:200].lower()
    if not is_html:
        log.info(f"    Conteúdo não reconhecido (tipo: {content_type[:40]})")
        return None

    log.info(f"    Página HTML recebida — buscando link PDF interno")
    html_text = data.decode("utf-8", errors="replace")
    for m in _LINK_HREF_RE.finditer(html_text):
        # Desescapa &amp; etc. — ex.: SIEG linka o boleto na Vindi (?b=…&m=…&t=…),
        # cujos parâmetros quebrariam se mantidos como &amp;.
        inner_url   = html_unescape(m.group(1).strip())
        anchor_text = re.sub(r"<[^>]+>", "", m.group(2)).strip()
        if not inner_url.startswith("http"):
            continue
        url_path = inner_url.lower().split("?")[0]
        if (url_path.endswith(".pdf")
                or _LINK_URL_RE.search(inner_url)
                or _LINK_TEXT_RE.search(anchor_text)):
            log.info(f"    Candidato na página: {inner_url[:70]}")
            inner = _fetch_url(inner_url, opener=opener)
            if inner and b"%PDF" in inner[0][:32]:
                return _save_pdf_data(inner[0], sender_email, subject, received_at)

    log.info(f"    Nenhum PDF encontrado na página HTML")
    return None


# ---------------------------------------------------------------------------
# Acionar extract_pdf (IN-PROCESS)
# ---------------------------------------------------------------------------
# A extração roda no MESMO processo do chamador — NÃO mais via subprocesso
# `python extract_pdf.py`. Motivo (busca geral 2026-06-22): o spawn de subprocesso
# partindo do processo do Flask falhava 100% com rc=0xC0000142 (STATUS_DLL_INIT_FAILED),
# o subprocesso nem inicializava (DLLs nativas de pandas/Pillow não carregavam naquele
# contexto). Chamar a função diretamente elimina a criação de processo — funciona
# idêntico no app (Flask), no CLI/terminal e no scheduler. Bônus: sem reimport de
# pdfplumber/pandas/anthropic a cada PDF, e sem o problema de encoding do pipe.
#
# Robustez mantida: falha transitória (I/O, lib nativa) repete com backoff; falha
# definitiva (PDF sem registros extraíveis) não repete. O motivo é propagado para
# gravar em email_processing_errors.
EXTRACTION_MAX_ATTEMPTS = 3
EXTRACTION_RETRY_BACKOFF = (2, 5)  # segundos de espera entre tentativas


def pdf_password_candidates(cnpj: "str | None") -> list[str]:
    """Senhas candidatas para boletos protegidos, na ordem pedida: CNPJ[:4], [:5], [:6].
    Regra de negócio (boletos de cobrança costumam pedir os N primeiros dígitos do CNPJ
    do pagador). Sem CNPJ com ao menos 6 dígitos → lista vazia (não tenta abrir cifrado)."""
    if not isinstance(cnpj, str):
        return []
    digits = re.sub(r"\D", "", cnpj)
    if len(digits) < 6:
        return []
    return [digits[:4], digits[:5], digits[:6]]


def _run_extraction_once(pdf_path: Path, pdf_passwords: list[str] | None = None) -> tuple[str | None, str | None, bool]:
    """Uma tentativa de extração IN-PROCESS. Retorna (csv_path, motivo_falha, transitorio).

    `transitorio=True` indica que vale repetir (exceção de I/O/runtime); `False` é
    falha definitiva (extração não gerou registros — repetir não muda). Usa diretório
    de saída temporário exclusivo, evitando CSV obsoleto de run anterior.
    """
    try:
        # Import lazy: só carrega pdfplumber/pandas/anthropic quando há PDF a extrair
        # (mantém o import do read_emails leve — mesmo padrão de _normalize_body_barcode).
        if str(EXTRACT_SCRIPT.parent) not in sys.path:
            sys.path.insert(0, str(EXTRACT_SCRIPT.parent))
        import extract_pdf  # noqa: E402

        with tempfile.TemporaryDirectory(dir=CSV_OUTPUT) as tmp_out:
            csv_path = extract_pdf.extract_to_csv(pdf_path, tmp_out, pdf_passwords=pdf_passwords)
            if not csv_path or not Path(csv_path).exists():
                # Sem CSV = nenhum registro válido (PDF ilegível/sem dados). Definitivo.
                return None, "extração não gerou registros (PDF ilegível ou sem dados)", False
            # Move o CSV para o diretório definitivo antes que o tempdir seja removido
            final = CSV_OUTPUT / Path(csv_path).name
            Path(csv_path).replace(final)
            return str(final), None, False
    except Exception as e:
        return None, f"exceção na extração in-process: {e}", True


def run_extraction(pdf_path: Path, pdf_passwords: list[str] | None = None) -> tuple[str | None, str | None]:
    """Executa extract_pdf in-process e retorna (csv_path, motivo_falha).

    Em sucesso: (caminho_do_csv, None). Em falha: (None, motivo). Repete falhas
    transitórias com backoff — um blip de I/O/runtime não perde o PDF. O motivo
    final é gravado em email_processing_errors (observável em /erros), em vez de
    só no console do Flask.
    """
    if not EXTRACT_SCRIPT.exists():
        msg = f"extract_pdf.py não encontrado: {EXTRACT_SCRIPT}"
        log.warning(msg)
        return None, msg

    reason = None
    for attempt in range(1, EXTRACTION_MAX_ATTEMPTS + 1):
        csv_path, reason, transient = _run_extraction_once(pdf_path, pdf_passwords)
        if csv_path:
            return csv_path, None
        if not transient or attempt == EXTRACTION_MAX_ATTEMPTS:
            break
        wait = EXTRACTION_RETRY_BACKOFF[min(attempt - 1, len(EXTRACTION_RETRY_BACKOFF) - 1)]
        log.warning(
            f"    extração falhou (tentativa {attempt}/{EXTRACTION_MAX_ATTEMPTS}): "
            f"{reason} — repetindo em {wait}s"
        )
        time.sleep(wait)

    log.error(f"    extração falhou definitivamente: {reason}")
    return None, reason


def _email_has_real_boleto(rows: list) -> bool:
    """True quando ALGUMA linha extraida do e-mail traz um BOLETO REAL (linha
    digitavel valida). Base da regra fatura+boleto: havendo boleto, as linhas sem
    boleto (fatura/relatorio do mesmo debito) sao ignoradas. Usa o CODIGO DE BARRAS
    (nao o document_type — o extrator rotula relatorio e boleto ambos como 'boleto')."""
    return any(_is_boleto_barcode(r.get("barcode")) for r in rows)


def _amount_key(value) -> float | None:
    """Normaliza um valor monetario para comparacao (float 2 casas) ou None."""
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _real_boleto_amounts(rows: list) -> set:
    """Conjunto dos VALORES dos boletos REAIS (linha digitavel valida) do e-mail.
    A regra fatura+boleto so descarta uma linha SEM boleto proprio quando ela tem o
    MESMO valor de um boleto real — a fatura/relatorio do MESMO debito. Uma linha de
    valor DISTINTO e outra divida e deve ser mantida mesmo sem barcode (ex.: 2o boleto
    ESCANEADO cujo Vision nao leu a linha digitavel — caso LMED 2937 R$2476,55 +
    1748 R$1166,67). Sem isso, o 2o boleto era descartado silenciosamente."""
    return {
        _amount_key(r.get("amount"))
        for r in rows
        if _is_boleto_barcode(r.get("barcode"))
    } - {None}


# Baixa/cancelamento de RECEBIVEL proprio — e-mail sobre titulos que a EMPRESA
# EMITIU (relatorio de baixa/cancelamento), nao um documento que ela deve pagar.
# Sinais: assunto de cobranca propria ("COBRANCA OTIMOTEX") ou o proprio relatorio
# de baixa na descricao. NAO e conta a pagar → ignorado (nao 'sem_fornecedor').
_RECEIVABLE_SUBJECT_TERMS = ("cobranca otimotex", "cobrancas nao enviadas")
_RECEIVABLE_DESC_RE = re.compile(
    r"cancelamento \(baixa\)|titulos? baixad|boletos? baixad"
)


def _is_receivable_notice(subject: str | None, description: str | None) -> bool:
    """True se o e-mail e um AVISO/relatorio de baixa de RECEBIVEL proprio (titulo
    que a empresa emitiu), nunca conta a pagar. Comparacao sem acento."""
    subj = _strip_accents_lower(subject or "")
    if any(t in subj for t in _RECEIVABLE_SUBJECT_TERMS):
        return True
    return bool(_RECEIVABLE_DESC_RE.search(_strip_accents_lower(description or "")))


# 'Documento' visual que NAO e conta a pagar: imagem de assinatura/logo de e-mail
# (image001.png colada no corpo) ou apresentacao/proposta de marketing — lidos via
# Vision, sem valor. So dispara quando amount<=0 E sem codigo de barras: um recibo/
# boleto legitimo (inclusive inline) tem valor e/ou linha digitavel, entao nao cai aqui.
_SIGNATURE_DESC_RE = re.compile(
    r"assinatura de e-?mail|assinatura comercial|assinatura de rodape|"
    r"logotipo|logomarca|rodape de e-?mail|cabecalho de e-?mail"
)
_MARKETING_DESC_RE = re.compile(
    r"apresentac[ao]{2} (institucional|comercial|de servicos|da empresa)|"
    r"proposta comercial|material (de )?marketing|institucional da|catalogo de produtos"
)


def _nonpayable_visual_amount(value) -> float:
    """Converte o amount (string do CSV, decimal com ponto) em float; 0.0 se invalido."""
    try:
        return float(str(value or "0").replace(",", "."))
    except (TypeError, ValueError):
        return 0.0


def _is_nonpayable_visual(row: dict) -> bool:
    """True para conteudo visual sem valor que nao e conta a pagar (assinatura/logo
    de e-mail ou apresentacao/proposta de marketing). Conservador: exige amount<=0 e
    ausencia de codigo de barras para nao afetar recibo/boleto legitimo."""
    if _nonpayable_visual_amount(row.get("amount")) > 0:
        return False
    if _is_boleto_barcode(row.get("barcode")):
        return False
    desc = _strip_accents_lower(row.get("description") or "")
    return bool(_SIGNATURE_DESC_RE.search(desc) or _MARKETING_DESC_RE.search(desc))


def extract_and_store_accounts(saved_pdfs: list, message_id: str,
                               ctrl: "SupabaseControl",
                               email_rec: dict = None) -> tuple:
    """Extrai cada PDF e grava as contas resultantes em financial_account_control.

    Liga cada conta ao e-mail por gmail_message_id; multiplos PDFs no mesmo
    e-mail recebem sufixo (#1, #2, ...) para nao colidir na chave unica.
    Emails defeituosos sao logados em email_processing_errors e pulados.
    Retorna (lista de CSVs gerados, total de contas gravadas, nonpayable_only,
    attachment_account).

    `nonpayable_only` = True quando TODO registro extraido foi pulado como
    NAO-PAGAVEL (NF-e/NFS-e ou CT-e/transporte sem boleto) e NENHUM registro pagavel
    foi tentado — sinaliza o chamador a marcar o e-mail 'ignorado' (nao 'falha'). Se
    houve um boleto que falhou por sem_valor/sem_fornecedor, NAO e nonpayable_only
    (segue 'falha' para revisao).

    `attachment_account` = True quando um PDF anexado produziu uma conta pagavel que
    foi EFETIVAMENTE tratada — gravada como nova OU casada/atualizada por dedup contra
    uma conta ja existente (mesmo documento chegado por outro e-mail). "O boleto sempre
    vence o corpo": quando isto e True o chamador NAO deve rodar o fallback do corpo,
    pois o anexo ja respondeu pelo(s) pagavel(is) do e-mail. Antes o gate usava so
    accounts_saved (contas NOVAS), entao um boleto deduplicado (accounts_saved==0)
    deixava o corpo criar uma conta espuria com dados divergentes (ex.: vencimento
    lido do texto do corpo, sem o barcode) — id 510 (OBER): corpo gravou venc. 11/07
    duplicando o boleto id 159 (venc. 18/07 pelo fator do codigo de barras).
    """
    csvs_ok, accounts_saved, acc_index = [], 0, 0
    skipped_nonpayable, payable_attempts, dup_matches = 0, 0, 0
    err_ctx = email_rec or {}

    # Senhas candidatas (CNPJ[:4]/[:5]/[:6] do pagador) para boletos protegidos —
    # computadas uma vez por e-mail; vazias quando o CNPJ não está disponível.
    pdf_passwords = pdf_password_candidates(ctrl.company_cnpj())

    # ------------------------------------------------------------------
    # Passo 1 — extrai TODOS os anexos e coleta as linhas. Upload no Storage
    # + extracao acontecem aqui; a decisao de gravar cada conta fica para o
    # passo 2, que precisa enxergar o e-mail INTEIRO (regra fatura+boleto).
    # ------------------------------------------------------------------
    pending = []  # linhas extraidas de todos os PDFs do e-mail, na ordem de chegada
    for pdf_path in saved_pdfs:
        # Publica o PDF no Storage SEMPRE (antes da extracao) — assim o anexo fica
        # disponivel para revisao manual mesmo quando a extracao falha por completo.
        # Nao-fatal: se o upload falhar, a extracao segue normalmente.
        ctrl.upload_attachment(pdf_path)

        csv_path, extract_err = run_extraction(pdf_path, pdf_passwords)
        if not csv_path:
            ctrl.register_error(
                {**err_ctx, "source_file": pdf_path.name},
                "extracao_falhou",
                f"extract_pdf nao gerou CSV para {pdf_path.name}",
                raw_payload={"source_file": pdf_path.name, "detalhe": extract_err},
            )
            continue

        csvs_ok.append(csv_path)
        for row in read_extracted_rows(csv_path):
            # Falha de API na extracao: registra erro_api e interrompe o run com
            # seguranca (sem gravar conta, sem fallback regex silencioso).
            if (row.get("extraction_source") or "").strip().lower() == "erro_api":
                ctrl.register_error(
                    {**err_ctx, "source_file": row.get("source_file")},
                    "erro_api",
                    row.get("processing_notes")
                    or "API Anthropic indisponível (crédito/auth/limite)",
                    raw_payload=row,
                )
                raise ApiUnavailableError(
                    row.get("processing_notes") or "API Anthropic indisponível"
                )
            pending.append(row)

    # Regra FATURA + BOLETO (multi-anexo): quando ALGUM anexo do e-mail traz um
    # BOLETO REAL (linha digitavel valida), a fatura/relatorio do MESMO debito e
    # ignorada ("o boleto sempre vence"). Sozinha (sem boleto), a fatura e extraida.
    # O sinal e o CODIGO DE BARRAS + o VALOR: o descarte so vale para a linha SEM
    # boleto proprio cujo valor COINCIDE com um boleto real (mesmo debito). Uma linha
    # de valor DISTINTO e outra divida e e mantida mesmo sem barcode — cobre o 2o
    # boleto ESCANEADO cujo Vision nao leu a linha digitavel (caso LMED, valores
    # 2476,55 x 1166,67). Antes, bastava existir 1 boleto real p/ descartar QUALQUER
    # linha sem barcode, perdendo o 2o boleto silenciosamente.
    has_real_boleto = _email_has_real_boleto(pending)
    real_boleto_amounts = _real_boleto_amounts(pending) if has_real_boleto else set()

    # ------------------------------------------------------------------
    # Passo 2 — grava as contas
    # ------------------------------------------------------------------
    for row in pending:
        dtype = (row.get("document_type") or "").strip().lower()
        if dtype in SKIP_ACCOUNT_TYPES:
            log.info(f"    {dtype.upper()} ignorado — nao gera conta a pagar")
            skipped_nonpayable += 1
            continue

        gmid    = message_id if acc_index == 0 else f"{message_id}#{acc_index}"
        payload = build_financial_payload(row, gmid, received_at=err_ctx.get("received_at"),
                                          subject=err_ctx.get("subject"))
        # Remetente do e-mail → o trigger alinha supplier.email (migration 023).
        payload["sender_email"] = err_ctx.get("sender_email")
        payload["subject"]      = err_ctx.get("subject")  # exibido/buscado em /consulta (migration 025)
        ctx     = {**err_ctx, "source_file": row.get("source_file")}

        # CT-e / transporte SEM boleto NAO gera conta a pagar (regra 1): o CT-e e
        # documento fiscal; so o boleto de frete e pagavel. supplier_name ainda
        # existe no payload aqui (removido so em _finalize_supplier). Um boleto de
        # transporte ja foi rotulado 'cte' em build_financial_payload e TEM barcode
        # de boleto — logo NAO cai aqui.
        if (_is_transport_context(err_ctx.get("subject"), payload.get("supplier_name"),
                                  payload.get("document_type"))
                and not _is_boleto_barcode(payload.get("barcode"))):
            log.info("    CT-e/transporte sem boleto ignorado — nao gera conta a pagar")
            skipped_nonpayable += 1
            continue

        # Fatura/relatorio acompanhando um BOLETO no mesmo e-mail → ignorado (regra
        # fatura+boleto). So descarta a linha SEM boleto proprio cujo VALOR coincide
        # com um boleto real do e-mail (mesmo debito). Linha de valor DISTINTO e outra
        # divida → mantida mesmo sem barcode (2o boleto escaneado sem linha digitavel).
        if (not _is_boleto_barcode(payload.get("barcode"))
                and _amount_key(payload.get("amount")) in real_boleto_amounts):
            log.info(
                f"    Fatura/relatorio ignorado — mesmo valor de um boleto no e-mail "
                f"({row.get('source_file')})"
            )
            skipped_nonpayable += 1
            continue

        # Baixa/cancelamento de RECEBIVEL proprio (relatorio de titulos que a empresa
        # EMITIU, ex.: "COBRANCA OTIMOTEX") NAO e conta a pagar → ignorado, sem logar
        # 'sem_fornecedor'. Roda antes das validacoes (o documento nao tem fornecedor
        # justamente por nao ser uma conta a pagar).
        if _is_receivable_notice(err_ctx.get("subject"), row.get("description")):
            log.info("    Baixa/cobranca de recebivel proprio ignorada — nao gera conta a pagar")
            skipped_nonpayable += 1
            continue

        # Conteudo visual sem valor que nao e conta a pagar: imagem de assinatura/logo
        # de e-mail (image001.png) ou apresentacao/proposta de marketing (Vision) →
        # ignorado, sem logar 'sem_valor'.
        if _is_nonpayable_visual(row):
            log.info(f"    Conteudo nao-pagavel (assinatura/marketing) ignorado — {row.get('source_file')}")
            skipped_nonpayable += 1
            continue

        payable_attempts += 1

        # Validacao 1: valor ausente ou zero
        if not payload.get("amount"):
            ctrl.register_error(
                ctx, "sem_valor",
                f"Valor ausente ou zero — {row.get('source_file')}",
                raw_payload=row
            )
            acc_index += 1
            continue

        # Validacao 2: fornecedor nao identificado por NENHUMA chave.
        # Alem de CNPJ/CPF/nome extraidos do PDF, sao chaves validas: o e-mail
        # do remetente (a RPC casa por email/2/3/4 ou cria o fornecedor), o
        # ASSUNTO (favorecido de e-mail interno de pagamento) e, em ultimo
        # recurso, o PAGADOR (payer_name/payer_cnpj). So rejeita quando NAO ha
        # identificador algum — _finalize_supplier tenta todas essas formas.
        # Guia de IMPOSTO tambem passa: mesmo sem nome/CNPJ/CPF/e-mail/assunto/
        # pagador, _finalize_supplier lanca a conta sob a OTIMOTEX (sk=1).
        if not any([payload.get("supplier_cnpj"),
                    payload.get("supplier_cpf"),
                    payload.get("supplier_name"),
                    payload.get("sender_email"),
                    _supplier_name_from_subject(payload.get("subject")),
                    payload.get("payer_name"),
                    payload.get("payer_cnpj"),
                    _is_tax_document(payload.get("document_type"))]):
            ctrl.register_error(
                ctx, "sem_fornecedor",
                f"CNPJ, CPF, nome e e-mail do fornecedor ausentes — {row.get('source_file')}",
                raw_payload=row
            )
            acc_index += 1
            continue

        # Resolve o fornecedor (RPC) → grava sk_supplier e remove as colunas
        # denormalizadas do payload. Roda APOS a validacao sem_fornecedor (que
        # usa os campos brutos) e ANTES da dedup (que casa por sk_supplier).
        if not _finalize_supplier(ctrl, payload):
            ctrl.register_error(
                ctx, "db_erro",
                f"Falha ao resolver fornecedor — {row.get('source_file')}",
                raw_payload=row
            )
            acc_index += 1
            continue

        # Classificacao contabil FORCADA por tipo de documento (IRRF/DUIMP/ICMS Importacao/
        # transporte) — sobrepoe o default do fornecedor e, quando a regra pede, faz write-back
        # no supplier (exceto OTIMOTEX). Roda apos finalize (sk/cc/ca ja setados), antes da dedup.
        apply_forced_classification(ctrl, payload)

        # Dedup de conteudo: o mesmo documento ja gravado por outro e-mail
        # (remetente reenvia o mesmo boleto/guia, com Message-ID diferente).
        # Reemissao com vencimento mais novo (mesma guia) → ATUALIZA a conta
        # existente para o vencimento/boleto atual, em vez de duplicar ou
        # manter dados de pagamento vencidos. Roda ANTES da uniquificacao do
        # invoice_number para nao gravar duplicata.
        dup = ctrl.find_financial_duplicate(payload)
        if dup:
            new_due = payload.get("due_date")
            old_due = dup.get("due_date")
            new_barcode = (payload.get("barcode") or "").strip() or None
            # ISO 'YYYY-MM-DD' compara corretamente como string.
            if new_due and (not old_due or str(new_due) > str(old_due)):
                ctrl.update_financial(dup["id"], {
                    "due_date":       new_due,
                    "barcode":        new_barcode,
                    "amount_charged": payload.get("amount_charged"),
                    "fine_interest":  payload.get("fine_interest"),
                    "other_additions": payload.get("other_additions"),
                })
                log.info(
                    f"    [REEMISSAO] mesma guia — conta atualizada p/ vencimento "
                    f"{new_due} ({row.get('source_file')})"
                )
            elif new_barcode and not (dup.get("barcode") or "").strip():
                # A conta existente (corpo/notificacao) NAO tem linha digitavel e o
                # novo documento e um BOLETO da MESMA divida: grava o barcode/boleto
                # na conta sobrevivente, mesmo com vencimento igual/mais antigo — o
                # boleto sempre vence o corpo. Fecha o gap cross-e-mail sem duplicar.
                ctrl.update_financial(dup["id"], {
                    "barcode":        new_barcode,
                    "amount_charged": payload.get("amount_charged"),
                    "fine_interest":  payload.get("fine_interest"),
                    "other_additions": payload.get("other_additions"),
                })
                log.info(
                    f"    [DUP-DOC] boleto enriquece conta existente com código de "
                    f"barras ({row.get('source_file')})"
                )
            else:
                log.info(
                    f"    [DUP-DOC] reemissão igual/mais antiga — mantido "
                    f"({row.get('source_file')})"
                )
            # O boleto anexado casou uma conta ja existente: o pagavel foi tratado.
            # Conta como conta do anexo → suprime o fallback do corpo (nao regredir:
            # sem isto o corpo criava conta espuria, ex.: id 510).
            dup_matches += 1
            acc_index += 1
            continue

        if payload.get("invoice_number"):
            payload["invoice_number"] = ctrl.unique_invoice_number(payload["invoice_number"])

        if ctrl.register_financial(payload):
            accounts_saved += 1
        else:
            ctrl.register_error(
                ctx, "db_erro",
                f"Falha ao gravar em financial_account_control — {row.get('source_file')}",
                raw_payload=row
            )
        acc_index += 1

    nonpayable_only = skipped_nonpayable > 0 and payable_attempts == 0
    # Anexo respondeu por um pagavel (conta nova OU dedup contra conta existente).
    attachment_account = accounts_saved > 0 or dup_matches > 0
    return csvs_ok, accounts_saved, nonpayable_only, attachment_account


# Resultado da extração pelo corpo (try_extract_from_body) — orienta o status do
# e-mail. Distinguir DUPLICATE de NONE é a regra de negócio que evita marcar como
# 'falha' um e-mail cujo pagável já foi registrado por outro e-mail (ex.: a
# mensagem original e seu RES:/encaminhamento).
BODY_CREATED   = "created"    # conta nova gravada            → 'recebido'
BODY_DUPLICATE = "duplicate"  # pagável duplica conta existente → 'ignorado'
BODY_NONE      = "none"       # sem pagável utilizável         → falha/notificação
BODY_IGNORED   = "ignored"    # CT-e/transporte sem boleto     → 'ignorado' (não pagável)


def try_extract_from_body(email_rec: dict, body_text: str, received_at: str,
                          message_id: str, ctrl: "SupabaseControl",
                          sender_email: str | None = None) -> str:
    """Tenta gravar uma conta extraida do corpo do e-mail (sem PDF valido).

    Retorna um de:
      BODY_CREATED   — conta NOVA gravada (chamador marca 'recebido');
      BODY_DUPLICATE — o pagavel do corpo DUPLICA uma conta ja registrada: nao
                       grava de novo, anota a referencia em email_rec['duplicate_of']
                       e o chamador marca 'ignorado' (nao e falha — a conta existe);
      BODY_NONE      — sem pagavel utilizavel (chamador segue p/ falha/notificacao);
      BODY_IGNORED   — CT-e/transporte SEM boleto: nao e conta a pagar (chamador
                       marca 'ignorado', nao 'falha').
    Anota o motivo em email_rec['notes']. O log em email_processing_errors e feito
    de forma centralizada no chamador (process_message), para TODA falha.
    """
    payload = extract_from_email_body(body_text, received_at, message_id, sender_email,
                                      subject=email_rec.get("subject"))
    if payload is None:
        # Sem sinal financeiro (sem valor nem documento) no corpo.
        email_rec["notes"] = "Corpo sem sinal financeiro (sem valor nem documento)"
        return BODY_NONE

    # Remetente do e-mail → o trigger alinha supplier.email (migration 023).
    payload["sender_email"] = sender_email
    payload["subject"]      = email_rec.get("subject")  # exibido/buscado em /consulta (migration 025)

    # Mesma trava do caminho de PDF: NF-e/NFS-e nao geram conta a pagar.
    # Sem isso, notificacoes de nota fiscal (ex.: NFe da Editora Globo) vazavam
    # para financial_account_control como document_type='outro'.
    dtype = (payload.get("document_type") or "").strip().lower()
    if dtype in SKIP_ACCOUNT_TYPES:
        log.info(f"    {dtype.upper()} (corpo do e-mail) ignorado — nao gera conta a pagar")
        email_rec["notes"] = f"{dtype.upper()} (corpo do e-mail) — nao gera conta a pagar"
        return BODY_NONE

    # CT-e / transporte SEM boleto (corpo) NAO gera conta a pagar (regra 1). O corpo
    # raramente traz linha digitavel; um boleto de transporte ja teria sido rotulado
    # 'cte' com barcode valido em extract_from_email_body → nao cai aqui.
    if (_is_transport_context(email_rec.get("subject"), payload.get("supplier_name"),
                              payload.get("document_type"))
            and not _is_boleto_barcode(payload.get("barcode"))):
        log.info("    CT-e/transporte sem boleto (corpo) ignorado — nao gera conta a pagar")
        email_rec["notes"] = "CT-e/transporte sem boleto (corpo) — nao gera conta a pagar"
        return BODY_IGNORED

    # Mesma validacao de valor do caminho de PDF (extract_and_store_accounts):
    # sem valor nao ha conta a pagar.
    if not payload.get("amount"):
        email_rec["notes"] = "Valor ausente ou zero no corpo do e-mail"
        return BODY_NONE

    # Resolve o fornecedor (RPC) → grava sk_supplier e remove as colunas
    # denormalizadas. ANTES da dedup (que casa por sk_supplier). Falha de
    # resolucao → trata como sem pagavel utilizavel (chamador segue p/ falha).
    if not _finalize_supplier(ctrl, payload):
        email_rec["notes"] = "Falha ao resolver fornecedor do corpo do e-mail"
        return BODY_NONE

    # Classificacao contabil FORCADA por tipo de documento (IRRF/DUIMP/ICMS Importacao/
    # transporte). Passa o corpo (body_text) como texto extra alem de assunto/descricao.
    # Roda no payload base, ANTES do bloco de parcelas — os clones herdam cost_center_id/
    # chart_account_id.
    apply_forced_classification(ctrl, payload, extra_text=body_text)

    # MÚLTIPLOS boletos no corpo (tabela de parcelas com documentos/vencimentos
    # diferentes): cria UMA conta por boleto — NUNCA uma conta somada com o total
    # (regra de negócio). Reusa o fornecedor já resolvido (payload base) e sobrescreve
    # nº do documento (doc/parcela), valor, vencimento e emissão por linha. Cada linha
    # passa pela mesma dedup de conteúdo. Sem barcode (o corpo não traz a linha
    # digitável — só o PDF; por isso o caminho de PDF descriptografado é preferível).
    installments = _extract_body_installments(body_text)
    if len(installments) >= 2:
        created = dups = 0
        for inst in installments:
            row = dict(payload)
            num = f"{inst['doc']}/{inst['parcela']}" if inst.get("parcela") else inst["doc"]
            row["invoice_number"] = num
            row["amount"]   = inst["amount"]
            row["due_date"] = inst["due_date"] or row.get("due_date")
            if inst.get("issue_date"):
                row["issue_date"] = inst["issue_date"]
            if ctrl.find_financial_duplicate(row):
                dups += 1
                continue
            row["invoice_number"] = ctrl.unique_invoice_number(num)
            if ctrl.register_financial(row):
                created += 1
        if created:
            email_rec["notes"] = f"{created} conta(s) (parcelas) extraída(s) do corpo do e-mail"
            return BODY_CREATED
        if dups:
            email_rec["notes"] = "Parcelas do corpo já registradas (duplicata)"
            return BODY_DUPLICATE
        # Nenhuma criada nem duplicada → cai para o caminho de conta única abaixo.

    # Dedup de conteudo: o MESMO pagavel ja registrado por outro e-mail (a
    # mensagem original e seu RES:/encaminhamento, p.ex.). NAO e falha — a conta
    # existe; sinaliza para o e-mail virar 'ignorado' (duplicata), nao 'falha'.
    dup = ctrl.find_financial_duplicate(payload)
    if dup:
        dup_id = dup.get("id")
        log.info(f"    [DUP-DOC] conta do corpo já registrada (id {dup_id}) — e-mail será 'ignorado'")
        email_rec["notes"] = f"Duplicata — conta já registrada (id {dup_id})"
        email_rec["duplicate_of"] = dup_id
        return BODY_DUPLICATE

    if payload.get("invoice_number"):
        payload["invoice_number"] = ctrl.unique_invoice_number(payload["invoice_number"])

    if ctrl.register_financial(payload):
        log.info("    Conta extraída do corpo do e-mail e gravada em financial_account_control")
        return BODY_CREATED

    email_rec["notes"] = "Falha ao gravar conta extraida do corpo do e-mail"
    return BODY_NONE

# ---------------------------------------------------------------------------
# Processar um e-mail
# ---------------------------------------------------------------------------
def _parse_internaldate(fetch_meta: bytes | None) -> str | None:
    """Converte o INTERNALDATE do IMAP para ISO-8601 UTC.

    INTERNALDATE e a hora em que a mensagem chegou na caixa postal — definida
    pelo servidor, imune ao relogio (ou a header Date adulterado) do remetente.
    Usa imaplib.Internaldate2tuple (independente de locale) em vez de strptime
    com %b, que falharia sob locale pt-BR. Retorna None se ausente/invalido.
    """
    if not fetch_meta:
        return None
    try:
        tt = imaplib.Internaldate2tuple(fetch_meta)  # struct_time em horario local
        if not tt:
            return None
        epoch = time.mktime(tt)
        return datetime.fromtimestamp(epoch, timezone.utc).isoformat()
    except Exception:
        return None


def _received_at_from(meta: bytes | None, date_header: str) -> str:
    """received_at canonico: INTERNALDATE (chegada na caixa postal) e a fonte
    primaria — confiavel mesmo com o header Date do remetente adulterado ou com
    fuso errado. O header Date e fallback; nunca grava data futura. Usada tanto no
    process_message quanto no registro de e-mails 'ignorado', para que /emails
    fique na MESMA ordem da caixa postal (o grid ordena por received_at desc)."""
    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    internal_iso = _parse_internaldate(meta)
    try:
        header_dt = parsedate_to_datetime(date_header).astimezone(timezone.utc)
    except Exception:
        header_dt = None

    if internal_iso:
        received_at = internal_iso
    elif header_dt is not None and header_dt <= now_dt:
        received_at = header_dt.isoformat()
    else:
        received_at = now

    # Rede de seguranca: jamais gravar received_at no futuro.
    try:
        if datetime.fromisoformat(received_at) > now_dt:
            received_at = now
    except Exception:
        received_at = now
    return received_at


def status_for_result(has_attachment: bool, csv_generated: bool,
                       body_created: bool, pure_nfe: bool = False,
                       accounts_saved: int = 0, notification: bool = False,
                       duplicate: bool = False, nonpayable: bool = False) -> str:
    """Deriva email_control.status a partir do resultado real do processamento.

    Prioridade (CHECK migration 022): conta do PDF > conta do corpo > NF-e pura
    sem conta > CSV sem conta nova > anexo sem conta.

      - accounts_saved -> 'extraído'  (conta(s) a pagar gravada(s) do PDF)
      - pure_nfe       -> 'ignorado'  (assunto NF-e/NFS-e puro, sem pagavel e sem
                                       conta: notificacao fiscal, nao e conta a pagar)
      - nonpayable     -> 'ignorado'  (CT-e/transporte sem boleto — documento fiscal,
                                       nao e conta a pagar; vem ANTES de csv_generated
                                       porque o PDF do CT-e gera CSV sem conta)
      - csv_generated  -> 'extraído'  (PDF lido — conta nova ou reemissao deduplicada)
      - body_created   -> 'recebido'     (conta extraida do corpo do e-mail)
      - duplicate      -> 'duplicidade'  (pagavel do corpo duplica conta ja registrada)
      - has_attachment -> 'pendente'  (PDF salvo, aguardando reprocessamento)
      - notification   -> 'ignorado'  (sem anexo/conta: notificacao/aviso, nao pagavel)
      - nenhum         -> 'falha'     (casou keyword, mas nada foi gerado)

    'accounts_saved' vem primeiro para nao esconder conta real de um e-mail cujo
    assunto parece NF-e pura mas que de fato gerou conta (NF-e + boleto). NF-e/
    NFS-e estao em SKIP_ACCOUNT_TYPES (nunca viram conta), entao 'pure_nfe' vem
    antes do 'csv_generated' que o PDF de NF-e sempre produz. 'csv_generated'
    segue tendo precedencia sobre 'body_created' (comportamento da migration 022).
    'notification' fica no lugar do antigo 'falha' (sem anexo, sem CSV, sem conta):
    avisos/confirmacoes/informes sem pagavel viram 'ignorado' em vez de 'falha'.
    """
    if accounts_saved > 0:
        return "extraído"
    if pure_nfe:
        return "ignorado"
    # CT-e/transporte sem boleto (ou NF-e/NFS-e pulada): documento nao-pagavel — vem
    # ANTES de csv_generated, pois o PDF do CT-e gera CSV mas nenhuma conta (seria
    # 'extraído', errado). Ver regra 1 do CTe.
    if nonpayable:
        return "ignorado"
    if csv_generated:
        return "extraído"
    if body_created:
        return "recebido"
    # Pagável do corpo duplica conta já registrada por outro e-mail: a conta
    # existe, então NÃO é falha — vira 'duplicidade' (status próprio). Vem antes
    # de 'has_attachment' porque "já registrada" descreve melhor que "pendente".
    if duplicate:
        return "duplicidade"
    if has_attachment:
        return "pendente"
    if notification:
        return "ignorado"
    return "falha"


def _rfc822_from_fetch(data: list) -> "tuple[bytes | None, bytes]":
    """Extrai (meta, raw) do retorno de um FETCH '(INTERNALDATE RFC822)'.

    O imaplib pode INTERCALAR respostas (ex.: um FLAGS/UID isolado como item
    `bytes`) no meio do resultado. Quando o primeiro item nao e a tupla
    (meta, raw), `data[0][1]` indexa um `bytes` e devolve um INT — e
    `email.message_from_bytes(int)` chama `.decode()` internamente, quebrando com
    "'int' object has no attribute 'decode'". Por isso pegamos o primeiro item
    que seja uma tupla cujo segundo elemento sejam bytes (o conteudo RFC822)."""
    for item in data or []:
        if (isinstance(item, tuple) and len(item) >= 2
                and isinstance(item[1], (bytes, bytearray))):
            return item[0], bytes(item[1])
    raise ValueError("FETCH nao retornou conteudo RFC822")


def process_message(mail, uid: bytes, keywords: list,
                    dry_run: bool, mark_seen: bool,
                    ctrl: SupabaseControl) -> dict | None:
    now = datetime.now(timezone.utc).isoformat()
    rec = {c: None for c in LOG_COLUMNS}
    rec["processed_at"] = now

    try:
        _, data = mail.uid("fetch", uid, "(INTERNALDATE RFC822)")
        meta, raw = _rfc822_from_fetch(data)
        msg = email.message_from_bytes(raw)

        uid_str      = uid.decode() if isinstance(uid, (bytes, bytearray)) else str(uid)
        message_id   = msg.get("Message-ID", f"no-id-{uid_str}").strip()
        subject      = decode_str(msg.get("Subject", "(sem assunto)"))
        from_raw     = msg.get("From", "")
        sender_name, sender_email = parseaddr(from_raw)
        sender_name  = decode_str(sender_name) or sender_email
        date_header  = msg.get("Date", "")

        # received_at canonico (INTERNALDATE -> header Date -> agora; nunca futuro).
        received_at = _received_at_from(meta, date_header)

        body_text    = get_body_text(msg)
        # E-mail SO-HTML (ex.: Correios): sem texto plano, extrai do HTML para que
        # o fallback de corpo (try_extract_from_body) encontre valor/fatura/etc.
        if not body_text:
            body_text = _html_to_text(get_body_html(msg))
        keyword_hit  = match_keyword(subject, keywords)

        rec.update({
            "message_id":     message_id,
            "received_at":    received_at,
            "sender_name":    sender_name,
            "sender_email":   sender_email,
            "subject":        subject,
            "body_preview":   body_text[:500].replace("\n", " "),
            "keyword_matched": keyword_hit,
        })

        if dry_run:
            rec["notes"] = "dry-run"
            return rec

        # Baixar PDFs e acionar extração
        saved_pdfs = save_attachments(msg, sender_email, subject, received_at)

        # Sem anexo direto: tentar baixar PDF de links no corpo do e-mail
        link_downloaded = False
        if not saved_pdfs:
            body_html = get_body_html(msg)
            pdf_links = extract_pdf_links(body_text, body_html)
            if pdf_links:
                log.info(f"    {len(pdf_links)} link(s) candidato(s) encontrado(s) no corpo")
            else:
                log.info(f"    Sem links candidatos no corpo do e-mail")
            for url in pdf_links:
                log.info(f"    Tentando link: {url[:80]}")
                pdf_path = download_pdf_from_url(url, sender_email, subject, received_at)
                if pdf_path:
                    saved_pdfs.append(pdf_path)
                    link_downloaded = True

        # Sem PDF (anexo nem link): tenta a MAIOR imagem INLINE do corpo (recibo/
        # comprovante colado), lida via Claude Vision. Prioridade: anexo → link →
        # imagem inline → corpo. Fora desse fallback, imagens inline (logos de
        # assinatura) nunca são processadas — evita chamadas Vision desnecessárias.
        inline_image = False
        if not saved_pdfs:
            inline_imgs = save_inline_images(msg, sender_email, subject, received_at)
            if inline_imgs:
                saved_pdfs.extend(inline_imgs)
                inline_image = True

        att_names = [p.name for p in saved_pdfs]
        has_att   = len(saved_pdfs) > 0

        rec["has_attachment"]   = has_att
        rec["attachment_names"] = " | ".join(att_names) if att_names else None
        rec["attachment_saved"] = has_att
        if link_downloaded:
            rec["notes"] = "PDF baixado de link no corpo do e-mail"
        elif inline_image:
            rec["notes"] = "Imagem inline do corpo lida via Vision"

        csvs_ok, accounts_saved, nonpayable_only, attachment_account = extract_and_store_accounts(
            saved_pdfs, message_id, ctrl, email_rec=rec)

        csv_generated = len(csvs_ok) > 0
        rec["pdf_extracted"]  = csv_generated
        rec["extraction_csv"] = " | ".join(csvs_ok) if csvs_ok else None
        if accounts_saved:
            log.info(f"    {accounts_saved} conta(s) gravada(s) em financial_account_control")

        if not has_att:
            rec["notes"] = "Sem anexo PDF — registrado para revisão"

        # Corpo é fallback SOMENTE quando o anexo NÃO respondeu por nenhum pagável.
        # "O boleto sempre vence o corpo": `attachment_account` cobre tanto a conta
        # NOVA gravada quanto o boleto DEDUPLICADO contra uma conta já existente
        # (mesmo documento por outro e-mail). Antes o gate usava só accounts_saved,
        # então um boleto deduplicado (accounts_saved==0) deixava o corpo criar uma
        # conta espúria com vencimento divergente — ex.: id 510 (OBER) duplicou o
        # boleto id 159 com data errada. try_extract_from_body valida fornecedor+valor.
        body_outcome = BODY_NONE
        if not attachment_account:
            body_outcome = try_extract_from_body(rec, body_text, received_at, message_id, ctrl,
                                                 sender_email=sender_email)
            if body_outcome == BODY_CREATED:
                rec["pdf_extracted"] = True
                rec["notes"]         = "Conta extraída do corpo do e-mail"
        body_created = body_outcome == BODY_CREATED

        # Status (CHECK migration 022): conta do PDF > conta do corpo > duplicata >
        # anexo sem conta. A conta vinda do corpo (body_created) prevalece sobre o
        # anexo que nao gerou CSV; uma duplicata do corpo (pagavel ja registrado
        # por outro e-mail) vira 'ignorado' em vez de 'falha'.
        rec["status"] = status_for_result(
            has_att, csv_generated, body_created,
            pure_nfe=subject_is_pure_nfe(subject), accounts_saved=accounts_saved,
            notification=subject_is_ignorable_notification(subject),
            duplicate=(body_outcome == BODY_DUPLICATE),
            nonpayable=(nonpayable_only or body_outcome == BODY_IGNORED))

        # Regra: TODA falha gera log em email_processing_errors para revisão —
        # inclusive o corpo sem sinal financeiro, que antes saía silencioso.
        # try_extract_from_body anota o motivo em rec["notes"]. O caminho de
        # exceção tem seu próprio log abaixo (não passa por aqui).
        if rec["status"] == "falha":
            ctrl.register_error(
                rec, "falha_processamento",
                rec.get("notes") or "E-mail casou keyword mas nenhuma conta foi gerada",
                raw_payload={
                    "subject":         rec.get("subject"),
                    "keyword_matched": rec.get("keyword_matched"),
                    "has_attachment":  rec.get("has_attachment"),
                    "body_preview":    rec.get("body_preview"),
                },
            )

        if mark_seen:
            mail.uid("store", uid, "+FLAGS", "\\Seen")

    except ApiUnavailableError:
        # Erro de API ja registrado em email_processing_errors. Propaga para
        # interromper o run com seguranca: NAO grava em email_control nem no CSV,
        # entao o e-mail sera reprocessado quando a API voltar.
        raise
    except Exception as e:
        rec["notes"] = f"Erro: {str(e)[:200]}"
        log.error(f"  Erro UID {uid}: {e}")
        ctrl.register_error(rec, "processamento_erro", str(e))

    # O status já foi definido em process_message (extraído/recebido/pendente/falha).
    # No caminho de exceção fica a cargo de _derive_status (→ 'falha').
    ctrl.register(rec)
    append_log_csv(rec)
    return rec


# ---------------------------------------------------------------------------
# Execução reutilizável (CLI + API)
# ---------------------------------------------------------------------------

# Timeout de socket do IMAP (segundos). SEM ele, um fetch que estanca (mensagem
# muito grande, hiccup do servidor) bloqueia o run inteiro indefinidamente — foi
# o que travou um run no e-mail de 3 faturas + XMLs. Com timeout, a operação
# levanta socket.timeout, o e-mail é pulado/erra e o run segue em vez de congelar.
IMAP_TIMEOUT_SECONDS = int(os.getenv("IMAP_TIMEOUT", "120"))

# Retry/backoff para falhas TRANSITÓRIAS do IMAP (timeout de socket, conexão
# derrubada). Sem isso, um hiccup de rede no connect/select/search derrubava o
# run inteiro; com retry, a sequência é refeita com espera crescente.
IMAP_MAX_ATTEMPTS  = int(os.getenv("IMAP_MAX_ATTEMPTS", "3"))
IMAP_RETRY_BACKOFF = float(os.getenv("IMAP_RETRY_BACKOFF", "5"))

# Falhas transitórias: socket.timeout é subclasse de OSError/TimeoutError;
# imaplib.IMAP4.abort sinaliza conexão abortada pelo servidor. NÃO inclui
# imaplib.IMAP4.error puro (login/mailbox inválidos) — retry ali é inútil.
_IMAP_TRANSIENT = (socket.timeout, OSError, imaplib.IMAP4.abort)


def _connect_imap() -> imaplib.IMAP4_SSL:
    """Conecta/autentica no IMAP com timeout de socket e seleciona a caixa."""
    mail = imaplib.IMAP4_SSL(
        os.getenv("IMAP_HOST"),
        int(os.getenv("IMAP_PORT", 993)),
        timeout=IMAP_TIMEOUT_SECONDS,
    )
    mail.login(os.getenv("IMAP_USER"), os.getenv("IMAP_PASS"))
    mail.select(os.getenv("IMAP_MAILBOX", "INBOX"))
    return mail


def _safe_logout(mail) -> None:
    """Fecha a conexão IMAP ignorando erros (usado entre tentativas de retry)."""
    if mail is None:
        return
    try:
        mail.logout()
    except Exception:
        pass


def _connect_and_search(criteria: str):
    """Conecta no IMAP e roda o `search`, com retry/backoff em falha transitória.

    Cobre connect + select + search numa única unidade resiliente: um timeout ou
    queda em qualquer dessas etapas refaz a sequência (nova conexão) até
    IMAP_MAX_ATTEMPTS, com espera de IMAP_RETRY_BACKOFF * tentativa. Erro de
    protocolo/login (imaplib.IMAP4.error) NÃO é repetido. Retorna (mail, uids);
    levanta RuntimeError ao esgotar (o chamador HTTP devolve 502)."""
    last_err = None
    for attempt in range(1, IMAP_MAX_ATTEMPTS + 1):
        mail = None
        try:
            mail = _connect_imap()
            _, uids_data = mail.uid("search", None, criteria)
            uids = uids_data[0].split() if uids_data and uids_data[0] else []
            log.info(f"IMAP conectado (tentativa {attempt}/{IMAP_MAX_ATTEMPTS})")
            return mail, uids
        except _IMAP_TRANSIENT as ex:
            # Transitório (timeout/queda/abort) — refaz a sequência abaixo.
            # _IMAP_TRANSIENT inclui IMAP4.abort, por isso vem ANTES de IMAP4.error.
            last_err = ex
        except imaplib.IMAP4.error as ex:
            # Protocolo/login (credenciais, mailbox inválida): retry é inútil.
            _safe_logout(mail)
            raise RuntimeError(f"Falha na conexão IMAP: {ex}") from ex

        _safe_logout(mail)
        if attempt < IMAP_MAX_ATTEMPTS:
            wait = IMAP_RETRY_BACKOFF * attempt
            log.warning(
                f"  IMAP transitório (tentativa {attempt}/{IMAP_MAX_ATTEMPTS}): "
                f"{last_err} — novo try em {wait:.0f}s"
            )
            time.sleep(wait)

    log.error(f"Falha IMAP após {IMAP_MAX_ATTEMPTS} tentativas: {last_err}")
    raise RuntimeError(
        f"Falha na conexão IMAP após {IMAP_MAX_ATTEMPTS} tentativas: {last_err}"
    ) from last_err


def _register_ignored(ctrl, msg_id, subject, sender_name, sender_email,
                      received_at, notes):
    """Registra um e-mail como 'ignorado' (sem baixar/extrair). Compartilhado pelo
    filtro de remetente de sistema (postmaster@) e pelo filtro de assunto."""
    ctrl.register({
        "message_id":      msg_id,
        "subject":         subject,
        "sender_name":     decode_str(sender_name) or sender_email,
        "sender_email":    sender_email,
        "received_at":     received_at,
        "keyword_matched": None,
        "has_attachment":  None,   # desconhecido — não baixamos o corpo
        "status":          "ignorado",
        "notes":           notes,
        "processed_at":    datetime.now(timezone.utc).isoformat(),
    })


def run_reader(days: int = 0, all_: bool = False,
               dry_run: bool = False, mark_seen: bool = False,
               on_progress=None) -> dict:
    """
    Lê a caixa IMAP, filtra/deduplica e processa os e-mails financeiros.

    Reutilizável tanto pelo CLI (main) quanto pelo backend HTTP (server/app.py).
    Retorna um dicionário-resumo da execução. Lança RuntimeError em falha de IMAP
    (em vez de sys.exit) para que o chamador HTTP possa devolver um erro tratado.

    on_progress: callback opcional `(dict) -> None` chamado a cada e-mail com o
    progresso atual ({phase, total, done, processed, skipped_keyword, skipped_dup}).
    Best-effort — exceções no callback são engolidas e nunca derrubam o run. Usado
    pelo Flask para servir GET /api/emails/progress; o CLI não passa callback.
    """
    kw_env   = os.getenv("EMAIL_KEYWORDS", "")
    keywords = [k.strip() for k in kw_env.split(",")] if kw_env else KEYWORDS_DEFAULT

    # Inicializar controle Supabase
    ctrl = SupabaseControl()
    supabase_ok = ctrl._available

    # Dedup em lote: carrega todos os IDs já processados em um set local.
    # Substitui N chamadas HTTP individuais por uma única consulta — elimina
    # a latência por e-mail no loop de deduplicação.
    known_ids = ctrl.load_known_ids()

    log.info("=" * 58)
    log.info("  email-reader v2.0 — iniciando")
    log.info(f"  Conta    : {os.getenv('IMAP_USER')}")
    log.info(f"  Controle : {'✓ Supabase' if supabase_ok else '✗ Supabase (fallback CSV)'}")
    log.info(f"  Dedup    : {len(known_ids)} IDs em cache")
    log.info(f"  Keywords : {len(keywords)} configuradas")
    log.info(f"  Modo     : {'dry-run' if dry_run else 'processamento completo'}")
    log.info("=" * 58)

    # Critério de busca (montado antes de conectar p/ o retry cobrir o search).
    if all_:
        criteria = "ALL"
    elif days > 0:
        since    = (datetime.now() - timedelta(days=days)).strftime("%d-%b-%Y")
        criteria = f'SINCE "{since}"'
    else:
        criteria = "UNSEEN"

    # connect + select + search com retry/backoff em falha transitória.
    mail, uids = _connect_and_search(criteria)
    log.info(f"E-mails no servidor ({criteria}): {len(uids)}")

    processed = skipped_kw = skipped_dup = 0
    new_subjects = []
    api_aborted = False
    total = len(uids)

    def _emit(phase: str, done: int) -> None:
        """Reporta progresso ao callback (best-effort — nunca derruba o run)."""
        if not on_progress:
            return
        try:
            on_progress({
                "phase": phase, "total": total, "done": done,
                "processed": processed, "skipped_keyword": skipped_kw,
                "skipped_dup": skipped_dup,
            })
        except Exception:  # noqa: BLE001 — progresso é informativo, não crítico
            pass

    _emit("lendo", 0)
    # try/finally garante mail.logout() mesmo se uma exceção escapar do loop —
    # sem isso, uma falha não-ApiUnavailableError deixaria a conexão IMAP aberta.
    try:
        for idx, uid in enumerate(uids, 1):
            _emit("lendo", idx - 1)  # done = e-mails já concluídos antes deste
            try:
                # Header enxuto para filtrar/registrar rapidamente (inclui remetente e
                # data, necessários para registrar também os e-mails 'ignorado').
                # INTERNALDATE incluido no fetch para registrar 'ignorado' com a data de
                # CHEGADA na caixa (mesma fonte do process_message) — alinha /emails ao
                # webmail. _rfc822_from_fetch tolera respostas IMAP intercaladas.
                _, hdr = mail.uid("fetch", uid,
                                  "(INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT MESSAGE-ID FROM DATE)])")
                hdr_meta, hdr_raw = _rfc822_from_fetch(hdr)
                hdr_msg = email.message_from_bytes(hdr_raw)
                subject = decode_str(hdr_msg.get("Subject", ""))
                msg_id  = hdr_msg.get("Message-ID", "").strip()
            except Exception as e:
                log.warning(f"  [SKIP] UID {uid} — erro ao ler header: {e}")
                skipped_kw += 1
                continue

            # Deduplicação PRIMEIRO: set em memória (O(1)); fallback para consulta
            # individual se o lote não foi carregado (Supabase indisponível). Vem antes
            # do filtro de keyword para não re-registrar e-mails já conhecidos.
            is_dup = (msg_id in known_ids) if known_ids else (msg_id and ctrl.is_processed(msg_id))
            if is_dup:
                log.info(f"  [DUP] {subject[:65]}")
                skipped_dup += 1
                continue

            # Remetente e data (canonico = INTERNALDATE) — usados pelos filtros abaixo
            # e pelo registro 'ignorado', mantendo /emails na MESMA ordem do webmail.
            sender_name, sender_email = parseaddr(hdr_msg.get("From", ""))
            received_at = _received_at_from(hdr_meta, hdr_msg.get("Date", ""))

            # Remetente de SISTEMA (postmaster@ etc.) → 'ignorado' sem baixar/extrair,
            # MESMO com keyword no assunto (NDR/bounce/aviso nao e conta a pagar).
            if is_ignored_sender(sender_email):
                if not dry_run:
                    _register_ignored(ctrl, msg_id, subject, sender_name, sender_email,
                                      received_at, f"Remetente de sistema ignorado ({sender_email})")
                log.info(f"  [IGN remetente] {subject[:55]}")
                skipped_kw += 1
                continue

            # Confirmacao/comprovante de PAGAMENTO (pagamento ja realizado) → 'ignorado'
            # sem baixar/extrair, MESMO com keyword no assunto: nao e conta a pagar.
            if subject_is_payment_confirmation(subject):
                if not dry_run:
                    _register_ignored(ctrl, msg_id, subject, sender_name, sender_email,
                                      received_at, "Confirmação de pagamento — pagamento já realizado (não é conta a pagar)")
                log.info(f"  [IGN confirmação pgto] {subject[:55]}")
                skipped_kw += 1
                continue

            # Assunto com "lembrete" → 'ignorado' sem baixar/extrair, MESMO com keyword/anexo:
            # e so um lembrete/aviso, nao a conta a pagar (decisao do usuario).
            if subject_is_reminder(subject):
                if not dry_run:
                    _register_ignored(ctrl, msg_id, subject, sender_name, sender_email,
                                      received_at, "Lembrete/aviso — não é conta a pagar")
                log.info(f"  [IGN lembrete] {subject[:55]}")
                skipped_kw += 1
                continue

            # Fora do filtro de assunto → registra como 'ignorado' (sem baixar/extrair),
            # para que /emails reflita a caixa inteira (o app substitui abrir o webmail).
            if not match_keyword(subject, keywords):
                if not dry_run:
                    _register_ignored(ctrl, msg_id, subject, sender_name, sender_email,
                                      received_at, "Fora do filtro de assunto (não-financeiro)")
                log.info(f"  [IGN] {subject[:65]}")
                skipped_kw += 1
                continue

            log.info(f"  [NEW] {subject[:65]}")
            try:
                process_message(mail, uid, keywords, dry_run, mark_seen, ctrl)
            except ApiUnavailableError as e:
                log.error("=" * 58)
                log.error("  PIPELINE INTERROMPIDO — API Anthropic indisponível.")
                log.error(f"  Motivo: {str(e)[:160]}")
                log.error("  Nenhum dado adicional gravado. Recarregue os créditos "
                          "e rode novamente.")
                log.error("=" * 58)
                api_aborted = True
                break
            processed += 1
            new_subjects.append(subject[:120])

        _emit("concluído", total)
    finally:
        # Fechar a conexão nunca deve mascarar o erro original do run.
        try:
            mail.logout()
        except Exception:  # noqa: BLE001 — logout best-effort
            pass

    log.info("=" * 58)
    log.info(f"  Novos processados : {processed}")
    log.info(f"  Sem palavra-chave : {skipped_kw}")
    log.info(f"  Duplicados (skip) : {skipped_dup}")
    if api_aborted:
        log.info(f"  Interrompido      : API Anthropic indisponível")
    log.info(f"  Log local         : {EMAILS_LOG}")
    log.info("=" * 58)

    return {
        "imap_user":       os.getenv("IMAP_USER"),
        "supabase_ok":     supabase_ok,
        "criteria":        criteria,
        "found":           len(uids),
        "processed":       processed,
        "skipped_keyword": skipped_kw,
        "skipped_dup":     skipped_dup,
        "new_subjects":    new_subjects,
        "dry_run":         dry_run,
        "api_aborted":     api_aborted,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Lê e-mails financeiros via IMAP — controle Supabase"
    )
    parser.add_argument("--days",      type=int, default=0,
        help="Processar e-mails dos últimos N dias (0 = não lidos)")
    parser.add_argument("--all",       action="store_true",
        help="Processar TODOS os e-mails (ignorando flag UNSEEN)")
    parser.add_argument("--dry-run",   action="store_true",
        help="Listar sem baixar anexos nem registrar")
    parser.add_argument("--mark-seen", action="store_true",
        help="Marcar e-mails como lidos após processar")
    args = parser.parse_args()

    try:
        run_reader(days=args.days, all_=args.all,
                   dry_run=args.dry_run, mark_seen=args.mark_seen)
        # Encerramento normal: remove arquivo de crash vazio para não poluir logs/
        try:
            _crash_file.close()
            if _CRASH_LOG.stat().st_size < 200:
                _CRASH_LOG.unlink(missing_ok=True)
        except Exception:
            pass
    except RuntimeError as e:
        log.error(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
