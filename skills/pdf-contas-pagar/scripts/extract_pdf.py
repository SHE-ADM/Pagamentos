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

# Console do Windows (cp1252) nao encoda os simbolos de log (✓/→/✗).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

CSV_COLUMNS = [
    "source_file","document_type","extraction_source",
    "supplier_name","supplier_cnpj","supplier_cpf","invoice_number",
    "competence_date","due_date","issue_date",
    "amount","currency","payment_method",
    "barcode","description","status",
    "nosso_numero","discount","other_deductions",
    "fine_interest","other_additions","amount_charged",
    "payer_name","payer_cnpj",
    "processing_notes","extracted_at",
]

# Modelo Claude usado tanto na extracao por texto quanto na visao.
CLAUDE_MODEL = "claude-sonnet-4-6"

# Campos de valor que, em branco no boleto, sao gravados como 0.
VALUE_FIELDS_ZERO = [
    "discount", "other_deductions", "fine_interest",
    "other_additions", "amount_charged",
]

# Schema unico de extracao (texto e visao usam o mesmo).
EXTRACTION_PROMPT = (
    "Analise este documento financeiro brasileiro (normalmente um boleto) e "
    "retorne APENAS um JSON valido, sem markdown e sem explicacoes, com "
    "EXATAMENTE estes campos:\n"
    "- document_type: um de boleto|tributo|CT-e|nfe|nfse|fatura|recibo|contrato|outro "
    "(use 'tributo' para DARF, GPS, GARE, DAS (Documento de Arrecadacao do Simples Nacional), "
    "Simples Nacional, SIMEI ou qualquer guia de recolhimento/arrecadacao tributaria; "
    "use exatamente 'CT-e' para CT-e, DACTE ou Conhecimento de Transporte)\n"
    "- supplier_name: nome do BENEFICIARIO/CEDENTE (quem RECEBE o pagamento). "
    "NUNCA use o pagador/sacado.\n"
    "- supplier_cnpj: CNPJ do BENEFICIARIO (apenas digitos, 14 caracteres). "
    "Retorne null se nao houver CNPJ. NUNCA o do pagador.\n"
    "- supplier_cpf: CPF do BENEFICIARIO (apenas digitos, 11 caracteres), "
    "somente quando o beneficiario for pessoa fisica e nao houver CNPJ. "
    "Retorne null se nao houver CPF. NUNCA o do pagador.\n"
    "- invoice_number: o NUMERO do 'N do Documento' (ex.: 12345). NUNCA "
    "retorne a Especie do Documento (siglas DM, DMI, DS, NP, RC, LC). Se so "
    "houver a especie e nao o numero, use null.\n"
    "- issue_date: Data do Documento, formato YYYY-MM-DD\n"
    "- due_date: Data de Vencimento, formato YYYY-MM-DD\n"
    "- amount: Valor do Documento (numero decimal com ponto)\n"
    "- discount: (-) Desconto / Abatimentos (decimal; 0 se em branco)\n"
    "- other_deductions: (-) Outras deducoes (decimal; 0 se em branco)\n"
    "- fine_interest: (+) Mora / Multa (decimal; 0 se em branco)\n"
    "- other_additions: (+) Outros acrescimos (decimal; 0 se em branco)\n"
    "- amount_charged: (=) Valor cobrado (decimal; 0 se em branco)\n"
    "- nosso_numero: Nosso Numero (texto)\n"
    "- barcode: codigo de barras de 44 digitos OU linha digitavel de 47 digitos "
    "(apenas digitos, sem espacos ou pontos). Retorne o valor mais completo visivel "
    "no documento. null se ausente.\n"
    "- payment_method: boleto|pix|ted|cartao|outro\n"
    "- competence_date: competencia no formato YYYY-MM, ou null\n"
    "- currency: moeda (BRL por padrao)\n"
    "- payer_name: nome do SACADO/PAGADOR (quem PAGA o documento). "
    "NUNCA use o beneficiario/cedente.\n"
    "- payer_cnpj: CNPJ do SACADO/PAGADOR (apenas digitos). NUNCA o do beneficiario.\n"
    "- description: texto das Instrucoes/observacoes do beneficiario\n"
    "Use null para campos de TEXTO ausentes e 0 para os campos de VALOR em branco."
)

KEYWORDS = {
    # CT-e antes de nfe: ambos tem "chave de acesso", mas CT-e e mais especifico.
    "CT-e":    ["dacte","conhecimento de transporte","ct-e","cte-os","modal rodoviario"],
    "TRIBUTO": ["darf","gps","gare","simples nacional","simei",
                "das simples","das-simples","documento de arrecadacao do simples",
                "guia de recolhimento","guia de pagamento","documento de arrecadacao"],
    "NFE":     ["danfe","nota fiscal eletrônica","nf-e","chave de acesso","emitente"],
    "NFSE":    ["nota fiscal de serviços","nfs-e","prestador","tomador","iss"],
    "BOLETO":  ["cedente","beneficiário","linha digitável","nosso número","sacado"],
    "FATURA":  ["fatura","conta do mês","total da fatura","vencimento da fatura"],
}

# Normalização de casing — .upper() quebra "CT-e" (vira "CT-E").
# Chaves: valor uppercase; Valores: casing canônico final.
_DOC_TYPE_CASING = {"CT-E": "CT-e"}

def _normalize_doc_type(raw: str) -> str:
    """Normaliza document_type: maiúsculo por padrão, exceto tipos com casing fixo."""
    upper = (raw or "OUTRO").strip().upper()
    return _DOC_TYPE_CASING.get(upper, upper)

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

def normalize_barcode(raw):
    """Normaliza barcode ou linha digitavel para 44 digitos.

    - 44 digitos: barcode valido, retorna como esta
    - 47 digitos: linha digitavel bancaria FEBRABAN -> converte para barcode 44
    - Outros comprimentos ou None: retorna None
    """
    if not raw:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) == 44:
        return digits
    if len(digits) == 47:
        # Estrutura linha digitavel: banco(3)+moeda(1)+cl1(5)+dv1+cl2(10)+dv2+cl3(10)+dv3+dg(1)+venc(4)+valor(10)
        return (
            digits[0:4]   +   # banco + moeda
            digits[32:33] +   # digito verificador geral
            digits[33:47] +   # vencimento (4) + valor (10)
            digits[4:9]   +   # campo livre 1 (5 digitos, sem DV)
            digits[10:20] +   # campo livre 2 (10 digitos, sem DV)
            digits[21:31]     # campo livre 3 (10 digitos, sem DV)
        )
    return None


def extract_barcode(text):
    # Prefere o padrao estruturado da linha digitavel (mais preciso)
    ld = extract_linha_digitavel(text)
    if ld:
        return normalize_barcode(ld)
    # Fallback: qualquer sequencia longa de digitos
    m = re.search(r"[\d\s\.]{47,60}", text)
    if m:
        return normalize_barcode(re.sub(r"\D", "", m.group()))
    return None

def extract_linha_digitavel(text):
    """Linha digitavel do boleto (47 digitos em 5 campos com pontos/espacos).

    Extracao deterministica a partir do texto do PDF: e mais confiavel que o
    LLM para sequencias longas de digitos (campo critico de pagamento).
    """
    m = re.search(
        r"\d{5}\.\d{5}\s+\d{5}\.\d{6}\s+\d{5}\.\d{6}\s+\d\s+\d{14}", text)
    return re.sub(r"\D", "", m.group()) if m else None

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

    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=CLAUDE_MODEL, max_tokens=1200, temperature=0,
        messages=[{"role":"user","content":[
            {"type":"image","source":{"type":"base64",
             "media_type":"image/jpeg","data":img_b64}},
            {"type":"text","text":EXTRACTION_PROMPT}
        ]}]
    )
    return resp.content[0].text.strip(), "pdf_vision"


# --- Extração de campos via Claude (texto do PDF) ---
def extract_fields_with_claude(text: str) -> dict:
    """Envia o texto do PDF ao Claude e retorna os campos como dict.

    Lanca excecao se a chave nao estiver definida ou o retorno nao for JSON,
    para que o chamador possa cair no fallback por regex.
    """
    import anthropic
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise EnvironmentError("ANTHROPIC_API_KEY não definida no .env")

    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=CLAUDE_MODEL, max_tokens=1200, temperature=0,
        messages=[{"role":"user","content":
            f"{EXTRACTION_PROMPT}\n\nTEXTO DO DOCUMENTO:\n{text[:12000]}"
        }]
    )
    return json.loads(_strip_json_fences(resp.content[0].text))

# --- Helpers de normalizacao ---
def _strip_json_fences(text: str) -> str:
    """Remove cercas markdown (```json ... ```) que o modelo possa incluir."""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    return t.strip()


def _to_decimal(value, default=None):
    """Converte texto/numero em float (2 casas). Aceita formato BR e 'R$'."""
    if value is None:
        return default
    s = str(value).strip().replace("R$", "").replace(" ", "")
    if s == "" or s.lower() in ("none", "nan", "null"):
        return default
    # Formato brasileiro (1.234,56) -> 1234.56
    if re.search(r",\d{1,2}$", s):
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", "")
    try:
        return round(float(s), 2)
    except ValueError:
        return default


def resolve_amount_charged(rec: dict) -> float:
    """Valor a pagar (amount_charged).

    Quando o campo "(=) Valor cobrado" vem em branco no boleto (0), calcula a
    partir do documento: amount - desconto - outras deducoes + mora/multa +
    outros acrescimos. Em boleto simples (sem deducoes/acrescimos) o resultado
    e o proprio valor do documento. Se o campo (=) ja veio preenchido, respeita.
    """
    ac = rec.get("amount_charged") or 0
    if ac:
        return ac
    base = rec.get("amount")
    if base is None:
        return 0
    computed = (base
                - (rec.get("discount") or 0)
                - (rec.get("other_deductions") or 0)
                + (rec.get("fine_interest") or 0)
                + (rec.get("other_additions") or 0))
    return round(computed, 2) if computed > 0 else 0


def _due_date_ddmmyyyy(due_date) -> str:
    """Converte vencimento 'YYYY-MM-DD' em 'DDMMYYYY'.

    Sem vencimento (ou data invalida), usa a data de extracao (hoje) — regra
    de negocio para o invoice_number sintetico.
    """
    if due_date:
        try:
            return datetime.strptime(str(due_date)[:10], "%Y-%m-%d").strftime("%d%m%Y")
        except ValueError:
            pass
    return datetime.now().strftime("%d%m%Y")


def fallback_invoice_number(pdf_path, due_date) -> str:
    """invoice_number sintetico quando o documento nao traz N do Documento.

    Regra de negocio: nome do arquivo (sem extensao) + '_' + vencimento em
    DDMMYYYY. Ex.: 'Fatura_.Locaweb1850038_03062026'.
    """
    return f"{pdf_path.stem}_{_due_date_ddmmyyyy(due_date)}"


def has_document_number(value) -> bool:
    """True se ha um N do Documento utilizavel.

    Considera AUSENTE: vazio, ou valores sem nenhum digito — caso tipico do
    modelo capturar a Especie do Documento (DM, DS, NP) ou 'S/N' no lugar do
    numero. Um numero de documento valido sempre contem ao menos um digito.
    """
    s = (value or "").strip()
    return bool(s) and any(c.isdigit() for c in s)


# --- Montar registro a partir de JSON (Claude texto ou visao) ---
def build_record_from_json(pdf_path, data: dict, source: str) -> dict:
    notes = []
    cnpj    = re.sub(r"\D", "", str(data.get("supplier_cnpj") or ""))
    cpf     = re.sub(r"\D", "", str(data.get("supplier_cpf")  or ""))
    barcode = normalize_barcode(data.get("barcode"))
    rec = {
        "source_file": pdf_path.name,
        "document_type": _normalize_doc_type(data.get("document_type") or "outro"),
        "extraction_source": source,
        "supplier_name": data.get("supplier_name"),
        "supplier_cnpj": cnpj if len(cnpj) == 14 else None,
        "supplier_cpf":  cpf  if len(cpf)  == 11 else None,
        "invoice_number": data.get("invoice_number"),
        "competence_date": data.get("competence_date"),
        "due_date": data.get("due_date"),
        "issue_date": data.get("issue_date"),
        "amount": _to_decimal(data.get("amount")),
        "currency": data.get("currency") or "BRL",
        "payment_method": data.get("payment_method") or "outro",
        "barcode": barcode or None,
        "description": data.get("description"),
        "status": "pending",
        "nosso_numero": data.get("nosso_numero"),
        "payer_name": data.get("payer_name"),
        "payer_cnpj": re.sub(r"\D", "", str(data.get("payer_cnpj") or "")) or None,
        "processing_notes": None,
        "extracted_at": datetime.utcnow().isoformat(),
    }
    for vf in VALUE_FIELDS_ZERO:
        rec[vf] = _to_decimal(data.get(vf), 0)
    rec["amount_charged"] = resolve_amount_charged(rec)
    if cnpj and len(cnpj) != 14:
        notes.append("CNPJ do beneficiario invalido")
    if not has_document_number(rec["invoice_number"]):
        rec["invoice_number"] = fallback_invoice_number(pdf_path, rec["due_date"])
        notes.append("N documento ausente — gerado de arquivo+vencimento")
    rec["processing_notes"] = " | ".join(notes) if notes else None
    return rec


# --- Montar registro por regex (fallback quando Claude indisponivel) ---
def build_record_regex(pdf_path, raw: str, source: str) -> dict:
    now = datetime.utcnow().isoformat()
    dt  = classify_document(raw)
    notes = ["Extração por regex (fallback) — conferir valores"]
    rec = {
        "source_file": pdf_path.name, "document_type": _normalize_doc_type(dt),
        "extraction_source": source,
        "supplier_name": extract_supplier_name(raw, dt),
        "supplier_cnpj": extract_cnpj(raw),
        "invoice_number": extract_invoice_number(raw, dt),
        "competence_date": None,
        "due_date": extract_date(raw), "issue_date": None,
        "amount": extract_amount(raw), "currency": "BRL",
        "payment_method": extract_payment_method(raw, dt),
        "barcode": extract_barcode(raw), "description": None,
        "status": "pending", "nosso_numero": None,
        "supplier_cpf": None,
        "payer_name": None, "payer_cnpj": None,
        "processing_notes": None, "extracted_at": now,
    }
    for vf in VALUE_FIELDS_ZERO:
        rec[vf] = 0
    rec["amount_charged"] = resolve_amount_charged(rec)
    if len(raw) < 80:
        notes.append("Texto insuficiente — considerar Vision")
    if not has_document_number(rec["invoice_number"]):
        rec["invoice_number"] = fallback_invoice_number(pdf_path, rec["due_date"])
        notes.append("N documento ausente — gerado de arquivo+vencimento")
    rec["processing_notes"] = " | ".join(notes)
    return rec


# --- Montar registro (dispatcher) ---
def build_record(pdf_path, raw, source):
    if source == "pdf_vision":
        try:
            data = json.loads(_strip_json_fences(raw))
        except json.JSONDecodeError:
            rec = build_record_from_json(pdf_path, {}, source)
            rec["processing_notes"] = "Vision retornou resposta não-JSON"
            return rec
        return build_record_from_json(pdf_path, data, source)

    # pdf_text: tenta Claude e cai para regex se falhar (sem chave, erro de API...)
    try:
        data = extract_fields_with_claude(raw)
        rec = build_record_from_json(pdf_path, data, source)
    except Exception as e:
        log.warning(f"  Extração via Claude (texto) falhou ({e}) — fallback regex")
        rec = build_record_regex(pdf_path, raw, source)

    # Linha digitavel: prioriza a extracao deterministica do texto (mais
    # confiavel que o LLM em sequencias longas de digitos).
    ld = extract_linha_digitavel(raw)
    if ld:
        rec["barcode"] = ld
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
        return {"source_file": pdf_path.name, "document_type": "ERRO",
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
