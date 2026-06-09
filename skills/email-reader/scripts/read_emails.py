"""
read_emails.py — Leitura de e-mails financeiros via IMAP + controle Supabase
Projeto: pagamentos | Skill: email-reader | v2.0.0

Deduplicação: tabela email_control no Supabase (message_id UNIQUE).
Nunca reprocessa um e-mail já registrado, independente de onde o script rodar.
"""

import os, sys, re, imaplib, email, argparse, logging, subprocess, csv, json, tempfile, faulthandler
import urllib.request, urllib.error
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

PDF_INBOX.mkdir(parents=True, exist_ok=True)
CSV_OUTPUT.mkdir(parents=True, exist_ok=True)

KEYWORDS_DEFAULT = [
    "boleto", "nota fiscal", "nf-e", "nfe", "fatura",
    "cobrança", "vencimento", "pagamento", "pagamentos",
    "pagamento fornecedor", "pagamentos fornecedores", "duplicata",
    "recibo", "nfs-e", "danfe",
    # Guias de tributos federais/estaduais/municipais
    "simples nacional", "simei", "darf", "gps", "gare",
    "guia", "guia de pagamento", "guia de recolhimento",
    # Conhecimento de Transporte Eletronico
    "ct-e", "cte", "dacte",
    # Fechamento de conta / extrato mensal
    "fechamento",
    # Seguro
    "seguro",
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
            "has_attachment":   bool(rec.get("has_attachment")),
            "attachment_names": rec.get("attachment_names"),
            "attachment_saved": bool(rec.get("attachment_saved")),
            "pdf_extracted":    bool(rec.get("pdf_extracted")),
            "extraction_csv":   rec.get("extraction_csv"),
            "notes":            rec.get("notes"),
            "status":           self._derive_status(rec),
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
        """UPSERT de uma conta extraida em financial_emails (service_role).

        Deduplica/atualiza por gmail_message_id. O campo due_status NAO e
        enviado: a trigger trg_fe_due_status o calcula no banco a partir de
        due_date x extracted_at (migration 004).
        """
        if not self._available:
            return False
        try:
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                f"{self.base}/rest/v1/financial_emails?on_conflict=gmail_message_id",
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

    @staticmethod
    def _derive_status(rec: dict) -> str:
        if rec.get("pdf_extracted"):   return "extracted"
        if rec.get("attachment_saved"):return "downloaded"
        if rec.get("notes") and "erro" in str(rec.get("notes","")).lower():
            return "error"
        return "received"


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
            result.append(part.decode(enc or "utf-8", errors="replace"))
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


def safe_filename(text: str, max_len: int = 40) -> str:
    text = re.sub(r"[^\w\s-]", "", text or "", flags=re.UNICODE)
    text = re.sub(r"\s+", "_", text.strip())
    return text[:max_len]


def match_keyword(subject: str, keywords: list) -> str | None:
    s = subject.lower()
    for kw in keywords:
        if kw.lower() in s:
            return kw
    return None


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
# Gravacao da conta extraida em financial_emails
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


def build_financial_payload(row: dict, gmail_message_id: str) -> dict:
    """Converte uma linha do CSV de extracao em payload para financial_emails.

    Sanitiza os campos com restricao no schema (CHAR(14) do CNPJ e
    NUMERIC do amount) para evitar rejeicao do INSERT. O due_status NAO
    e calculado aqui — fica por conta da trigger no banco.
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

    payload["currency"] = payload.get("currency") or "BRL"
    payload["status"]   = payload.get("status") or "pending"
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
# Termos podem aparecer em qualquer caixa/acentuacao ("Pix"/"PIX"/"pix",
# "Responsável"/"responsavel") — os regex abaixo sao case-insensitive e
# cobrem a unica variacao de acento relevante ("respons[aá]vel").
_BODY_NAME_RE   = re.compile(r"(?im)^[ \t]*(?:nome|respons[aá]vel)[ \t]*[:\-]?[ \t]*(.+?)[ \t]*$")
_BODY_AMOUNT_RE = re.compile(r"R\$\s*([\d.,]+)")
_BODY_PIX_RE    = re.compile(r"\bpix\b", re.IGNORECASE)
_BODY_DUE_RE    = re.compile(r"(?i)venc(?:imento|to)?\D{0,15}?(\d{2}/\d{2}/\d{4})")


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


def _br_date_to_iso(raw: str | None) -> str | None:
    """Converte data 'dd/mm/aaaa' do corpo do e-mail para 'aaaa-mm-dd'."""
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%d/%m/%Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def _iso_date_to_ddmmyy(iso_date: str | None) -> str | None:
    """Converte data 'aaaa-mm-dd' para 'ddmmaa' — usado para compor invoice_number."""
    if not iso_date:
        return None
    try:
        return datetime.strptime(iso_date[:10], "%Y-%m-%d").strftime("%d%m%y")
    except ValueError:
        return None


def extract_from_email_body(body_text: str, received_at: str, message_id: str) -> dict | None:
    """Monta um payload de financial_emails a partir do corpo do e-mail.

    Cobre o pedido informal de pagamento (sem PDF valido ou anexo que nao e
    documento financeiro): nome do fornecedor e valor sao obrigatorios — sem
    nenhum dos dois a mensagem nao segue o padrao esperado e a funcao
    retorna None (o chamador registra o e-mail em email_processing_errors).

    Regra de tipo de pagamento / vencimento:
      - "pix" no corpo define payment_method='pix'; sem data de vencimento
        explicita, o vencimento e a propria data de envio do e-mail
        (pagamento a vista — mesma regra usada para boletos sem vencimento)
      - "vencimento"/"vencto"/"venc" seguido de uma data prevalece sobre a
        data implicita do PIX, mesmo com o termo "pix" presente
      - sem nenhum dos dois termos, payment_method='outro' — valor aceito
        pelo CHECK constraint da coluna (equivalente ao 'outros' da regra de
        negocio; gravar 'outros' violaria o constraint, como 'outro' ja e
        usado de forma consistente em document_type)

    Sem anexo nao ha data de emissao nem numero de documento no PDF — por isso:
      - issue_date  = data de envio do e-mail (received_at)
      - invoice_number = "{document_type}_{ddmmaa}", ddmmaa derivado de issue_date
        (ex.: 'outro_080626'), mantendo o registro identificavel
    """
    if not body_text:
        return None

    name_match    = _BODY_NAME_RE.search(body_text)
    supplier_name = name_match.group(1).strip() if name_match else None

    amount_match = _BODY_AMOUNT_RE.search(body_text)
    amount       = _brl_to_decimal(amount_match.group(1)) if amount_match else None

    if not supplier_name and not amount:
        return None

    has_pix   = bool(_BODY_PIX_RE.search(body_text))
    due_match = _BODY_DUE_RE.search(body_text)
    due_date  = _br_date_to_iso(due_match.group(1)) if due_match else None

    if has_pix:
        payment_method = "pix"
        if not due_date:
            due_date = (received_at or "")[:10] or None
    else:
        payment_method = "outro"

    document_type = "outro"

    # Sem documento anexado nao ha data de emissao nem numero de documento —
    # emissao usa a data de envio do e-mail, e o numero e composto a partir
    # do tipo + data de emissao (ddmmaa), para manter o registro identificavel
    issue_date     = (received_at or "")[:10] or None
    invoice_number = None
    ddmmyy         = _iso_date_to_ddmmyy(issue_date)
    if ddmmyy:
        invoice_number = f"{document_type}_{ddmmyy}"

    payload = {f: None for f in FINANCIAL_FIELDS}
    payload.update({
        "document_type":     document_type,
        "extraction_source": "email_body",
        "supplier_name":     supplier_name,
        "amount":            amount,
        "currency":          "BRL",
        "payment_method":    payment_method,
        "due_date":          due_date,
        "issue_date":        issue_date,
        "invoice_number":    invoice_number,
        "status":            "pending",
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
# Acionar extract_pdf.py
# ---------------------------------------------------------------------------
def run_extraction(pdf_path: Path) -> str | None:
    """Executa extract_pdf.py em subprocesso e retorna o CSV gerado por ESTE run.

    Usa um diretório de saída temporário exclusivo por chamada, evitando que um
    run com falha retorne um CSV obsoleto de execução anterior.
    """
    if not EXTRACT_SCRIPT.exists():
        log.warning(f"extract_pdf.py não encontrado: {EXTRACT_SCRIPT}")
        return None
    try:
        with tempfile.TemporaryDirectory(dir=CSV_OUTPUT) as tmp_out:
            result = subprocess.run(
                [sys.executable, str(EXTRACT_SCRIPT),
                 "--input", str(pdf_path),
                 "--output", tmp_out],
                capture_output=True, text=True, timeout=180
            )
            if result.returncode != 0:
                log.error(f"    Erro extração (rc={result.returncode}): {result.stderr[:300]}")
                return None
            csvs = sorted(Path(tmp_out).glob("*_extracted.csv"),
                          key=lambda p: p.stat().st_mtime, reverse=True)
            if not csvs:
                log.warning(f"    extract_pdf concluiu sem CSV: {result.stdout[-200:]}")
                return None
            # Move o CSV para o diretório definitivo antes que o tempdir seja removido
            final = CSV_OUTPUT / csvs[0].name
            csvs[0].replace(final)
            return str(final)
    except Exception as e:
        log.error(f"    Falha extract_pdf: {e}")
        return None


def extract_and_store_accounts(saved_pdfs: list, message_id: str,
                               ctrl: "SupabaseControl",
                               email_rec: dict = None) -> tuple:
    """Extrai cada PDF e grava as contas resultantes em financial_emails.

    Liga cada conta ao e-mail por gmail_message_id; multiplos PDFs no mesmo
    e-mail recebem sufixo (#1, #2, ...) para nao colidir na chave unica.
    Emails defeituosos sao logados em email_processing_errors e pulados.
    Retorna (lista de CSVs gerados, total de contas gravadas).
    """
    csvs_ok, accounts_saved, acc_index = [], 0, 0
    err_ctx = email_rec or {}

    for pdf_path in saved_pdfs:
        csv_path = run_extraction(pdf_path)
        if not csv_path:
            ctrl.register_error(
                {**err_ctx, "source_file": pdf_path.name},
                "extracao_falhou",
                f"extract_pdf nao gerou CSV para {pdf_path.name}"
            )
            continue

        csvs_ok.append(csv_path)
        for row in read_extracted_rows(csv_path):
            dtype = (row.get("document_type") or "").strip().lower()
            if dtype in SKIP_ACCOUNT_TYPES:
                log.info(f"    {dtype.upper()} ignorado — nao gera conta a pagar")
                continue

            gmid    = message_id if acc_index == 0 else f"{message_id}#{acc_index}"
            payload = build_financial_payload(row, gmid)
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

            if ctrl.register_financial(payload):
                accounts_saved += 1
            else:
                ctrl.register_error(
                    ctx, "db_erro",
                    f"Falha ao gravar em financial_emails — {row.get('source_file')}",
                    raw_payload=row
                )
            acc_index += 1

    return csvs_ok, accounts_saved


def try_extract_from_body(email_rec: dict, body_text: str, received_at: str,
                          message_id: str, ctrl: "SupabaseControl") -> bool:
    """Tenta gravar uma conta extraida do corpo do e-mail (sem PDF valido).

    Acionado quando o e-mail nao tem anexo PDF, ou o anexo existente nao
    corresponde as regras de negocio (extracao falhou ou nao gerou conta
    valida). Aplica as mesmas validacoes de negocio do fluxo de PDF — valor
    e identificacao do fornecedor obrigatorios — antes de gravar. Retorna
    True se uma conta foi gravada com sucesso.
    """
    payload = extract_from_email_body(body_text, received_at, message_id)
    if payload is None:
        ctrl.register_error(
            email_rec, "sem_fornecedor",
            "Corpo do e-mail sem nome/responsavel e sem valor — sem PDF valido"
        )
        return False

    if not payload.get("amount"):
        ctrl.register_error(
            email_rec, "sem_valor",
            "Valor ausente no corpo do e-mail — sem PDF valido", raw_payload=payload
        )
        return False

    if not payload.get("supplier_name"):
        ctrl.register_error(
            email_rec, "sem_fornecedor",
            "Nome do fornecedor ausente no corpo do e-mail — sem PDF valido", raw_payload=payload
        )
        return False

    if ctrl.register_financial(payload):
        log.info("    Conta extraída do corpo do e-mail e gravada em financial_emails")
        return True

    ctrl.register_error(
        email_rec, "db_erro",
        "Falha ao gravar conta extraida do corpo do e-mail", raw_payload=payload
    )
    return False

# ---------------------------------------------------------------------------
# Processar um e-mail
# ---------------------------------------------------------------------------
def process_message(mail, uid: bytes, keywords: list,
                    dry_run: bool, mark_seen: bool,
                    ctrl: SupabaseControl) -> dict | None:
    now = datetime.now(timezone.utc).isoformat()
    rec = {c: None for c in LOG_COLUMNS}
    rec["processed_at"] = now

    try:
        _, data = mail.uid("fetch", uid, "(RFC822)")
        raw = data[0][1]
        msg = email.message_from_bytes(raw)

        message_id   = msg.get("Message-ID", f"no-id-{uid.decode()}").strip()
        subject      = decode_str(msg.get("Subject", "(sem assunto)"))
        from_raw     = msg.get("From", "")
        sender_name, sender_email = parseaddr(from_raw)
        sender_name  = decode_str(sender_name) or sender_email
        date_header  = msg.get("Date", "")

        try:
            received_at = parsedate_to_datetime(date_header).astimezone(
                timezone.utc).isoformat()
        except Exception:
            received_at = now

        body_text    = get_body_text(msg)
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
        saved_pdfs  = save_attachments(msg, sender_email, subject, received_at)
        att_names   = [p.name for p in saved_pdfs]
        has_att     = len(saved_pdfs) > 0

        rec["has_attachment"]   = has_att
        rec["attachment_names"] = " | ".join(att_names) if att_names else None
        rec["attachment_saved"] = has_att

        csvs_ok, accounts_saved = extract_and_store_accounts(
            saved_pdfs, message_id, ctrl, email_rec=rec)

        rec["pdf_extracted"]  = len(csvs_ok) > 0
        rec["extraction_csv"] = " | ".join(csvs_ok) if csvs_ok else None
        if accounts_saved:
            log.info(f"    {accounts_saved} conta(s) gravada(s) em financial_emails")

        if not has_att:
            rec["notes"] = "Sem anexo PDF — registrado para revisão"

        # Sem anexo, ou anexo existente nao gerou conta valida — tenta
        # extrair os dados de pagamento do corpo do e-mail (pedido informal
        # de pagamento a fornecedor: nome, valor e dados bancarios no texto)
        if not has_att or accounts_saved == 0:
            if try_extract_from_body(rec, body_text, received_at, message_id, ctrl):
                rec["pdf_extracted"] = True
                rec["notes"]         = "Conta extraída do corpo do e-mail"

        if mark_seen:
            mail.uid("store", uid, "+FLAGS", "\\Seen")

    except Exception as e:
        rec["notes"] = f"Erro: {str(e)[:200]}"
        log.error(f"  Erro UID {uid}: {e}")
        ctrl.register_error(rec, "processamento_erro", str(e))

    # Gravar no Supabase e no CSV local (fallback)
    ctrl.register(rec)
    append_log_csv(rec)
    return rec


# ---------------------------------------------------------------------------
# Execução reutilizável (CLI + API)
# ---------------------------------------------------------------------------
def run_reader(days: int = 0, all_: bool = False,
               dry_run: bool = False, mark_seen: bool = False) -> dict:
    """
    Lê a caixa IMAP, filtra/deduplica e processa os e-mails financeiros.

    Reutilizável tanto pelo CLI (main) quanto pelo backend HTTP (server/app.py).
    Retorna um dicionário-resumo da execução. Lança RuntimeError em falha de IMAP
    (em vez de sys.exit) para que o chamador HTTP possa devolver um erro tratado.
    """
    kw_env   = os.getenv("EMAIL_KEYWORDS", "")
    keywords = [k.strip() for k in kw_env.split(",")] if kw_env else KEYWORDS_DEFAULT

    # Inicializar controle Supabase
    ctrl = SupabaseControl()
    supabase_ok = ctrl._available

    log.info("=" * 58)
    log.info("  email-reader v2.0 — iniciando")
    log.info(f"  Conta    : {os.getenv('IMAP_USER')}")
    log.info(f"  Controle : {'✓ Supabase' if supabase_ok else '✗ Supabase (fallback CSV)'}")
    log.info(f"  Keywords : {len(keywords)} configuradas")
    log.info(f"  Modo     : {'dry-run' if dry_run else 'processamento completo'}")
    log.info("=" * 58)

    try:
        mail = imaplib.IMAP4_SSL(
            os.getenv("IMAP_HOST"),
            int(os.getenv("IMAP_PORT", 993))
        )
        mail.login(os.getenv("IMAP_USER"), os.getenv("IMAP_PASS"))
        mail.select(os.getenv("IMAP_MAILBOX", "INBOX"))
        log.info("IMAP conectado")
    except Exception as e:
        log.error(f"Falha IMAP: {e}")
        raise RuntimeError(f"Falha na conexão IMAP: {e}") from e

    # Critério de busca
    if all_:
        criteria = "ALL"
    elif days > 0:
        since    = (datetime.now() - timedelta(days=days)).strftime("%d-%b-%Y")
        criteria = f'SINCE "{since}"'
    else:
        criteria = "UNSEEN"

    _, uids_data = mail.uid("search", None, criteria)
    uids = uids_data[0].split() if uids_data[0] else []
    log.info(f"E-mails no servidor ({criteria}): {len(uids)}")

    processed = skipped_kw = skipped_dup = 0
    new_subjects = []

    for uid in uids:
        # Buscar só o header para filtrar rapidamente
        _, hdr = mail.uid("fetch", uid,
                          "(BODY.PEEK[HEADER.FIELDS (SUBJECT MESSAGE-ID)])")
        hdr_msg = email.message_from_bytes(hdr[0][1])
        subject = decode_str(hdr_msg.get("Subject", ""))
        msg_id  = hdr_msg.get("Message-ID", "").strip()

        # Filtro por palavra-chave
        if not match_keyword(subject, keywords):
            skipped_kw += 1
            continue

        # Deduplicação via Supabase (ou CSV fallback)
        if msg_id and ctrl.is_processed(msg_id):
            log.info(f"  [DUP] {subject[:65]}")
            skipped_dup += 1
            continue

        log.info(f"  [NEW] {subject[:65]}")
        process_message(mail, uid, keywords, dry_run, mark_seen, ctrl)
        processed += 1
        new_subjects.append(subject[:120])

    mail.logout()

    log.info("=" * 58)
    log.info(f"  Novos processados : {processed}")
    log.info(f"  Sem palavra-chave : {skipped_kw}")
    log.info(f"  Duplicados (skip) : {skipped_dup}")
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
