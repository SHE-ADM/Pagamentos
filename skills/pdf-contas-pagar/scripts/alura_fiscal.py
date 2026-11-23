"""Regra ALURA (AOVS SISTEMAS DE INFORMATICA S.A.): o e-mail mensal traz DUAS notas — a NF de
produto (DANFE) e a NF de servico (NFS-e) — e cada uma vira uma conta a pagar, ja paga.

Este modulo e PURO (sem rede, sem banco): so parseia texto e valida. A orquestracao (download da
NFS-e, dedup, gravacao) vive em `read_emails.py`, que carrega este arquivo sob demanda.

Principio: nada e inventado. Todo valor vem do TEXTO do documento e e conferido contra uma
segunda fonte (chave de acesso x numero impresso, numero do e-mail x numero da nota, CNPJ do
prestador x CNPJ conhecido). Divergiu ou faltou ⇒ devolve None e a conta NAO nasce.
"""

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

import fiscal_key

# CNPJ do prestador/emitente (AOVS SISTEMAS DE INFORMATICA S.A. — nome fantasia ALURA).
ALURA_CNPJ = "05555382000133"
# Dominio dos e-mails da Alura (o remetente ORIGINAL do bloco encaminhado).
ALURA_EMAIL_DOMAIN = "alura.com.br"
# Modelo 55 = NF-e (DANFE).
NFE_MODEL = 55
# Host da NFS-e da prefeitura de Sao Paulo — unico destino que a regra aceita buscar.
NFSE_HOST = "nfe.prefeitura.sp.gov.br"
NFSE_PAGE_PATH = "/contribuinte/notaprint.aspx"
NFSE_PDF_PATH = "/contribuinte/notaprintpdf.aspx"
# Marca em `processing_notes` (aparece como "Observacoes" em /consulta).
RULE_NOTE = "Regra ALURA: conta gerada da NF de produto/serviço do e-mail mensal"

_MONEY_RE = re.compile(r"\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}")
_DATE_RE = re.compile(r"(\d{2})/(\d{2})/(\d{4})")
_CNPJ_RE = re.compile(r"\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}")
_EMAIL_RE = re.compile(r"[\w.+-]+@([\w-]+(?:\.[\w-]+)+)", re.IGNORECASE)
# 'serviço'/'servico' — \S{1,2} tolera ç, U+FFFD e a forma decomposta.
_LABEL_NFSE_RE = re.compile(
    r"NF\s+de\s+servi\S{1,2}o\s*:\s*(\d{4,12})(?:\s*<\s*(https?://[^\s>]+)\s*>)?", re.IGNORECASE)
_LABEL_NFE_RE = re.compile(r"NF\s+de\s+produto\s*:\s*(\d{4,12})", re.IGNORECASE)
_FORWARD_HEADER_RE = re.compile(r"^\s*(?:De|From)\s*:(.*)$", re.IGNORECASE | re.MULTILINE)
_SAFE_QUERY_VALUE_RE = re.compile(r"^[A-Za-z0-9]{1,40}$")


def _money(text: "str | None") -> "Decimal | None":
    """'1.234,56' → Decimal('1234.56'); None quando nao e valor monetario positivo."""
    if not text:
        return None
    try:
        value = Decimal(text.strip().replace(".", "").replace(",", "."))
    except InvalidOperation:
        return None
    return value if value > 0 else None


def _iso_date(text: "str | None") -> "str | None":
    """'16/11/2026' → '2026-11-16'; None quando nao e uma data de calendario valida."""
    match = _DATE_RE.search(text or "")
    if not match:
        return None
    day, month, year = (int(g) for g in match.groups())
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def same_number(a: "str | None", b: "str | None") -> bool:
    """Compara numeros de nota ignorando zeros a esquerda, ponto e formato."""
    da, db = re.sub(r"\D", "", a or "").lstrip("0"), re.sub(r"\D", "", b or "").lstrip("0")
    return bool(da) and da == db


def _not_future(iso: str, ref_date: "date | None") -> bool:
    """Emissao nao pode ser posterior ao dia do e-mail (+1 dia de folga de fuso)."""
    ref = ref_date or date.today()
    return (datetime.strptime(iso, "%Y-%m-%d").date() - ref).days <= 1


# ---------------------------------------------------------------------------
# E-mail
# ---------------------------------------------------------------------------
def parse_email(body_text: "str | None") -> "dict | None":
    """Reconhece o e-mail mensal da Alura pelo CORPO.

    Exige TODOS: remetente ORIGINAL @alura.com.br numa linha 'De:' do bloco encaminhado E os dois
    rotulos 'NF de servico: <n>' e 'NF de produto: <n>'. Devolve
    {'nfse_number', 'nfe_number', 'nfse_url' (ou None)}; None quando qualquer um falta."""
    if not body_text:
        return None
    from_alura = False
    for header in _FORWARD_HEADER_RE.finditer(body_text):
        for domain in _EMAIL_RE.findall(header.group(1)):
            domain = domain.lower()
            if domain == ALURA_EMAIL_DOMAIN or domain.endswith("." + ALURA_EMAIL_DOMAIN):
                from_alura = True
    if not from_alura:
        return None
    nfse, nfe = _LABEL_NFSE_RE.search(body_text), _LABEL_NFE_RE.search(body_text)
    if not (nfse and nfe):
        return None
    return {"nfse_number": nfse.group(1), "nfe_number": nfe.group(1), "nfse_url": nfse.group(2)}


def sender_is_authorized(sender_email: "str | None", supplier_emails) -> bool:
    """O remetente IMEDIATO pode disparar a regra? So se for da Alura ou um e-mail do cadastro.

    Sem isto, qualquer um que colasse um cabecalho 'De: x@alura.com.br' no corpo geraria contas
    PAGAS. O cadastro do fornecedor (email..email4) e a lista de quem pode encaminhar."""
    email = (sender_email or "").strip().lower()
    if not email or "@" not in email:
        return False
    domain = email.rsplit("@", 1)[1]
    if domain == ALURA_EMAIL_DOMAIN or domain.endswith("." + ALURA_EMAIL_DOMAIN):
        return True
    return email in {(e or "").strip().lower() for e in (supplier_emails or ()) if e}


# ---------------------------------------------------------------------------
# NF de produto (DANFE)
# ---------------------------------------------------------------------------
def parse_danfe(text: "str | None", ref_date: "date | None" = None) -> "dict | None":
    """Le o DANFE da Alura. None quando qualquer conferencia falha.

    Conferencias: chave de acesso valida (5 camadas de fiscal_key) de modelo 55 emitida pelo
    CNPJ da Alura; emissao impressa no mes (AAMM) da chave; valor total > 0; emissao nao futura."""
    if not text:
        return None
    key = None
    for raw in fiscal_key.extract_access_keys(text, ref_date):
        parsed = fiscal_key.parse_access_key(raw, ref_date)
        if parsed and parsed["model"] == NFE_MODEL and parsed["emitter_cnpj"] == ALURA_CNPJ:
            key = parsed
            break
    if not key:
        return None

    issue = None
    match = re.search(r"EMISS\S{1,2}O\s*:\s*(\d{2}/\d{2}/\d{4})", text, re.IGNORECASE)
    if match:
        issue = _iso_date(match.group(1))
    if not issue or issue[2:4] + issue[5:7] != key["issue_yearmonth"] or not _not_future(issue, ref_date):
        return None

    amount = None
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if "VALOR TOTAL DA NOTA" in line.upper() and i + 1 < len(lines):
            values = _MONEY_RE.findall(lines[i + 1])
            amount = _money(values[-1]) if values else None
            break
    if amount is None:
        return None

    others = {re.sub(r"\D", "", c) for c in _CNPJ_RE.findall(text)} - {ALURA_CNPJ}
    number = f"{key['doc_number']:09d}"
    return {
        "access_key": key["access_key"],
        "invoice_number": f"{number[0:3]}.{number[3:6]}.{number[6:9]}",
        "doc_number": key["doc_number"],
        "issue_date": issue,
        "amount": f"{amount:.2f}",
        "payer_cnpj": next(iter(others)) if len(others) == 1 else None,
    }


# ---------------------------------------------------------------------------
# NF de servico (NFS-e da prefeitura de Sao Paulo)
# ---------------------------------------------------------------------------
def nfse_pdf_url(page_url: "str | None") -> "str | None":
    """URL do PDF da NFS-e a partir do link da PAGINA do e-mail, ou None.

    A pagina (`notaprint.aspx`) carrega o documento por JavaScript num iframe; o PDF real e
    `notaprintpdf.aspx` com os mesmos parametros. A URL e RECONSTRUIDA dos tres parametros
    validados — nunca ecoada —, e so o host da prefeitura e aceito."""
    if not page_url:
        return None
    try:
        parts = urlsplit(page_url.strip())
    except ValueError:
        return None
    if parts.scheme != "https" or (parts.hostname or "").lower() != NFSE_HOST \
            or parts.path.lower() != NFSE_PAGE_PATH or parts.port not in (None, 443):
        return None
    params = {}
    for pair in parts.query.split("&"):
        name, _, value = pair.partition("=")
        params[name.lower()] = value
    if not all(_SAFE_QUERY_VALUE_RE.match(params.get(k, "")) for k in ("inscricao", "nf", "verificacao")):
        return None
    return (f"https://{NFSE_HOST}{NFSE_PDF_PATH}?inscricao={params['inscricao']}"
            f"&nf={params['nf']}&verificacao={params['verificacao']}")


def parse_nfse(text: "str | None", expected_number: "str | None",
               ref_date: "date | None" = None) -> "dict | None":
    """Le a NFS-e da prefeitura de SP. None quando qualquer conferencia falha.

    Conferencias: prestador = CNPJ da Alura; numero da nota == o numero que o e-mail citou;
    valor total do servico > 0; emissao valida e nao futura."""
    if not text:
        return None
    provider = re.search(r"PRESTADOR\s+DE\s+SERVI\S{1,3}OS\s*\n\s*CPF/CNPJ\s*:\s*(\S+)", text, re.IGNORECASE)
    if not provider or re.sub(r"\D", "", provider.group(1)) != ALURA_CNPJ:
        return None
    number = re.search(r"^\s*(\d{8})\s*$", text, re.MULTILINE)
    if not number or not same_number(number.group(1), expected_number):
        return None
    issue_match = re.search(r"(\d{2}/\d{2}/\d{4})\s+\d{2}:\d{2}:\d{2}", text)
    issue = _iso_date(issue_match.group(1)) if issue_match else None
    if not issue or not _not_future(issue, ref_date):
        return None
    total = re.search(r"VALOR\s+TOTAL\s+DO\s+SERVI\S{1,3}O\s*=\s*R\$\s*(" + _MONEY_RE.pattern + ")",
                      text, re.IGNORECASE)
    amount = _money(total.group(1)) if total else None
    if amount is None:
        return None

    # Descricao so quando o texto veio integro (U+FFFD denunciaria acento corrompido).
    description = None
    found = re.search(r"DISCRIMINA\S{1,3}O\s+DE\s+SERVI\S{1,3}OS\s*\n(.+)", text, re.IGNORECASE)
    if found and "�" not in found.group(1):
        description = found.group(1).strip()[:200] or None
    tomador = re.search(r"TOMADOR\s+DE\s+SERVI\S{1,3}OS.*?CPF/CNPJ\s*:\s*(\S+)", text, re.IGNORECASE | re.DOTALL)
    payer = re.sub(r"\D", "", tomador.group(1)) if tomador else ""
    return {
        "invoice_number": number.group(1),
        "issue_date": issue,
        "amount": f"{amount:.2f}",
        "description": description,
        "payer_cnpj": payer if len(payer) == 14 else None,
    }
