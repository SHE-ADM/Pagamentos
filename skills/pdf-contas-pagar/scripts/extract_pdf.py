"""
extract_pdf.py — Extração de dados financeiros de PDFs para CSV
Projeto: pagamentos | Skill: pdf-contas-pagar | v1.0.0
"""

import os, re, sys, json, argparse, logging, unicodedata
from datetime import datetime, timezone
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


# Erros de nivel de API (credito esgotado, auth invalida, rate-limit, servidor,
# chave ausente) NAO sao falhas de um documento especifico: a API inteira esta
# indisponivel. Nesses casos o fallback regex grava dados incorretos (fornecedor
# vazio, valor errado) como se fosse sucesso. Sinalizamos esse erro a parte para
# o pipeline parar com seguranca (read_emails) em vez de poluir o banco.
class ApiUnavailableError(Exception):
    """API Anthropic indisponivel (credito/auth/rate-limit/servidor/sem chave)."""


_API_ERROR_HINTS = (
    "credit balance", "rate limit", "rate_limit", "authentication",
    "api key", "api_key", "anthropic_api_key", "overloaded", "quota",
    "permission", "billing", "insufficient",
)


def _is_api_unavailable(exc: Exception) -> bool:
    """True quando a excecao indica a API inteira indisponivel (nao um PDF ruim).

    Cobre: ApiUnavailableError ja classificado, qualquer anthropic.APIError
    (auth, credito, rate-limit, servidor) e heuristica por mensagem como rede
    de seguranca quando o tipo concreto nao for reconhecido.
    """
    if isinstance(exc, ApiUnavailableError):
        return True
    try:
        import anthropic
        if isinstance(exc, anthropic.APIError):
            return True
    except Exception:
        pass
    msg = str(exc).lower()
    return any(h in msg for h in _API_ERROR_HINTS)


def _api_error_record(pdf_path, message: str) -> dict:
    """Registro de falha de API — extraction_source='erro_api'.

    Esse marcador sinaliza ao read_emails para registrar um erro do tipo
    'erro_api' e NAO gravar conta a pagar (nem cair no fallback regex).
    """
    base = ["source_file", "document_type", "extraction_source",
            "status", "processing_notes", "extracted_at"]
    return {
        "source_file": pdf_path.name,
        "document_type": "ERRO_API",
        "extraction_source": "erro_api",
        "status": "falha",
        "processing_notes": f"ERRO_API: {message}"[:500],
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        **{c: None for c in CSV_COLUMNS if c not in base},
    }

# Schema unico de extracao (texto e visao usam o mesmo).
EXTRACTION_PROMPT = (
    "Analise este documento financeiro brasileiro (normalmente um boleto) e "
    "retorne APENAS um JSON valido, sem markdown e sem explicacoes, com "
    "EXATAMENTE estes campos:\n"
    "- document_type: identifique o tipo EXATO do documento. Use um dos valores abaixo.\n"
    "  Tipos gerais: boleto (cobrancas bancarias, carnes, faturas de servico avulso) | "
    "seguro (apolices, premios de seguro) | fechamento (extrato mensal, fatura de fechamento) | "
    "CT-e (Conhecimento de Transporte, DACTE) | NF-e (DANFE, Nota Fiscal Eletronica) | "
    "nfse (Nota Fiscal de Servicos Eletronica) | recibo | contrato | "
    "honorários (recibo/cobranca de honorarios advocaticios, contabeis ou profissionais) | "
    "container (frete/demurrage/movimentacao de conteineres) | outro\n"
    "  Tributos — use o subtipo especifico quando identificado:\n"
    "  DARF (Documento de Arrecadacao de Receitas Federais) | "
    "GPS (Guia da Previdencia Social) | "
    "DAS (Simples Nacional, SIMEI, Documento de Arrecadacao do Simples) | "
    "GRU (Guia de Recolhimento da Uniao) | "
    "DAE (Documento de Arrecadacao do eSocial ou DARE - Receitas Estaduais) | "
    "GNRE (Guia Nacional de Recolhimento de Tributos Estaduais) | "
    "IPVA (Guia de IPVA) | IPTU (Guia de IPTU) | "
    "DAM / DUAM (Documento de Arrecadacao Municipal) | "
    "ISS (Guia de ISS, Imposto Sobre Servicos) | "
    "ITBI (Guia de ITBI, Imposto de Transmissao de Bens Imoveis) | "
    "GARE (Guia de Arrecadacao de Receitas Estaduais) | "
    "tributo (qualquer outro documento de arrecadacao tributaria nao identificado acima)\n"
    "- supplier_name: nome do BENEFICIARIO/CEDENTE/FORNECEDOR (quem RECEBE). "
    "Preferencia: label 'fornecedor' > 'beneficiario' > 'cedente' > 'remetente'. "
    "NUNCA use o pagador/sacado.\n"
    "- supplier_cnpj: CNPJ do BENEFICIARIO (apenas digitos, 14 caracteres). "
    "Prefira identificar o CNPJ no formato mascarado com 18 caracteres (XX.XXX.XXX/XXXX-XX). "
    "Em boletos, procure o campo 'CNPJ Beneficiario' ou 'CNPJ/CPF' do beneficiario/cedente. "
    "O texto pode conter anotacoes '[RTL: XX.XXX.XXX/XXXX-XX]' que indicam o valor corrigido. "
    "Retorne null se nao houver. NUNCA use o CNPJ do pagador/sacado.\n"
    "- supplier_cpf: CPF do BENEFICIARIO (apenas digitos, 11 caracteres). "
    "Prefira o formato mascarado com 14 caracteres (XXX.XXX.XXX-XX). "
    "Somente quando beneficiario for pessoa fisica sem CNPJ. NUNCA o do pagador.\n"
    "- invoice_number: identificador principal do documento. "
    "Para boletos bancarios (boleto, seguro, fatura): use o 'Nosso Numero' — "
    "formato tipico: XXX/XXXXXXXX-D, ex: '109/26505819-5'. "
    "Para NF-e/NFS-e: numero da nota fiscal. "
    "Para outros: qualquer campo rotulado 'n documento', 'numero documento', "
    "'documento', 'fatura', 'numero da fatura', 'n fatura' ou 'n do documento'. "
    "NUNCA use um CNPJ (XX.XXX.XXX/XXXX-XX) como invoice_number. "
    "NUNCA retorne a Especie do Documento (siglas DM, DMI, DS, NP, RC, LC). "
    "Use null se ausente.\n"
    "- issue_date: data de emissao do documento. Labels: 'Data do Documento', "
    "'Data de Emissao', 'Emissao', 'Data Emissao'. Formato YYYY-MM-DD.\n"
    "- due_date: data de vencimento. Labels: 'Vencimento', 'Data de Vencimento', "
    "'Data Vencimento'. NAO confundir com 'Data do Documento' (issue_date) "
    "nem com 'Data do Processamento'. Formato YYYY-MM-DD.\n"
    "- amount: Valor do Documento (numero decimal com ponto)\n"
    "- discount: (-) Desconto / Abatimentos (decimal; 0 se em branco)\n"
    "- other_deductions: (-) Outras deducoes (decimal; 0 se em branco)\n"
    "- fine_interest: (+) Mora / Multa (decimal; 0 se em branco)\n"
    "- other_additions: (+) Outros acrescimos (decimal; 0 se em branco)\n"
    "- amount_charged: (=) Valor cobrado (decimal; 0 se em branco)\n"
    "- nosso_numero: Nosso Numero (texto)\n"
    "- barcode: linha digitavel de 47 digitos OU codigo de barras de 44 digitos. "
    "Em boletos bancarios, a linha digitavel aparece logo abaixo do codigo de barras "
    "impresso, no formato XXXXX.XXXXX XXXXX.XXXXXX XXXXX.XXXXXX X XXXXXXXXXXXXXX. "
    "Retorne apenas os digitos (sem pontos, espacos ou separadores). "
    "Retorne o valor mais completo visivel no documento. null se ausente.\n"
    "- payment_method: boleto|pix|ted|cartao|outro\n"
    "- competence_date: competencia no formato YYYY-MM, ou null\n"
    "- currency: moeda (BRL por padrao)\n"
    "- payer_name: nome do SACADO/PAGADOR (quem PAGA o documento). "
    "NUNCA use o beneficiario/cedente.\n"
    "- payer_cnpj: CNPJ do SACADO/PAGADOR (apenas digitos). NUNCA o do beneficiario.\n"
    "- description: texto das Instrucoes/observacoes do beneficiario\n"
    "REGRAS ESPECIFICAS PARA CT-e / DACTE (Conhecimento de Transporte Eletronico) — "
    "o documento tem varias partes, escolha corretamente:\n"
    "  - supplier_name / supplier_cnpj: use o EMITENTE / TRANSPORTADORA (bloco "
    "'IDENTIFICACAO DO EMITENTE' — a empresa de transporte que emite o CT-e e RECEBE o "
    "frete, ex: 'RODONAVES TRANSPORTES E ENCOMENDAS LTDA'). NUNCA use REMETENTE, "
    "DESTINATARIO nem TOMADOR DO SERVICO (esses sao quem PAGA o frete).\n"
    "  - amount: use o VALOR TOTAL DO SERVICO / VALOR DO FRETE / VALOR A RECEBER (custo do "
    "frete). NUNCA use o VALOR TOTAL DA MERCADORIA / VALOR DA CARGA (valor dos produtos).\n"
    "  - invoice_number: o NUMERO do CT-e (campo 'NUMERO', ex: 61304241), nunca a chave de "
    "acesso de 44 digitos.\n"
    "  - issue_date: 'DATA E HORA DE EMISSAO' do CT-e.\n"
    "  - due_date: CT-e normalmente NAO tem vencimento — retorne null.\n"
    "  - payer_name / payer_cnpj: o TOMADOR DO SERVICO ou o REMETENTE.\n"
    "Use null para campos de TEXTO ausentes e 0 para os campos de VALOR em branco."
)

_DAM_DUAM = "DAM / DUAM"
_HONORARIOS = "honorários"
_CONTAINER = "container"

KEYWORDS = {
    # CT-e antes de NF-e: ambos tem "chave de acesso", mas CT-e e mais especifico.
    "CT-e":       ["dacte","conhecimento de transporte","ct-e","cte-os","modal rodoviario"],
    # NF-e e NFS-e antes dos tributos: NFS-e inclui o termo "iss" como imposto associado.
    "NF-e":       ["danfe","nota fiscal eletrônica","nf-e","chave de acesso","emitente"],
    "NFSE":       ["nota fiscal de serviços","nfs-e","prestador","tomador"],
    # Tributos especificos — verificados antes do fallback generico 'TRIBUTO'.
    "DARF":       ["darf"],
    "GPS":        ["gps","guia da previdencia social","guia previdencia social"],
    "DAS":        ["das simples","das-simples","documento de arrecadacao do simples",
                   "simples nacional","simei"],
    "GRU":        ["gru","guia de recolhimento da uniao"],
    "DAE":        ["dae","documento de arrecadacao do esocial",
                   "dare","documento de arrecadacao de receitas estaduais"],
    "GNRE":       ["gnre","guia nacional de recolhimento"],
    "IPVA":       ["ipva","guia de ipva"],
    "IPTU":       ["iptu","guia de iptu"],
    _DAM_DUAM:    ["duam","documento de arrecadacao municipal"],
    "ISS":        ["guia de iss","guia iss","recolhimento de iss","iss a recolher"],
    "ITBI":       ["itbi","guia de itbi","imposto de transmissao"],
    "GARE":       ["gare"],
    # Tributo generico: fallback para guias de arrecadacao nao identificadas acima.
    "TRIBUTO":    ["guia de recolhimento","guia de pagamento","documento de arrecadacao"],
    "SEGURO":     ["apólice","apolice","seguradora","prêmio do seguro","premio do seguro",
                   "seguro de vida","seguro empresarial","seguro auto"],
    "FECHAMENTO": ["fechamento da fatura","extrato mensal","fatura do mês","fatura do mes",
                   "resumo da fatura","extrato de fechamento"],
    "FATURA":     ["conta do mês","total da fatura","vencimento da fatura"],
    "BOLETO":     ["cedente","beneficiário","linha digitável","nosso número","sacado"],
}

def _ns(s: str) -> str:
    """normalize_search equivalente em Python: remove acentos + lowercase."""
    return unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().strip().lower()

# Chaves normalizadas via _ns() para lookup case+accent insensitive.
_DOC_TYPE_NORM = {
    _ns("boleto"):     "boleto",
    _ns("ct-e"):       "cte",
    _ns("cte"):        "cte",
    _ns("nf-e"):       "nfe",
    _ns("nfe"):        "nfe",
    _ns("nfse"):       "nfse",
    _ns("tributo"):    "tributo",
    _ns("seguro"):     "seguro",
    _ns("recibo"):     "recibo",
    _ns("contrato"):   "contrato",
    _ns("fatura"):     "boleto",   # fatura de servico = boleto bancario
    _ns("fechamento"): "boleto",   # extrato de fechamento = boleto
    _ns("cobranca"):   "boleto",
    _ns("cobrança"):   "boleto",
    _ns("outros"):     "outro",
    _ns("outro"):      "outro",
    # Honorários (serviços profissionais — advocatícios/contábeis); pagamento PIX.
    _ns("honorario"):              _HONORARIOS,
    _ns("honorarios"):             _HONORARIOS,
    _ns("honorarios advocaticios"): _HONORARIOS,
    _ns("recibo de honorarios"):   _HONORARIOS,
    # Container (frete/demurrage/movimentação de contêineres).
    _ns("container"):  _CONTAINER,
    _ns("conteiner"):  _CONTAINER,
    _ns("contêiner"):  _CONTAINER,
    # Subtipos de tributo
    _ns("darf"):            "DARF",
    _ns("gps"):             "GPS",
    _ns("das"):             "DAS",
    _ns("simples nacional"): "DAS",
    _ns("simei"):           "DAS",
    _ns("gru"):             "GRU",
    _ns("dae"):             "DAE",
    _ns("dare"):            "DAE",
    _ns("gnre"):            "GNRE",
    _ns("ipva"):            "IPVA",
    _ns("iptu"):            "IPTU",
    _ns("dam"):             _DAM_DUAM,
    _ns("duam"):            _DAM_DUAM,
    _ns("dam / duam"):      _DAM_DUAM,
    _ns("iss"):             "ISS",
    _ns("itbi"):            "ITBI",
    _ns("gare"):            "GARE",
}

def _normalize_doc_type(raw: str) -> str:
    """Normaliza document_type para valores aceitos pelo CHECK constraint da tabela.

    Aplica _ns() tanto na chave (field) quanto no valor buscado (value) — case e accent insensitive.
    Sempre retorna minúsculo — CHECK constraint e frontend usam lower().
    """
    return _DOC_TYPE_NORM.get(_ns(raw or "outro"), "outro").lower()


# Guias de arrecadacao/tributo: nao tem "data de emissao" significativa — o que
# importa e a competencia (apuracao) e o vencimento. O issue_date extraido nessas
# guias costuma ser um campo errado (validade, periodo de apuracao); nulo e mais
# correto do que uma data incorreta, e ordena de forma previsivel em /consulta.
TAX_DOC_TYPES = {
    _normalize_doc_type(t) for t in (
        "tributo", "darf", "gps", "das", "gru", "dae", "dare", "gnre",
        "ipva", "iptu", "dam", "duam", "iss", "itbi", "gare", "simples nacional",
    )
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
            return round(float(m.group(1).replace(".","").replace(",",".")), 2)
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
    """Normaliza barcode / linha digitavel / chave de acesso para so digitos.

    Aceita os formatos de codigo de pagamento brasileiros (com ou sem mascara —
    pontos, espacos e hifens sao removidos):
    - 44 digitos: codigo de barras OU chave de acesso (NF-e/CT-e) — retorna como esta
    - 47 digitos: linha digitavel bancaria FEBRABAN -> converte para barcode 44
    - 48 digitos: linha digitavel de arrecadacao (concessionaria/tributo) -> mantem
    - Outros comprimentos ou None: retorna None
    """
    if not raw:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) == 44:
        return digits
    if len(digits) == 48:
        # Arrecadacao (agua/luz/tributo): 4 blocos de 11+1 DV. Mantida na forma
        # de linha digitavel — e um codigo de pagamento valido por si so.
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
    """Linha digitavel do boleto (47 digitos em 5 campos).

    Extracao deterministica a partir do texto do PDF: e mais confiavel que o
    LLM para sequencias longas de digitos (campo critico de pagamento).
    Tenta 3 padroes para tolerar variações de extração do pdfplumber:
      1. Formato canonico: XXXXX.XXXXX XXXXX.XXXXXX XXXXX.XXXXXX X XXXXXXXXXXXXXX
      2. Sem pontos nos campos: XXXXX XXXXX XXXXX XXXXXX XXXXX XXXXXX X XXXXXXXXXXXXXX
      3. Separadores mistos (espaco ou ponto dentro dos grupos)
    """
    # Padrao 1: formato canonico com pontos — mais comum em PDFs digitais
    m = re.search(
        r"\d{5}\.\d{5}\s+\d{5}\.\d{6}\s+\d{5}\.\d{6}\s+\d\s+\d{14}",
        text)
    if m:
        return re.sub(r"\D", "", m.group())

    # Padrao 2: sem pontos, apenas espacos entre os subcampos
    m = re.search(
        r"\d{5} \d{5}\s+\d{5} \d{6}\s+\d{5} \d{6}\s+\d\s+\d{14}",
        text)
    if m:
        return re.sub(r"\D", "", m.group())

    # Padrao 3: separador flexivel (ponto OU espaco simples) dentro dos campos
    m = re.search(
        r"\d{5}[. ]\d{5}\s+\d{5}[. ]\d{6}\s+\d{5}[. ]\d{6}\s+\d\s+\d{14}",
        text)
    if m:
        return re.sub(r"\D", "", m.group())

    return None


def amount_from_barcode(barcode):
    """Valor (R$) a partir do codigo de barras bancario FEBRABAN de 44 digitos.

    Layout do codigo de barras de boleto bancario:
        banco(3) moeda(1) DV(1) fator_vencimento(4) valor(10) campo_livre(25)
    O valor ocupa as posicoes 10-19 (indices 9-18), em centavos. Deterministico
    e confiavel — recupera boletos cujo PDF nao expoe 'R$' legivel (fonte OCR-B,
    imagem), causa comum de 'sem_valor'.

    Restringe a boletos bancarios (moeda '9') para nao confundir com:
      - chave de acesso de NF-e/CT-e (44 digitos, sem campo de valor);
      - linha digitavel de arrecadacao (48 digitos, outro layout).
    Sanity-bound descarta lixo de uma eventual chave que passe no filtro de moeda.
    """
    if not barcode:
        return None
    d = re.sub(r"\D", "", str(barcode))
    if len(d) != 44 or d[3] != "9" or d[:3] == "000":
        return None  # nao e boleto bancario FEBRABAN
    try:
        valor = int(d[9:19]) / 100.0
    except ValueError:
        return None
    # Faixa plausivel: descarta valor zero e numeros absurdos (provavel chave NF-e).
    return valor if 0 < valor < 5_000_000 else None


# Prompt mínimo usado apenas para recuperar o barcode via Vision.
# Aceita qualquer código de pagamento (linha digitável, código de barras ou
# chave de acesso) — útil quando o texto vem ilegível ou impresso na vertical.
_BARCODE_ONLY_PROMPT = (
    "Este documento brasileiro contém um código de pagamento. "
    "Encontre UM destes (nesta ordem de preferência): "
    "(1) linha digitável bancária — 47 dígitos no formato "
    "XXXXX.XXXXX XXXXX.XXXXXX XXXXX.XXXXXX X XXXXXXXXXXXXXX; "
    "(2) linha digitável de arrecadação (água/luz/tributo) — 48 dígitos em 4 blocos; "
    "(3) código de barras — 44 dígitos; "
    "(4) chave de acesso de NF-e/CT-e — 44 dígitos. "
    "Pode estar impresso na horizontal OU na vertical, ao lado do código de barras. "
    "Retorne SOMENTE os dígitos, sem pontos, espaços ou outros caracteres. "
    "Se não encontrar nenhum, retorne null."
)


def _try_barcode_vision(pdf_path: Path) -> str | None:
    """Extrai linha digitável via Claude PDF API quando pdf_text não a encontra.

    Envia o PDF diretamente para o Claude (sem pdftoppm/poppler).
    Claude renderiza internamente e lê fontes OCR-B ilegíveis pelo pdfplumber.
    Retorna 47 ou 44 dígitos, ou None se não encontrada.
    """
    import base64, anthropic
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    try:
        pdf_b64 = base64.standard_b64encode(pdf_path.read_bytes()).decode()
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=CLAUDE_MODEL, max_tokens=100, temperature=0,
            messages=[{"role": "user", "content": [
                {"type": "document",
                 "source": {"type": "base64",
                            "media_type": "application/pdf",
                            "data": pdf_b64}},
                {"type": "text", "text": _BARCODE_ONLY_PROMPT},
            ]}],
        )
        raw_resp = resp.content[0].text.strip().lower()
        if raw_resp in ("null", "", "none"):
            return None
        # Extrai a primeira sequência isolada de 47 (linha digitável bancária),
        # 48 (arrecadação) ou 44 dígitos (código de barras / chave de acesso).
        # Evita concatenar múltiplas ocorrências caso o modelo seja verboso.
        digits = re.sub(r"[ .\-]", "", raw_resp)
        for n in (47, 48, 44):
            m = re.search(rf"(?<!\d)(\d{{{n}}})(?!\d)", digits)
            if m:
                return m.group(1)
        return None
    except Exception as e:
        log.warning(f"  Vision barcode fallback: {e}")
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
    if "cartão" in t or "cartao" in t: return "cartão"
    return "outro"

# --- Verificar se PDF é scan ---
def is_scanned_pdf(pdf_path):
    """Heurística sem dependência externa: PDF com pouco/nenhum texto extraível
    é provavelmente escaneado (imagem). Usa pdfplumber (já requerido) em vez de
    pdffonts/poppler. Em qualquer erro, assume digital (não bloqueia o fluxo)."""
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            text = "".join((p.extract_text() or "") for p in pdf.pages[:2])
        return len(text.strip()) < 80
    except Exception:
        return False

# --- Pré-processamento: corrige linhas invertidas (boletos RTL) ---
_REV_CNPJ_RE   = re.compile(r'^\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}')
_REV_CPF_RE    = re.compile(r'^\d{3}\.\d{3}\.\d{3}-\d{2}$')
_REV_DATE_RE   = re.compile(r'^\d{2}/\d{2}/(\d{4})$')
_REV_AMOUNT_RE = re.compile(r'^R\$\s[\d.,]+$')
# Valor monetário sem R$: ex. "133,94" (2 casas decimais exatas)
_REV_VALUE_RE  = re.compile(r'^\d{1,8},\d{2}$')
_REV_NN_RE     = re.compile(r'^\d{2,4}/\d{5,}-?\d?$')   # Nosso Número: XXX/XXXXXXXXX-D

def fix_reversed_lines(text: str) -> str:
    """Alguns boletos (ex: Itaú) têm a coluna de campos extraída pelo pdfplumber
    em ordem invertida (RTL). Esta função detecta padrões conhecidos e os adiciona
    ao texto com a label [RTL:] para que Claude os identifique corretamente.
    Os valores não reconhecidos como padrão são mantidos sem alteração.
    """
    out = []
    for line in text.splitlines():
        out.append(line)
        s = line.strip()
        if len(s) < 4:
            continue
        rev = s[::-1]
        m_date = _REV_DATE_RE.match(rev)
        is_reversed = (
            _REV_CNPJ_RE.match(rev)
            or _REV_CPF_RE.match(rev)
            or (m_date and int(m_date.group(1)) >= 1990)
            or _REV_AMOUNT_RE.match(rev)
            or _REV_VALUE_RE.match(rev)
            or _REV_NN_RE.match(rev)
        )
        if is_reversed:
            out.append(f"[RTL: {rev}]")
    return "\n".join(out)


# --- Extração via pdfplumber ---
def extract_with_pdfplumber(pdf_path):
    full_text = ""
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            full_text += (page.extract_text() or "") + "\n"
    return fix_reversed_lines(full_text.strip()), "pdf_text"

# --- Extração via Claude Vision ---
def extract_with_vision(pdf_path):
    """Extrai os campos lendo o PDF diretamente pelo Claude (sem pdftoppm/poppler).

    Envia o PDF como documento base64; o Claude renderiza internamente — cobre
    PDFs escaneados/imagem e fontes OCR-B ilegíveis pelo pdfplumber, sem depender
    de binário externo (poppler) instalado no sistema. Mesmo mecanismo já usado
    em _try_barcode_vision.
    """
    import base64, anthropic
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise EnvironmentError("ANTHROPIC_API_KEY não definida no .env")

    pdf_b64 = base64.standard_b64encode(pdf_path.read_bytes()).decode()
    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=CLAUDE_MODEL, max_tokens=1200, temperature=0,
        messages=[{"role":"user","content":[
            {"type":"document","source":{"type":"base64",
             "media_type":"application/pdf","data":pdf_b64}},
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


def apply_barcode_amount(rec: dict) -> bool:
    """Tier 1 do resgate de valor: deriva amount do codigo de barras.

    So age quando amount esta ausente/zero E ha um boleto bancario FEBRABAN.
    Recalcula amount_charged e anota a origem. Retorna True se preencheu o valor.
    """
    if rec.get("amount"):
        return False
    bc_amount = amount_from_barcode(rec.get("barcode"))
    if not bc_amount:
        return False
    rec["amount"] = bc_amount
    rec["amount_charged"] = resolve_amount_charged(rec)
    note = "Valor derivado do código de barras FEBRABAN (texto sem valor)"
    rec["processing_notes"] = (
        f'{rec["processing_notes"]} | {note}' if rec.get("processing_notes") else note
    )
    return True


def _due_date_ddmmyy(due_date) -> str:
    """Converte vencimento 'YYYY-MM-DD' em 'DDMMYY' (ano com 2 digitos).

    Sem vencimento (ou data invalida), usa a data de extracao (hoje).
    """
    if due_date:
        try:
            return datetime.strptime(str(due_date)[:10], "%Y-%m-%d").strftime("%d%m%y")
        except ValueError:
            pass
    return datetime.now().strftime("%d%m%y")


def fallback_invoice_number(doc_type: str, due_date) -> str:
    """invoice_number sintetico quando o documento nao traz N do Documento.

    Regra de negocio: tipo_documento + '_' + vencimento em DDMMYY.
    Ex.: 'tributo_030626', 'boleto_100726'.
    A deduplicacao de sufixos '(2)', '(3)'... e feita no momento da gravacao
    no banco (read_emails.py — SupabaseControl.unique_invoice_number).
    """
    return f"{doc_type}_{_due_date_ddmmyy(due_date)}"


# Tipos de documento ja identificados (estrutura fiscal propria) que NUNCA
# devem virar 'pix' so porque o pagamento e por pix. Um CT-e/NF-e/boleto pago
# via pix continua sendo CT-e/NF-e/boleto — o override so vale para 'outro'.
def apply_pix_override(rec: dict) -> dict:
    """Sobrescreve document_type para 'pix' apenas quando o tipo for indefinido.

    O override existe para pedidos de pagamento avulsos sem tipo claro. Aplicar
    sobre um documento ja classificado (boleto, CT-e, NF-e, tributo...) apagava
    o tipo real — ex.: um DACTE de transportadora virava 'pix' so porque o texto
    mencionava pix. So sobrescreve quando document_type e 'outro'/vazio.
    """
    if (rec.get("payment_method") or "").lower() != "pix":
        return rec
    if (rec.get("document_type") or "outro").lower() == "outro":
        rec["document_type"] = "pix"
    return rec


def has_document_number(value) -> bool:
    """True se ha um N do Documento utilizavel.

    Considera AUSENTE: vazio, ou valores sem nenhum digito — caso tipico do
    modelo capturar a Especie do Documento (DM, DS, NP) ou 'S/N' no lugar do
    numero. Um numero de documento valido sempre contem ao menos um digito.
    """
    s = (value or "").strip()
    return bool(s) and any(c.isdigit() for c in s)


def ensure_due_date(rec: dict, notes: list) -> None:
    """Regra de negocio: vencimento ausente -> usa a data da extracao (hoje).

    Alguns documentos (ex.: CT-e/DACTE) chegam sem 'Vencimento'. Sem isso a conta
    fica sem data de pagamento. Preenche in-place com a data local do dia e
    registra a nota de auditoria.
    """
    if not rec.get("due_date"):
        rec["due_date"] = datetime.now().strftime("%Y-%m-%d")
        notes.append("Vencimento ausente — usando data da extração")


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
        "status": "pendente",
        "nosso_numero": data.get("nosso_numero"),
        "payer_name": data.get("payer_name"),
        "payer_cnpj": re.sub(r"\D", "", str(data.get("payer_cnpj") or "")) or None,
        "processing_notes": None,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
    }
    for vf in VALUE_FIELDS_ZERO:
        rec[vf] = _to_decimal(data.get(vf), 0)
    rec["amount_charged"] = resolve_amount_charged(rec)
    if cnpj and len(cnpj) != 14:
        notes.append("CNPJ do beneficiario invalido")
    apply_pix_override(rec)
    ensure_due_date(rec, notes)
    # Emissao nao confiavel em guia de tributo: prefira nulo a uma data errada.
    if rec["document_type"] in TAX_DOC_TYPES and rec.get("issue_date"):
        rec["issue_date"] = None
        notes.append("Emissão ignorada (guia de tributo não tem data de emissão confiável)")
    if not has_document_number(rec["invoice_number"]):
        rec["invoice_number"] = fallback_invoice_number(rec["document_type"], rec["due_date"])
        notes.append("N documento ausente — gerado de tipo+vencimento")
    rec["processing_notes"] = " | ".join(notes) if notes else None
    return rec


# --- Montar registro por regex (fallback quando Claude indisponivel) ---
def build_record_regex(pdf_path, raw: str, source: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
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
        "status": "pendente", "nosso_numero": None,
        "supplier_cpf": None,
        "payer_name": None, "payer_cnpj": None,
        "processing_notes": None, "extracted_at": now,
    }
    for vf in VALUE_FIELDS_ZERO:
        rec[vf] = 0
    rec["amount_charged"] = resolve_amount_charged(rec)
    if len(raw) < 80:
        notes.append("Texto insuficiente — considerar Vision")
    apply_pix_override(rec)
    ensure_due_date(rec, notes)
    if not has_document_number(rec["invoice_number"]):
        rec["invoice_number"] = fallback_invoice_number(rec["document_type"], rec["due_date"])
        notes.append("N documento ausente — gerado de tipo+vencimento")
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
        rec = build_record_from_json(pdf_path, data, source)
        apply_barcode_amount(rec)  # tier 1: valor via codigo de barras
        return rec

    # pdf_text: tenta Claude e cai para regex APENAS em falhas de documento.
    # Erro de API (credito/auth/rate-limit) propaga como ApiUnavailableError —
    # o fallback regex gravaria fornecedor vazio e valor errado como sucesso.
    try:
        data = extract_fields_with_claude(raw)
        rec = build_record_from_json(pdf_path, data, source)
    except Exception as e:
        if _is_api_unavailable(e):
            raise ApiUnavailableError(str(e)) from e
        log.warning(f"  Extração via Claude (texto) falhou ({e}) — fallback regex")
        rec = build_record_regex(pdf_path, raw, source)

    # Barcode: regex deterministica tem prioridade sobre o LLM.
    # Se nao encontrar no texto (ex: fonte OCR-B ilegivel), tenta Vision.
    # Se nenhum metodo deterministico funcionar, preserva o que Claude extraiu.
    ld = extract_linha_digitavel(raw)
    if ld is None:
        log.info("  → linha digitável não encontrada no texto — tentando Vision barcode")
        ld = _try_barcode_vision(pdf_path)
        if ld:
            log.info(f"  → barcode recuperado via Vision ({len(ld)} dígitos)")
    if ld is not None:
        rec["barcode"] = normalize_barcode(ld)
    # Tier 1: valor ausente no texto mas presente no codigo de barras bancario.
    apply_barcode_amount(rec)
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
                # Vision envia o PDF em base64 ao Claude (sem poppler/pdftoppm).
                raw, src = extract_with_vision(pdf_path)
        rec = build_record(pdf_path, raw, src)
        # Tier 2: texto extraiu o documento mas sem valor, e o codigo de barras
        # nao resolveu (sem barcode bancario). Tenta Vision para ler o valor
        # visualmente. Erro de API propaga; outras falhas mantem o rec de texto.
        if not rec.get("amount") and src == "pdf_text":
            log.info("  → valor ausente após texto/barcode — fallback Vision para valor")
            try:
                vraw, vsrc = extract_with_vision(pdf_path)
                vrec = build_record(pdf_path, vraw, vsrc)
                if vrec.get("amount"):
                    log.info(f"  → valor recuperado via Vision: {vrec.get('amount')}")
                    return vrec
            except Exception as ve:
                if _is_api_unavailable(ve):
                    raise
                log.warning(f"  → Vision para valor falhou ({ve}) — mantendo extração de texto")
        return rec
    except Exception as e:
        # Erro de API (credito/auth/rate-limit) — falha dura, sem regex.
        if _is_api_unavailable(e):
            log.error(f"  ✗ API Anthropic indisponível ({pdf_path.name}): {e}")
            return _api_error_record(pdf_path, str(e))
        log.error(f"  ✗ {pdf_path.name}: {e}")
        return {"source_file": pdf_path.name, "document_type": "ERRO",
                "extraction_source": "falha", "status": "falha",
                "processing_notes": str(e), "extracted_at": datetime.now(timezone.utc).isoformat(),
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
        (errors if rec.get("extraction_source") == "falha" else records).append(rec)
        # Circuit breaker: API indisponivel interrompe o lote com seguranca —
        # evita gastar chamadas e gravar registros incompletos para os demais PDFs.
        if rec.get("extraction_source") == "erro_api":
            log.error("API Anthropic indisponível — lote interrompido com segurança. "
                      "Recarregue os créditos e rode novamente.")
            break

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
