"""
read_emails.py — Leitura de e-mails financeiros via IMAP + controle Supabase
Projeto: pagamentos | Skill: email-reader | v2.0.0

Deduplicação: tabela email_control no Supabase (message_id UNIQUE).
Nunca reprocessa um e-mail já registrado, independente de onde o script rodar.
"""

import os, sys, re, time, socket, imaplib, email, argparse, logging, subprocess, csv, json, tempfile, faulthandler, unicodedata
import urllib.request, urllib.error, http.cookiejar
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
]

LOG_COLUMNS = [
    "message_id", "received_at", "sender_name", "sender_email",
    "subject", "body_preview", "has_attachment", "attachment_names",
    "attachment_saved", "pdf_extracted", "extraction_csv",
    "keyword_matched", "processed_at", "notes"
]

# ---------------------------------------------------------------------------
# Supabase — controle de deduplicação
# ---------------------------------------------------------------------------
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

        Deduplica/atualiza por gmail_message_id. A situacao de vencimento vai na
        coluna unica `status` (migration 034): enviamos status='pendente' e a trigger
        trg_fe_status_vencimento sobrescreve com 'a vencer'/'vencido' a partir de
        due_date x extracted_at quando o status esta em aberto (preserva 'falha').
        """
        if not self._available:
            return False
        try:
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
        try:
            req = urllib.request.Request(
                f"{self.base}/storage/v1/object/{STORAGE_BUCKET}/{key}",
                data=data,
                headers={
                    "apikey":        self.key,
                    "Authorization": f"Bearer {self.key}",
                    "Content-Type":  "application/pdf",
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
          3. fornecedor + valor + vencimento + tipo — pega o mesmo encargo
             emitido em documentos com numero proprio distinto (ex.: boleto x
             RPS da mesma fatura, ambos R$ X no mesmo vencimento).
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
            filters = "&".join(clauses)
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
                log.warning(f"Falha na checagem de duplicidade de conteudo: {e}")
                return None

        # 1. Barcode — identificador definitivo do documento de pagamento.
        barcode = (payload.get("barcode") or "").strip()
        if barcode:
            m = _find([f"barcode=eq.{urllib.parse.quote(barcode, safe='')}"])
            if m:
                return m

        # 2/3. Precisam de um identificador de fornecedor.
        supplier_col = supplier_val = None
        for col in ("supplier_cnpj", "supplier_cpf", "supplier_name"):
            if payload.get(col):
                supplier_col, supplier_val = col, payload[col]
                break
        if not supplier_col:
            return None  # sem fornecedor identificavel — nao deduplica

        # Fornecedor por NOME (sem CNPJ/CPF): comparacao case/acento-insensitive via
        # RPC financial_dup_by_name (normalize_search nos dois lados) — "EFE Displays"
        # casa "EFE DISPLAYS". CNPJ/CPF sao identificadores exatos: match direto.
        if supplier_col == "supplier_name":
            return self._dup_by_name(payload)

        supplier_clause = f"{supplier_col}=eq.{urllib.parse.quote(str(supplier_val), safe='')}"

        # 2. fornecedor + numero do documento + valor (numero substancial).
        invoice = str(payload.get("invoice_number") or "").strip()
        if len(invoice) >= 6:
            m = _find([
                supplier_clause,
                f"invoice_number=eq.{urllib.parse.quote(invoice, safe='')}",
                _eq_clause("amount", payload.get("amount")),
            ])
            if m:
                return m

        # 3. fornecedor + valor + vencimento + tipo (mesmo encargo, numero distinto).
        return _find([supplier_clause] + [
            _eq_clause(col, payload.get(col))
            for col in ("amount", "due_date", "document_type")
        ])

    def _dup_by_name(self, payload: dict) -> dict | None:
        """Dedup pelo NOME do fornecedor via RPC financial_dup_by_name (migration 032):
        normalize_search(supplier_name) = normalize_search(nome extraido), nos dois lados.
        O PostgREST nao permite funcao na coluna dentro do filtro, por isso a comparacao
        case/acento-insensitive roda na RPC. Retorna a conta existente (id, due_date,
        barcode...) ou None. Em erro de consulta, None (nao bloqueia a insercao)."""
        if not self._available:
            return None
        amount = payload.get("amount")
        body = json.dumps({
            "p_name":    payload.get("supplier_name"),
            "p_amount":  float(amount) if amount not in (None, "") else None,
            "p_invoice": (str(payload.get("invoice_number") or "").strip() or None),
            "p_due":     payload.get("due_date") or None,
            "p_doc":     payload.get("document_type") or None,
        }).encode()
        try:
            req = urllib.request.Request(
                f"{self.base}/rest/v1/rpc/financial_dup_by_name",
                data=body, headers=self.headers, method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as r:
                rows = json.loads(r.read())
                return rows[0] if rows else None
        except Exception as e:
            log.warning(f"Falha na checagem de duplicidade por nome (RPC): {e}")
            return None

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
    "darf", "das", "dae", "dam", "duam", "gps", "gru", "gnre", "gare",
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
                      "dam", "duam", "gps", "gru", "gnre", "gare", "ipva",
                      "iptu", "iss", "itbi", "tributo", "imposto", "taxa")


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
NOTIFICATION_WORD_TERMS = frozenset({"nfe", "nf-e", "informe", "sieg"})
NOTIFICATION_PHRASE_TERMS = (
    "informativo", "confirmado o pagamento", "confirmado pagamento",
    "confirmacao de pagamento", "confirmacao do pagamento", "pagamento confirmado",
    "pagamento processado", "aviso de vencimento",
    "titulo a vencer", "lembrete de vencimento", "titulos proximos do vencimento",
    "comprovante de pix", "protesto", "protestado", "cartorio", "comunicado",
)


def subject_is_ignorable_notification(subject: str) -> bool:
    """True se o assunto e de uma NOTIFICACAO (aviso/confirmacao/informe/SIEG/NF-e)
    que, sem anexo e sem conta no corpo, deve virar 'ignorado' em vez de 'falha'."""
    s = _strip_accents_lower(subject)
    if any(_has_word(s, t) for t in NOTIFICATION_WORD_TERMS):
        return True
    return any(_strip_accents_lower(t) in s for t in NOTIFICATION_PHRASE_TERMS)


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
                            received_at: str | None = None) -> dict:
    """Converte uma linha do CSV de extracao em payload para financial_account_control.

    Sanitiza os campos com restricao no schema (CHAR(14) do CNPJ e
    NUMERIC do amount) para evitar rejeicao do INSERT. A situacao de vencimento
    NAO e calculada aqui — a trigger grava em `status` no banco (migration 034).
    Aplica os mesmos fallbacks do caminho de corpo: emissao->data do e-mail
    (received_at); vencimento->emissao; numero->"{tipo}_{ddmmyy}".
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

    # Nº documento em branco → "{tipo}_{ddmmyy(vencimento|emissão)}" (mesma regra do corpo).
    if not payload.get("invoice_number"):
        ddmmyy = _iso_date_to_ddmmyy(payload.get("due_date") or payload.get("issue_date"))
        if ddmmyy:
            payload["invoice_number"] = f"{payload.get('document_type') or 'outro'}_{ddmmyy}"

    # Honorários: forma de pagamento sempre PIX (regra de negócio), mesmo via PDF.
    if (payload.get("document_type") or "").lower() == "honorários":
        payload["payment_method"] = "pix"

    payload["currency"] = payload.get("currency") or "BRL"
    payload["status"]   = payload.get("status") or "pendente"
    payload["gmail_message_id"] = gmail_message_id
    return payload


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
# Valor ROTULADO sem "R$" (ex.: "Valor 50,00", "Valor: 1.250,00", "Total 304,04").
# So usado como FALLBACK quando nao ha nenhum valor com "R$". Exige o rotulo
# (valor/total) E o formato monetario BR com EXATAMENTE 2 casas decimais — assim
# nao captura numeros soltos (quantidades, "NF 1087", datas). group(1)=rotulo,
# group(2)=numero. "Total"/"Valor Total" tem precedencia sobre "Valor" simples.
_BODY_LABELED_AMT_RE = re.compile(
    r"(?i)\b(valor\s+total|total|valor)\b\s*[:\-]?\s*"
    r"(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})(?!\d)")
_BODY_PIX_RE     = re.compile(r"\bpix\b", re.IGNORECASE)
_BODY_DUE_RE     = re.compile(r"(?i)venc(?:imento|to)?\D{0,15}?(\d{2}/\d{2}/\d{2,4})")
_BODY_ISSUE_RE   = re.compile(r"(?i)emiss[aã]o\D{0,10}?(\d{2}/\d{2}/\d{2,4})")
_BODY_INVOICE_RE = re.compile(r"(?i)\b(?:nf(?:[- ]?e)?|nota\s+fiscal|fatura\s+n[º°.]?)\s*[n°.:]?\s*(\d{3,})")
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
    ("DAE",        ["documento de arrecadacao do esocial",
                    "documento de arrecadacao de receitas estaduais", "dare", "dae"]),
    ("GNRE",       ["guia nacional de recolhimento", "gnre"]),
    ("IPVA",       ["guia de ipva", "ipva"]),
    ("IPTU",       ["guia de iptu", "iptu"]),
    ("DAM / DUAM", ["documento de arrecadacao municipal", "duam"]),
    ("ISS",        ["recolhimento de iss", "guia de iss", "guia iss", "iss a recolher"]),
    ("ITBI",       ["imposto de transmissao", "guia de itbi", "itbi"]),
    ("GARE",       ["gare"]),
    ("tributo",    ["guia de recolhimento", "guia de pagamento",
                    "documento de arrecadacao"]),
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


def _brl_to_decimal(raw: str | None):
    """Converte valor em formato BR ('8.650,00' ou '8650,00') para float.

    O _to_decimal acima nao trata separador de milhar — necessario aqui pois
    o valor vem direto do texto do e-mail, nao normalizado pelo extract_pdf.
    """
    if not raw:
        return None
    s = re.sub(r"[^\d,.]", "", raw)
    if re.search(r",\d{1,2}$", s):
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
      1. Valor rotulado como "Total"/"Valor Total" tem precedencia — quando o
         corpo lista parcelas (lado a lado, somando ou subtraindo), o total e o
         valor a pagar. Ex.: "Valor: R$ 297,08 + R$ 6,96 / Total: R$ 304,04".
      2. Sem rotulo de total e com varios valores → soma as parcelas (fallback).
      3. Um unico valor → o proprio valor.
      4. Sem "R$": valor ROTULADO ("Valor 50,00"/"Total 304,04") — precedencia ao total.
      5. Nenhum valor → None.
    """
    total_match = _BODY_TOTAL_RE.search(body_text)
    if total_match:
        return _brl_to_decimal(total_match.group(1))

    valores = [v for v in (_brl_to_decimal(m) for m in _BODY_AMOUNT_RE.findall(body_text))
               if v is not None]
    if len(valores) == 1:
        return valores[0]
    if valores:
        return round(sum(valores), 2)

    # Fallback sem "R$": numero rotulado por "Valor"/"Total" (precedencia ao total).
    rotulados = _BODY_LABELED_AMT_RE.findall(body_text)  # [(rotulo, numero), ...]
    if rotulados:
        totais = [num for (lbl, num) in rotulados if "total" in lbl.lower()]
        return _brl_to_decimal(totais[0] if totais else rotulados[0][1])
    return None


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


def extract_from_email_body(body_text: str, received_at: str, message_id: str,
                            sender_email: str | None = None) -> dict | None:
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
      - payment_method: 'pix' no corpo → 'pix'; caso contrario → 'outro'
      - document_type: 'PIX' quando PIX; senao keywords de tributo; fallback 'outro'
      - invoice_number fallback: '{document_type}_{ddmmyy}' quando nao encontrado

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
    # "p/ <Nome>" / assinatura "Prof. <Nome>"), depois o mapa por remetente
    # (ex.: correios.com.br -> "Correios") e, por fim, o e-mail do remetente.
    # Havendo CNPJ/CPF, deixa o nome vazio (a trigger resolve pelo doc).
    if not supplier_name and not supplier_cnpj and not supplier_cpf:
        supplier_name = (_supplier_from_signals(body_text)
                         or _supplier_from_sender(sender_email)
                         or sender_email or "desconhecido")

    has_pix = bool(_BODY_PIX_RE.search(body_text))

    issue_match = _BODY_ISSUE_RE.search(body_text)
    issue_date  = _br_date_to_iso(issue_match.group(1)) if issue_match else None
    if not issue_date:
        issue_date = (received_at or "")[:10] or None

    due_match = _BODY_DUE_RE.search(body_text)
    due_date  = _br_date_to_iso(due_match.group(1)) if due_match else None
    if not due_date:
        due_date = issue_date  # sem vencimento explicito, usa data de emissao
    if not due_date:
        # Regra de negocio: sem nenhuma data, usa a data da extracao (hoje).
        due_date = datetime.now().strftime("%Y-%m-%d")

    # Honorários têm precedência sobre o override de PIX: registra como tipo
    # "honorários" e, por regra de negócio, forma de pagamento "pix".
    classified = _classify_body_doc_type(body_text)
    if classified == "honorários":
        document_type, payment_method = "honorários", "pix"
    elif has_pix:
        # PIX sobrescreve o tipo quando não é honorários.
        document_type, payment_method = "PIX", "pix"
    else:
        document_type, payment_method = classified, "outro"

    # Numero de documento: valor encontrado no corpo ou fallback tipo+ddmmyy
    if not invoice_number:
        ddmmyy = _iso_date_to_ddmmyy(due_date or issue_date)
        if ddmmyy:
            invoice_number = f"{document_type}_{ddmmyy}"

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
        is_pdf = (ct == "application/pdf"
                  or fname.lower().endswith(".pdf")
                  or ("attachment" in cd and "pdf" in fname.lower()))
        if not is_pdf:
            continue

        orig      = safe_filename(Path(fname).stem, 20) if fname else "anexo"
        dest_name = f"{sender_tag}_{subject_tag}_{date_tag}_{orig}.pdf"
        dest_path = PDF_INBOX / dest_name
        counter   = 1
        while dest_path.exists():
            dest_path = PDF_INBOX / f"{dest_name[:-4]}_{counter}.pdf"
            counter += 1

        payload = part.get_payload(decode=True)
        if payload:
            dest_path.write_bytes(payload)
            saved.append(dest_path)
            log.info(f"    PDF salvo: {dest_path.name}")
    return saved


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

    def _add(url: str):
        # Desescapa entidades HTML (&amp; → &) — links de boleto vêm escapados no
        # HTML e quebrariam os parâmetros (ex.: SIEG/Vindi ?b=…&m=…&t=…).
        u = html_unescape(url.strip()).rstrip(".,;)>\"'")
        # Ignora links que a Locaweb entende como suspeitos (redirect/ofuscados).
        if u and u not in seen and u.startswith("http") and not _is_suspicious_link(u):
            seen.add(u)
            candidates.append(u)

    for m in _LINK_HREF_RE.finditer(html or ""):
        url         = m.group(1).strip()
        anchor_text = re.sub(r"<[^>]+>", "", m.group(2)).strip()
        if not url.startswith("http"):
            continue
        url_path = url.lower().split("?")[0]
        if (_LINK_TEXT_RE.search(anchor_text)
                or url_path.endswith(".pdf")
                or _LINK_URL_RE.search(url)):
            _add(url)

    for url in _LINK_IN_TEXT_RE.findall(text or ""):
        url_path = url.lower().split("?")[0]
        if url_path.endswith(".pdf") or _LINK_URL_RE.search(url):
            _add(url)

    return candidates[:10]


def _fetch_url(url: str, timeout: int = 30,
               opener: "urllib.request.OpenerDirector | None" = None
               ) -> "tuple[bytes, str, str] | None":
    """GET em url; retorna (conteúdo, content_type, url_final) ou None.

    Quando `opener` é informado (build_opener com HTTPCookieProcessor), a chamada
    reutiliza a mesma sessão/cookies — necessário para portais que exigem cookie
    de sessão entre a página e o download (ex.: BRASPRESS JSESSIONID)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _LINK_UA})
        _open = opener.open if opener is not None else urllib.request.urlopen
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
                   received_at: str) -> Path:
    date_tag    = received_at[:10].replace("-", "")
    sender_tag  = safe_filename((sender_email or "").split("@")[0], 20)
    subject_tag = safe_filename(subject, 30)
    dest_name   = f"{sender_tag}_{subject_tag}_{date_tag}_link.pdf"
    dest_path   = PDF_INBOX / dest_name
    counter = 1
    while dest_path.exists():
        dest_path = PDF_INBOX / f"{dest_name[:-4]}_{counter}.pdf"
        counter += 1
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
    # página inicial e o download (ex.: BRASPRESS).
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

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
# Acionar extract_pdf.py
# ---------------------------------------------------------------------------
# Robustez da extração: uma falha transitória (crash do subprocesso, timeout) não
# deve derrubar o PDF — repete com backoff. Falha definitiva (rc=0 sem CSV = nada a
# extrair) não repete. O motivo é propagado para gravar em email_processing_errors.
EXTRACTION_MAX_ATTEMPTS = 3
EXTRACTION_RETRY_BACKOFF = (2, 5)  # segundos de espera entre tentativas


def _run_extraction_once(pdf_path: Path) -> tuple[str | None, str | None, bool]:
    """Uma tentativa de extração. Retorna (csv_path, motivo_falha, transitorio).

    `transitorio=True` indica que vale repetir (rc≠0, timeout, exceção de
    subprocesso); `False` é falha definitiva (rc=0 sem CSV — repetir não muda).
    Usa diretório de saída temporário exclusivo, evitando CSV obsoleto de run anterior.
    """
    try:
        with tempfile.TemporaryDirectory(dir=CSV_OUTPUT) as tmp_out:
            # UTF-8 nos DOIS lados: o extract_pdf emite Unicode (✓, →) nos logs.
            # Em console Windows (cp1252) isso quebra a captura — o parent lança
            # UnicodeDecodeError ao decodificar a saída do filho, derrubando a
            # extração mesmo com o PDF já extraído. Parent: encoding utf-8 +
            # errors='replace' (nunca quebra). Filho: env PYTHONUTF8/PYTHONIOENCODING
            # garante que ele escreva utf-8 independente do code page do console.
            child_env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
            result = subprocess.run(
                [sys.executable, str(EXTRACT_SCRIPT),
                 "--input", str(pdf_path),
                 "--output", tmp_out],
                capture_output=True, text=True, timeout=180,
                encoding="utf-8", errors="replace", env=child_env,
            )
            if result.returncode != 0:
                return None, f"rc={result.returncode}: {(result.stderr or '').strip()[:300]}", True
            csvs = sorted(Path(tmp_out).glob("*_extracted.csv"),
                          key=lambda p: p.stat().st_mtime, reverse=True)
            if not csvs:
                return None, f"rc=0 sem CSV: {(result.stdout or '').strip()[-200:]}", False
            # Move o CSV para o diretório definitivo antes que o tempdir seja removido
            final = CSV_OUTPUT / csvs[0].name
            csvs[0].replace(final)
            return str(final), None, False
    except subprocess.TimeoutExpired:
        return None, "timeout (>180s) na extração", True
    except Exception as e:
        return None, f"exceção no subprocesso: {e}", True


def run_extraction(pdf_path: Path) -> tuple[str | None, str | None]:
    """Executa extract_pdf.py em subprocesso e retorna (csv_path, motivo_falha).

    Em sucesso: (caminho_do_csv, None). Em falha: (None, motivo). Repete falhas
    transitórias com backoff — um blip de subprocesso/timeout não perde o PDF. O
    motivo final é gravado em email_processing_errors (observável em /erros), em
    vez de só no console do Flask.
    """
    if not EXTRACT_SCRIPT.exists():
        msg = f"extract_pdf.py não encontrado: {EXTRACT_SCRIPT}"
        log.warning(msg)
        return None, msg

    reason = None
    for attempt in range(1, EXTRACTION_MAX_ATTEMPTS + 1):
        csv_path, reason, transient = _run_extraction_once(pdf_path)
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


def extract_and_store_accounts(saved_pdfs: list, message_id: str,
                               ctrl: "SupabaseControl",
                               email_rec: dict = None) -> tuple:
    """Extrai cada PDF e grava as contas resultantes em financial_account_control.

    Liga cada conta ao e-mail por gmail_message_id; multiplos PDFs no mesmo
    e-mail recebem sufixo (#1, #2, ...) para nao colidir na chave unica.
    Emails defeituosos sao logados em email_processing_errors e pulados.
    Retorna (lista de CSVs gerados, total de contas gravadas).
    """
    csvs_ok, accounts_saved, acc_index = [], 0, 0
    err_ctx = email_rec or {}

    for pdf_path in saved_pdfs:
        # Publica o PDF no Storage SEMPRE (antes da extracao) — assim o anexo fica
        # disponivel para revisao manual mesmo quando a extracao falha por completo.
        # Nao-fatal: se o upload falhar, a extracao segue normalmente.
        ctrl.upload_attachment(pdf_path)

        csv_path, extract_err = run_extraction(pdf_path)
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

            dtype = (row.get("document_type") or "").strip().lower()
            if dtype in SKIP_ACCOUNT_TYPES:
                log.info(f"    {dtype.upper()} ignorado — nao gera conta a pagar")
                continue

            gmid    = message_id if acc_index == 0 else f"{message_id}#{acc_index}"
            payload = build_financial_payload(row, gmid, received_at=err_ctx.get("received_at"))
            # Remetente do e-mail → o trigger alinha supplier.email (migration 023).
            payload["sender_email"] = err_ctx.get("sender_email")
            payload["subject"]      = err_ctx.get("subject")  # exibido/buscado em /consulta (migration 025)
            ctx     = {**err_ctx, "source_file": row.get("source_file")}

            # Validacao 1: valor ausente ou zero
            if not payload.get("amount"):
                ctrl.register_error(
                    ctx, "sem_valor",
                    f"Valor ausente ou zero — {row.get('source_file')}",
                    raw_payload=row
                )
                acc_index += 1
                continue

            # Validacao 2: fornecedor sem nenhum identificador
            if not any([payload.get("supplier_cnpj"),
                        payload.get("supplier_cpf"),
                        payload.get("supplier_name")]):
                ctrl.register_error(
                    ctx, "sem_fornecedor",
                    f"CNPJ, CPF e nome do fornecedor ausentes — {row.get('source_file')}",
                    raw_payload=row
                )
                acc_index += 1
                continue

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
                # ISO 'YYYY-MM-DD' compara corretamente como string.
                if new_due and (not old_due or str(new_due) > str(old_due)):
                    ctrl.update_financial(dup["id"], {
                        "due_date":       new_due,
                        "barcode":        payload.get("barcode"),
                        "amount_charged": payload.get("amount_charged"),
                        "fine_interest":  payload.get("fine_interest"),
                        "other_additions": payload.get("other_additions"),
                    })
                    log.info(
                        f"    [REEMISSAO] mesma guia — conta atualizada p/ vencimento "
                        f"{new_due} ({row.get('source_file')})"
                    )
                else:
                    log.info(
                        f"    [DUP-DOC] reemissão igual/mais antiga — mantido "
                        f"({row.get('source_file')})"
                    )
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

    return csvs_ok, accounts_saved


# Resultado da extração pelo corpo (try_extract_from_body) — orienta o status do
# e-mail. Distinguir DUPLICATE de NONE é a regra de negócio que evita marcar como
# 'falha' um e-mail cujo pagável já foi registrado por outro e-mail (ex.: a
# mensagem original e seu RES:/encaminhamento).
BODY_CREATED   = "created"    # conta nova gravada            → 'recebido'
BODY_DUPLICATE = "duplicate"  # pagável duplica conta existente → 'ignorado'
BODY_NONE      = "none"       # sem pagável utilizável         → falha/notificação


def try_extract_from_body(email_rec: dict, body_text: str, received_at: str,
                          message_id: str, ctrl: "SupabaseControl",
                          sender_email: str | None = None) -> str:
    """Tenta gravar uma conta extraida do corpo do e-mail (sem PDF valido).

    Retorna um de:
      BODY_CREATED   — conta NOVA gravada (chamador marca 'recebido');
      BODY_DUPLICATE — o pagavel do corpo DUPLICA uma conta ja registrada: nao
                       grava de novo, anota a referencia em email_rec['duplicate_of']
                       e o chamador marca 'ignorado' (nao e falha — a conta existe);
      BODY_NONE      — sem pagavel utilizavel (chamador segue p/ falha/notificacao).
    Anota o motivo em email_rec['notes']. O log em email_processing_errors e feito
    de forma centralizada no chamador (process_message), para TODA falha.
    """
    payload = extract_from_email_body(body_text, received_at, message_id, sender_email)
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

    # Mesma validacao de valor do caminho de PDF (extract_and_store_accounts):
    # sem valor nao ha conta a pagar.
    if not payload.get("amount"):
        email_rec["notes"] = "Valor ausente ou zero no corpo do e-mail"
        return BODY_NONE

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
                       duplicate: bool = False) -> str:
    """Deriva email_control.status a partir do resultado real do processamento.

    Prioridade (CHECK migration 022): conta do PDF > conta do corpo > NF-e pura
    sem conta > CSV sem conta nova > anexo sem conta.

      - accounts_saved -> 'extraído'  (conta(s) a pagar gravada(s) do PDF)
      - pure_nfe       -> 'ignorado'  (assunto NF-e/NFS-e puro, sem pagavel e sem
                                       conta: notificacao fiscal, nao e conta a pagar)
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

        att_names = [p.name for p in saved_pdfs]
        has_att   = len(saved_pdfs) > 0

        rec["has_attachment"]   = has_att
        rec["attachment_names"] = " | ".join(att_names) if att_names else None
        rec["attachment_saved"] = has_att
        if link_downloaded:
            rec["notes"] = "PDF baixado de link no corpo do e-mail"

        csvs_ok, accounts_saved = extract_and_store_accounts(
            saved_pdfs, message_id, ctrl, email_rec=rec)

        csv_generated = len(csvs_ok) > 0
        rec["pdf_extracted"]  = csv_generated
        rec["extraction_csv"] = " | ".join(csvs_ok) if csvs_ok else None
        if accounts_saved:
            log.info(f"    {accounts_saved} conta(s) gravada(s) em financial_account_control")

        if not has_att:
            rec["notes"] = "Sem anexo PDF — registrado para revisão"

        # Corpo é fallback SOMENTE quando o anexo NÃO produziu conta válida
        # (accounts_saved == 0). Assim os dados do corpo nunca conflitam com um
        # arquivo anexado válido (reconhecido como conta a pagar) — havendo conta
        # do anexo, o corpo é ignorado. try_extract_from_body valida fornecedor+valor.
        body_outcome = BODY_NONE
        if accounts_saved == 0:
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
            duplicate=(body_outcome == BODY_DUPLICATE))

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

        # Fora do filtro de assunto → registra como 'ignorado' (sem baixar/extrair),
        # para que /emails reflita a caixa inteira (o app substitui abrir o webmail).
        if not match_keyword(subject, keywords):
            if not dry_run:
                sender_name, sender_email = parseaddr(hdr_msg.get("From", ""))
                # received_at canonico = INTERNALDATE (chegada na caixa), igual ao
                # process_message — para /emails ficar na MESMA ordem do webmail.
                received_at = _received_at_from(hdr_meta, hdr_msg.get("Date", ""))
                ctrl.register({
                    "message_id":   msg_id,
                    "subject":      subject,
                    "sender_name":  decode_str(sender_name) or sender_email,
                    "sender_email": sender_email,
                    "received_at":  received_at,
                    "keyword_matched": None,
                    "has_attachment":  None,   # desconhecido — não baixamos o corpo
                    "status":       "ignorado",
                    "notes":        "Fora do filtro de assunto (não-financeiro)",
                    "processed_at": datetime.now(timezone.utc).isoformat(),
                })
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
    mail.logout()

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
