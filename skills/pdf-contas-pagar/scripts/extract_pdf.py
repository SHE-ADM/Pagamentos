"""
extract_pdf.py — Extração de dados financeiros de PDFs para CSV
Projeto: pagamentos | Skill: pdf-contas-pagar | v1.0.0
"""

import os, re, sys, json, argparse, logging
from datetime import datetime
from pathlib import Path

import pdfplumber
import pandas as pd
from dotenv import load_dotenv

load_dotenv(Path(__file__).parents[3] / ".env")

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("pdf-contas-pagar")

CSV_COLUMNS = [
    "source_file","document_type","extraction_source",
    "supplier_name","supplier_cnpj","invoice_number",
    "competence_date","due_date","issue_date",
    "amount","currency","payment_method",
    "barcode","description","status",
    "processing_notes","extracted_at",
]

KEYWORDS = {
    "nfe":    ["danfe","nota fiscal eletrônica","nf-e","chave de acesso","emitente"],
    "nfse":   ["nota fiscal de serviços","nfs-e","prestador","tomador","iss"],
    "boleto": ["cedente","beneficiário","linha digitável","nosso número","sacado"],
    "fatura": ["fatura","conta do mês","total da fatura","vencimento da fatura"],
}

# --- Classificação ---
def classify_document(text: str) -> str:
    t = text.lower()
    for doc_type, keys in KEYWORDS.items():
        if any(k in t for k in keys):
            return doc_type
    return "outro"

# --- Extratores por regex ---
def extract_cnpj(text):
    m = re.search(r"\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\/\.\s]?\d{4}[-\.\s]?\d{2}", text)
    return re.sub(r"\D","",m.group()) if m else None

def extract_amount(text):
    m = re.search(r"(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+,\d{2})", text)
    if m:
        try:
            return str(round(float(m.group(1).replace(".","").replace(",",".")),2))
        except ValueError:
            return None
    return None

def extract_date(text):
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", text)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", text)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None

def extract_barcode(text):
    m = re.search(r"[\d\s\.]{47,60}", text)
    if m:
        raw = re.sub(r"\D","",m.group())
        return raw if len(raw) in (47,48) else None
    return None

def extract_invoice_number(text, doc_type):
    if doc_type in ("nfe","nfse"):
        m = re.search(r"n[ºo°]?\.?\s*(\d{6,9})", text, re.IGNORECASE)
        return m.group(1) if m else None
    if doc_type == "fatura":
        m = re.search(r"fatura\s+n[ºo°]?\.?\s*(\d+)", text, re.IGNORECASE)
        return m.group(1) if m else None
    return None

def extract_supplier_name(text, doc_type):
    hints = {"boleto":["cedente","beneficiário"],"nfe":["emitente","razão social"],
             "nfse":["prestador","razão social"],"fatura":["operadora","empresa"]}
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if any(k in line.lower() for k in hints.get(doc_type,[])):
            for j in range(i+1, min(i+4,len(lines))):
                c = lines[j].strip()
                if len(c) > 5:
                    return c[:120]
    return None

def extract_payment_method(text, doc_type):
    if doc_type == "boleto": return "boleto"
    t = text.lower()
    if "pix" in t: return "pix"
    if "ted" in t or "transferência" in t: return "ted"
    if "cartão" in t or "cartao" in t: return "cartao"
    return "outro"

# --- Verificar se PDF é scan ---
def is_scanned_pdf(pdf_path):
    import subprocess
    try:
        r = subprocess.run(["pdffonts", str(pdf_path)],
                           capture_output=True, text=True)
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        return len(lines) <= 2
    except FileNotFoundError:
        log.warning("pdffonts não encontrado — assumindo PDF digital")
        return False

# --- Extração via pdfplumber ---
def extract_with_pdfplumber(pdf_path):
    full_text = ""
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            full_text += (page.extract_text() or "") + "\n"
    return full_text.strip(), "pdf_text"

# --- Extração via Claude Vision ---
def extract_with_vision(pdf_path):
    import base64, anthropic, tempfile, subprocess
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise EnvironmentError("ANTHROPIC_API_KEY não definida no .env")

    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "page")
        subprocess.run(["pdftoppm","-jpeg","-r","200","-f","1","-l","1",
                        str(pdf_path), out], check=True, capture_output=True)
        imgs = sorted(Path(tmp).glob("*.jpg"))
        if not imgs:
            raise RuntimeError(f"Nenhuma imagem gerada de {pdf_path.name}")
        img_b64 = base64.standard_b64encode(imgs[0].read_bytes()).decode()

    prompt = (
        "Analise este documento financeiro brasileiro e retorne APENAS um JSON "
        "(sem markdown, sem explicações) com os campos: "
        "supplier_name, supplier_cnpj, invoice_number, due_date (YYYY-MM-DD), "
        "issue_date (YYYY-MM-DD), competence_date (YYYY-MM), amount (decimal ponto), "
        "currency (BRL), payment_method (boleto/pix/ted/cartao/outro), "
        "barcode, description, document_type (boleto/nfe/nfse/fatura/recibo/outro). "
        "Use null para campos ausentes."
    )
    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model="claude-sonnet-4-20250514", max_tokens=1000,
        messages=[{"role":"user","content":[
            {"type":"image","source":{"type":"base64",
             "media_type":"image/jpeg","data":img_b64}},
            {"type":"text","text":prompt}
        ]}]
    )
    return resp.content[0].text.strip(), "pdf_vision"

# --- Montar registro ---
def build_record(pdf_path, raw, source):
    now = datetime.utcnow().isoformat()
    notes = []
    if source == "pdf_vision":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {}
            notes.append("Vision retornou resposta não-JSON")
        rec = {
            "source_file": pdf_path.name, "document_type": data.get("document_type","outro"),
            "extraction_source": source,
            "supplier_name": data.get("supplier_name"),
            "supplier_cnpj": re.sub(r"\D","",data.get("supplier_cnpj") or ""),
            "invoice_number": data.get("invoice_number"),
            "competence_date": data.get("competence_date"),
            "due_date": data.get("due_date"), "issue_date": data.get("issue_date"),
            "amount": data.get("amount"), "currency": data.get("currency","BRL"),
            "payment_method": data.get("payment_method","outro"),
            "barcode": data.get("barcode"), "description": data.get("description"),
            "status": "pending", "processing_notes": None, "extracted_at": now,
        }
    else:
        dt = classify_document(raw)
        rec = {
            "source_file": pdf_path.name, "document_type": dt,
            "extraction_source": source,
            "supplier_name": extract_supplier_name(raw, dt),
            "supplier_cnpj": extract_cnpj(raw),
            "invoice_number": extract_invoice_number(raw, dt),
            "competence_date": None,
            "due_date": extract_date(raw), "issue_date": None,
            "amount": extract_amount(raw), "currency": "BRL",
            "payment_method": extract_payment_method(raw, dt),
            "barcode": extract_barcode(raw), "description": None,
            "status": "pending", "processing_notes": None, "extracted_at": now,
        }
        if len(raw) < 80:
            notes.append("Texto insuficiente — considerar Vision")
    if not rec.get("invoice_number"):
        notes.append("Revisão manual necessária")
    rec["processing_notes"] = " | ".join(notes) if notes else None
    return rec

# --- Processar um PDF ---
def process_pdf(pdf_path, force_vision=False):
    log.info(f"Processando: {pdf_path.name}")
    try:
        if force_vision or is_scanned_pdf(pdf_path):
            log.info("  → Claude Vision")
            raw, src = extract_with_vision(pdf_path)
        else:
            log.info("  → pdfplumber")
            raw, src = extract_with_pdfplumber(pdf_path)
            if len(raw) < 80:
                log.warning(f"  → Texto curto ({len(raw)} chars) — fallback Vision")
                raw, src = extract_with_vision(pdf_path)
        return build_record(pdf_path, raw, src)
    except Exception as e:
        log.error(f"  ✗ {pdf_path.name}: {e}")
        return {"source_file": pdf_path.name, "document_type": "erro",
                "extraction_source": "error", "status": "error",
                "processing_notes": str(e), "extracted_at": datetime.utcnow().isoformat(),
                **{c: None for c in CSV_COLUMNS if c not in
                   ["source_file","document_type","extraction_source",
                    "status","processing_notes","extracted_at"]}}

# --- CLI ---
def main():
    parser = argparse.ArgumentParser(description="Extrai PDFs financeiros → CSV")
    parser.add_argument("--input",  required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--batch",  action="store_true")
    parser.add_argument("--force-vision", action="store_true")
    args = parser.parse_args()

    inp = Path(args.input)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    pdfs = sorted(inp.glob("*.pdf")) if (args.batch or inp.is_dir()) else [inp]
    if not pdfs:
        log.error(f"Nenhum PDF em {inp}"); sys.exit(1)

    log.info(f"Total: {len(pdfs)} arquivo(s)")
    records, errors = [], []

    for pdf in pdfs:
        rec = process_pdf(pdf, force_vision=args.force_vision)
        (errors if rec.get("extraction_source") == "error" else records).append(rec)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    if records:
        df = pd.DataFrame(records, columns=CSV_COLUMNS)
        path = out / f"{ts}_extracted.csv"
        df.to_csv(path, index=False, encoding="utf-8-sig", sep=";")
        log.info(f"✓ {path} ({len(records)} registros)")
    if errors:
        path = out / f"{ts}_errors.log"
        path.write_text("\n".join(f"{e['source_file']} | {e['processing_notes']}"
                                  for e in errors), encoding="utf-8")
        log.warning(f"⚠ {path} ({len(errors)} erros)")

if __name__ == "__main__":
    main()
