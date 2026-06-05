"""
read_emails.py — Leitura de e-mails financeiros via IMAP + controle Supabase
Projeto: pagamentos | Skill: email-reader | v2.0.0

Deduplicação: tabela email_control no Supabase (message_id UNIQUE).
Nunca reprocessa um e-mail já registrado, independente de onde o script rodar.
"""

import os, sys, re, imaplib, email, argparse, logging, subprocess, csv, json
import urllib.request, urllib.error
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime
from datetime import datetime, timezone, timedelta
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parents[3] / ".env")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
log = logging.getLogger("email-reader")

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
    "cobrança", "vencimento", "pagamento", "duplicata",
    "recibo", "nfs-e", "danfe"
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
    """Fallback local: acrescenta registro no CSV."""
    write_header = not EMAILS_LOG.exists()
    with open(EMAILS_LOG, "a", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=LOG_COLUMNS, delimiter=";",
                           extrasaction="ignore")
        if write_header:
            w.writeheader()
        w.writerow(record)


# ---------------------------------------------------------------------------
# Gravacao da conta extraida em financial_emails
# ---------------------------------------------------------------------------
# Colunas geradas pelo extract_pdf.py (na mesma ordem do CSV de saida).
FINANCIAL_FIELDS = [
    "source_file", "document_type", "extraction_source",
    "supplier_name", "supplier_cnpj", "invoice_number",
    "competence_date", "due_date", "issue_date",
    "amount", "currency", "payment_method",
    "barcode", "description", "status",
    "processing_notes", "extracted_at",
]


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

    # supplier_cnpj e CHAR(14): so aceita exatamente 14 digitos
    cnpj = re.sub(r"\D", "", payload.get("supplier_cnpj") or "")
    payload["supplier_cnpj"] = cnpj if len(cnpj) == 14 else None

    # amount NUMERIC(15,2): garante numero ou None
    amt = payload.get("amount")
    if amt is not None:
        try:
            payload["amount"] = round(float(str(amt).replace(",", ".")), 2)
        except ValueError:
            payload["amount"] = None

    payload["currency"] = payload.get("currency") or "BRL"
    payload["status"]   = payload.get("status") or "pending"
    payload["gmail_message_id"] = gmail_message_id
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
    if not EXTRACT_SCRIPT.exists():
        log.warning(f"extract_pdf.py não encontrado: {EXTRACT_SCRIPT}")
        return None
    try:
        result = subprocess.run(
            [sys.executable, str(EXTRACT_SCRIPT),
             "--input", str(pdf_path),
             "--output", str(CSV_OUTPUT)],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode == 0:
            csvs = sorted(CSV_OUTPUT.glob("*_extracted.csv"),
                          key=lambda p: p.stat().st_mtime, reverse=True)
            return str(csvs[0]) if csvs else None
        log.error(f"    Erro extração: {result.stderr[:200]}")
        return None
    except Exception as e:
        log.error(f"    Falha extract_pdf: {e}")
        return None


def extract_and_store_accounts(saved_pdfs: list, message_id: str,
                               ctrl: "SupabaseControl") -> tuple:
    """Extrai cada PDF e grava as contas resultantes em financial_emails.

    Liga cada conta ao e-mail por gmail_message_id; multiplos PDFs no mesmo
    e-mail recebem sufixo (#1, #2, ...) para nao colidir na chave unica.
    Retorna (lista de CSVs gerados, total de contas gravadas).
    """
    csvs_ok, accounts_saved, acc_index = [], 0, 0
    for pdf_path in saved_pdfs:
        csv_path = run_extraction(pdf_path)
        if not csv_path:
            continue
        csvs_ok.append(csv_path)
        for row in read_extracted_rows(csv_path):
            gmid = message_id if acc_index == 0 else f"{message_id}#{acc_index}"
            if ctrl.register_financial(build_financial_payload(row, gmid)):
                accounts_saved += 1
            acc_index += 1
    return csvs_ok, accounts_saved

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
            saved_pdfs, message_id, ctrl)

        rec["pdf_extracted"]  = len(csvs_ok) > 0
        rec["extraction_csv"] = " | ".join(csvs_ok) if csvs_ok else None
        if accounts_saved:
            log.info(f"    {accounts_saved} conta(s) gravada(s) em financial_emails")

        if not has_att:
            rec["notes"] = "Sem anexo PDF — registrado para revisão"

        if mark_seen:
            mail.uid("store", uid, "+FLAGS", "\\Seen")

    except Exception as e:
        rec["notes"] = f"Erro: {str(e)[:200]}"
        log.error(f"  Erro UID {uid}: {e}")

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
    except RuntimeError as e:
        log.error(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
