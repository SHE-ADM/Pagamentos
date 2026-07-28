"""
extract_pdf.py — Extração de dados financeiros de PDFs para CSV
Projeto: pagamentos | Skill: pdf-contas-pagar | v1.0.0
"""

import os, re, sys, json, argparse, logging, unicodedata, tempfile
from datetime import datetime, timezone, date, timedelta
from pathlib import Path

import pdfplumber
import pypdf
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

# Anexos de IMAGEM lidos via Claude Vision (foto/scan de recibo, comprovante,
# "Valor do porte" dos Correios etc.). Mapeia a extensao ao media_type aceito pela
# Anthropic API (bloco type=image). PDF segue pelo bloco type=document.
_IMAGE_MEDIA_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp",
}


def _is_image_file(path) -> bool:
    """True se o arquivo for uma imagem suportada (pela extensao)."""
    return Path(path).suffix.lower() in _IMAGE_MEDIA_TYPES


# Modelo Claude usado tanto na extracao por texto quanto na visao.
CLAUDE_MODEL = "claude-sonnet-4-6"

# Timeout (segundos) por requisicao a Claude API. Sem timeout explicito o SDK
# usa ~10 min/request; num run sincrono que processa muitos PDFs, um request
# travado congela o pipeline inteiro — mesma falha ja resolvida no IMAP.
CLAUDE_API_TIMEOUT_SECONDS = int(os.getenv("CLAUDE_API_TIMEOUT", "90"))

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
    "container (frete/demurrage/movimentacao de conteineres) | "
    "multa (multa/penalidade/juros avulsos, auto de infracao) | outro\n"
    "  Tributos — use o subtipo especifico quando identificado. IMPORTANTE: para guias "
    "estaduais quase identicas (DARE, GARE, GNRE), copie EXATAMENTE o acronimo IMPRESSO "
    "no cabecalho/titulo do documento — NUNCA infira pelo estado nem troque um pelo outro:\n"
    "  DARF (Documento de Arrecadacao de Receitas Federais) | "
    "GPS (Guia da Previdencia Social) | "
    "DAS (Simples Nacional, SIMEI, Documento de Arrecadacao do Simples) | "
    "GRU (Guia de Recolhimento da Uniao) | "
    "DAE (Documento de Arrecadacao do eSocial) | "
    "DARE (Documento de Arrecadacao de Receitas Estaduais) | "
    "GNRE (Guia Nacional de Recolhimento de Tributos Estaduais) | "
    "IPVA (Guia de IPVA) | IPTU (Guia de IPTU) | "
    "DAM / DUAM (Documento de Arrecadacao Municipal) | "
    "ISS (Guia de ISS, Imposto Sobre Servicos) | "
    "ITBI (Guia de ITBI, Imposto de Transmissao de Bens Imoveis) | "
    "GARE (Guia de Arrecadacao de Receitas Estaduais) | "
    "tributo (qualquer outro documento de arrecadacao tributaria nao identificado acima)\n"
    "- supplier_name: nome do BENEFICIARIO/CEDENTE/FORNECEDOR (quem RECEBE). "
    "Preferencia: label 'fornecedor' > 'beneficiario final' > 'beneficiario' > 'cedente' > 'remetente'. "
    "NUNCA use o pagador/sacado.\n"
    "- supplier_cnpj: CNPJ do BENEFICIARIO (apenas digitos, 14 caracteres). "
    "Prefira identificar o CNPJ no formato mascarado com 18 caracteres (XX.XXX.XXX/XXXX-XX). "
    "Em boletos, procure o campo 'CNPJ Beneficiario', 'CNPJ/CPF' do beneficiario/cedente "
    "ou o campo 'Beneficiario Final' seguido de CNPJ/CPF (formato Banco Inter). "
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
    "- amount: Valor do Documento (numero decimal com ponto). Em recibo/comprovante "
    "de postagem (Correios), use o 'Valor do porte' / 'Valor total' do recibo.\n"
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
    "- payment_method: boleto|pix|ted|cartao|outro. IMPORTANTE: se o documento e um "
    "boleto/guia com codigo de barras ou linha digitavel E TAMBEM mostra um QR Code "
    "PIX ou 'PIX copia e cola', classifique como 'boleto' (nao 'pix') e extraia a "
    "linha digitavel no campo barcode. So use 'pix' quando NAO houver codigo de barras "
    "nem linha digitavel de boleto/arrecadacao.\n"
    "- competence_date: competencia no formato YYYY-MM, ou null\n"
    "- currency: moeda (BRL por padrao)\n"
    "- payer_name: nome do SACADO/PAGADOR (quem PAGA o documento). "
    "NUNCA use o beneficiario/cedente.\n"
    "- payer_cnpj: CNPJ do SACADO/PAGADOR (apenas digitos). NUNCA o do beneficiario.\n"
    "- description: texto das Instrucoes/observacoes do beneficiario\n"
    "REGRAS ESPECIFICAS PARA CT-e / DACTE (Conhecimento de Transporte Eletronico) — "
    "o documento tem varias partes, escolha corretamente:\n"
    "  - PRIORIDADE DO CEDENTE DO BOLETO: se o documento for uma FATURA/BOLETO de transporte "
    "(tem linha digitavel, campo 'Cedente', 'Beneficiario' ou 'Nosso Numero') que AGREGA um ou "
    "mais CT-e, o supplier_name/supplier_cnpj e o CEDENTE/BENEFICIARIO DO BOLETO — a "
    "transportadora que EMITE A FATURA e RECEBE o pagamento (ex: 'CAMPINENSE TRANSPORTE DE "
    "CARGAS LTDA') — NUNCA o EMITENTE do CT-e agregado (transportadora subcontratada que "
    "aparece no bloco 'IDENTIFICACAO DO EMITENTE'). A regra de EMITENTE abaixo vale SOMENTE "
    "para um DACTE/CT-e PURO, sem boleto/fatura de cobranca.\n"
    "  - supplier_name / supplier_cnpj (CT-e PURO, sem boleto): use o EMITENTE / TRANSPORTADORA "
    "(bloco 'IDENTIFICACAO DO EMITENTE' — a empresa de transporte que emite o CT-e e RECEBE o "
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
    _ns("dare"):            "DARE",
    _ns("gnre"):            "GNRE",
    _ns("ipva"):            "IPVA",
    _ns("iptu"):            "IPTU",
    _ns("dam"):             _DAM_DUAM,
    _ns("duam"):            _DAM_DUAM,
    _ns("dam / duam"):      _DAM_DUAM,
    _ns("iss"):             "ISS",
    _ns("itbi"):            "ITBI",
    _ns("gare"):            "GARE",
    # Multa / penalidade avulsa (auto de infracao, juros/multa isolados).
    _ns("multa"):           "multa",
    _ns("penalidade"):      "multa",
    # Cartorio — custas de tabelionato/registro/protesto. _ns() remove o acento na
    # CHAVE; o VALOR "cartório" (com acento) sobrevive ao .lower() de _normalize_doc_type
    # e casa o CHECK/enum.
    _ns("cartorio"):        "cartório",
    _ns("tabelionato"):     "cartório",
    # Cheque — o cheque como documento da conta (migration 086). Só normaliza o rótulo
    # EXPLICITO "cheque"; nao ha auto-classificacao pela palavra no corpo/assunto (evita
    # falso positivo com o payment_method 'cheque').
    _ns("cheque"):          "cheque",
    # Comprovante — comprovante/recibo como documento da conta (migration 087). Só normaliza
    # o rotulo EXPLICITO "comprovante"; nao ha auto-classificacao pela palavra no corpo/
    # assunto (evita conflito com subject_is_payment_confirmation, que ja IGNORA e-mail de
    # "comprovante de pagamento" antes de extrair).
    _ns("comprovante"):     "comprovante",
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

    # Padrao 4: linha digitavel QUEBRADA em linhas — o nome do banco ("ITAU 341-7") ou outro
    # ruido se intercala entre os 4 primeiros campos e o campo final de 14 digitos (fator+valor).
    # Ex. (carne HYOSUNG): "34191.09099 11249.463834 38053.630000 1" / "ITAU 341-7" / "10510000356008".
    # Captura SO as duas partes (grupos 1 e 2) e junta — o ruido do meio (com digitos) NAO entra.
    # re.DOTALL p/ cruzar linhas; janela curta + \b\d{14}\b pega o 1o bloco isolado de 14 digitos.
    m = re.search(
        r"(\d{5}[. ]\d{5}\s+\d{5}[. ]\d{6}\s+\d{5}[. ]\d{6}\s+\d)\b.{0,80}?\b(\d{14})\b",
        text, re.DOTALL)
    if m:
        return re.sub(r"\D", "", m.group(1) + m.group(2))

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


# Fator de vencimento FEBRABAN (posicoes 6-9 do codigo de barras de boleto). E a data de
# vencimento codificada pelo EMISSOR — DETERMINISTICA, imune a inversao dia/mes que o Vision/
# OCR pode cometer ao ler a data IMPRESSA (falha grave: id 435 gravou 07/08 no lugar de 08/07).
# Duas bases por causa do reset da NT FEBRABAN (o fator chegou a 9999 em 21/02/2025 e voltou a
# 1000 em 22/02/2025). As duas candidatas ficam ~24 anos distantes, entao a escolha (mais proxima
# da data de referencia = emissao/extracao) e inequivoca.
_FATOR_BASE_ZERO  = date(1997, 10, 7)   # fator = dias desde aqui (fator 1000 = 03/07/2000)
_FATOR_RESET_BASE = date(2025, 2, 22)   # reset: fator 1000 = 22/02/2025
_FATOR_MAX_DELTA_DAYS = 730             # candidata deve estar a <= 2 anos do ref (rejeita a base errada)


def _coerce_date(value) -> "date | None":
    """Converte 'YYYY-MM-DD' / ISO-datetime em `date`, ou None."""
    if not value:
        return None
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def due_date_from_barcode(barcode, ref_date=None) -> "str | None":
    """Vencimento ('YYYY-MM-DD') a partir do FATOR DE VENCIMENTO do boleto bancario FEBRABAN
    (44 digitos, moeda '9'), ou None. Fonte AUTORITATIVA e deterministica — nao sofre inversao
    dia/mes como a data impressa. Trata o reset FEBRABAN escolhendo, entre a base antiga e a
    nova, a candidata mais proxima de `ref_date` (emissao/extracao; default hoje). None quando:
    nao e boleto bancario, fator 0 (a vista/sem vencimento) ou nenhuma candidata plausivel
    (a mais de `_FATOR_MAX_DELTA_DAYS` do ref)."""
    if not barcode:
        return None
    d = re.sub(r"\D", "", str(barcode))
    if len(d) != 44 or d[3] != "9" or d[:3] == "000":
        return None  # nao e boleto bancario FEBRABAN (chave NF-e/CT-e ou arrecadacao de 48)
    try:
        fator = int(d[5:9])
    except ValueError:
        return None
    if fator == 0:
        return None  # boleto a vista / sem fator de vencimento
    ref = _coerce_date(ref_date) or datetime.now(timezone.utc).date()
    cands = [_FATOR_BASE_ZERO + timedelta(days=fator)]
    if fator >= 1000:
        cands.append(_FATOR_RESET_BASE + timedelta(days=fator - 1000))
    plausible = [c for c in cands if abs((c - ref).days) <= _FATOR_MAX_DELTA_DAYS]
    if not plausible:
        return None
    return min(plausible, key=lambda c: abs((c - ref).days)).isoformat()


def authoritative_barcode_due_date(barcode, amount, ref_date=None,
                                   issue_date=None) -> "str | None":
    """Vencimento derivado do FATOR do barcode, mas SO quando o barcode e CONFIAVEL. Dois gates:

    1. **VALOR:** o valor embutido no barcode (`amount_from_barcode`, posicoes 10-19) bate com o
       `amount` extraido (tolerancia 1 centavo). Barcode MAL LIDO pelo OCR (boleto ESCANEADO ->
       pdf_vision) tem valor divergente -> None (id 463 CIPATEX: OCR deu valor R$ 2mi e fator errado,
       sobrescrevendo o vencimento correto por 2025-11-08).
    2. **PLAUSIBILIDADE:** o vencimento do fator NAO pode ser ANTERIOR a `issue_date` — um boleto
       nunca vence antes de emitido. Cobre o boleto SECURITIZADO/renegociado cujo fator da linha
       digitavel ficou o ORIGINAL (stale) e diverge do vencimento IMPRESSO (id 473/474 HYOSUNG:
       fator 1051 -> 2025-04-14 < emissao 2026-05-26 -> rejeitado; a data impressa 2026-07-21 vence).

    Sem valor no barcode / sem `amount` -> None (nao ha como cross-validar). Guard universal e
    deterministico. Combina os gates com `due_date_from_barcode` — fonte unica do vencimento
    autoritativo por barcode."""
    bc_due = due_date_from_barcode(barcode, ref_date)
    if not bc_due:
        return None
    bc_val = amount_from_barcode(barcode)
    if bc_val is None or amount is None or amount == "":
        return None
    try:
        if abs(float(bc_val) - float(amount)) > 0.01:
            return None  # gate 1: barcode inconsistente com o valor -> mal lido, nao confiavel
    except (TypeError, ValueError):
        return None
    iss = _coerce_date(issue_date)
    bd = _coerce_date(bc_due)
    if iss is not None and bd is not None and bd < iss:
        return None  # gate 2: venc < emissao (impossivel) -> fator stale/errado, nao confiavel
    return bc_due


def apply_barcode_due_date(rec: dict) -> bool:
    """A data de vencimento AUTORITATIVA de um boleto e o fator de vencimento do codigo de
    barras (deterministico), NAO a data impressa — que o Vision/OCR pode inverter (dia/mes).
    Quando ha boleto FEBRABAN com fator valido E CONSISTENTE (valor do barcode == amount, ver
    `authoritative_barcode_due_date`), deriva o vencimento do barcode e SOBRESCREVE o due_date
    extraido se divergir. Barcode mal lido (valor divergente) NAO sobrescreve — preserva a data
    correta. Retorna True se corrigiu. Usa emissao/extracao como referencia para desambiguar o
    reset da base FEBRABAN. Idempotente (no-op se ja bate)."""
    bc_due = authoritative_barcode_due_date(
        rec.get("barcode"), rec.get("amount"),
        rec.get("issue_date") or rec.get("extracted_at"),
        issue_date=rec.get("issue_date"))
    if not bc_due:
        return False
    cur = str(rec.get("due_date") or "")[:10]
    if cur == bc_due:
        return False
    note = f"Vencimento corrigido pelo código de barras (fator FEBRABAN): {cur or '—'} → {bc_due}"
    rec["due_date"] = bc_due
    rec["processing_notes"] = (
        f'{rec["processing_notes"]} | {note}' if rec.get("processing_notes") else note
    )
    return True


# Vencimento IMPRESSO no texto do boleto: ancorado no rotulo "Vencimento" (ignora "Data do
# Documento"/"Data Movto"). Ate 80 chars sem digito/barra entre o rotulo e a data (o texto
# "PAGAVEL... APOS O" costuma se intercalar). DOTALL p/ cruzar linhas.
_TEXT_DUE_RE = re.compile(r"(?i)\bvencimento\b[^\d/]{0,80}?(\d{2}/\d{2}/\d{4})", re.DOTALL)


def extract_due_date_from_text(text) -> "str | None":
    """Vencimento IMPRESSO extraido DETERMINISTICAMENTE do texto do PDF (rotulo 'Vencimento').
    Prioriza a analise do PDF REAL sobre o LLM e o fator do barcode — a data impressa e a verdade
    do boleto (ex.: securitizado/renegociado com fator STALE, id 473/474 HYOSUNG). Retorna
    'YYYY-MM-DD' ou None. So faz sentido em PDF de TEXTO (no Vision o `raw` e o JSON, nao o boleto)."""
    if not text:
        return None
    m = _TEXT_DUE_RE.search(text)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%d/%m/%Y").date().isoformat()
    except ValueError:
        return None


def _due_date_plausible(due, issue) -> bool:
    """True se o vencimento nao e ANTERIOR a emissao (boleto nunca vence antes de emitido).
    Sem emissao -> True (nao ha como validar)."""
    d = _coerce_date(due)
    if d is None:
        return False
    i = _coerce_date(issue)
    return i is None or d >= i


def is_boleto_barcode(barcode) -> bool:
    """True quando o codigo e um BOLETO pagavel (nao chave NF-e/CT-e).

    Aceita 48 digitos (linha digitavel de arrecadacao — guia/tributo/concessionaria)
    ou 44 FEBRABAN (moeda '9', banco != '000'). Uma linha digitavel de 47 ja foi
    convertida para 44 FEBRABAN por normalize_barcode, entrando por este ramo.
    Uma chave de acesso NF-e/CT-e (44 digitos, moeda != '9') NAO casa — segue pix.
    """
    if not barcode:
        return False
    d = re.sub(r"\D", "", str(barcode))
    if len(d) == 48:
        return True
    return len(d) == 44 and d[3] == "9" and d[:3] != "000"


def apply_boleto_barcode_override(rec: dict) -> dict:
    """Boleto com PIX -> paga-se como boleto (regra de negocio: barcode vence pix).

    Quando ha codigo de barras / linha digitavel de BOLETO valido, o pagamento e
    boleto — mesmo que o documento tambem exiba um QR Code PIX / 'copia e cola'.
    O document_type so troca quando indefinido/pix; tipos fiscais reais
    (cte/nfe/darf/das/...) sao preservados. Idempotente.
    """
    if not is_boleto_barcode(rec.get("barcode")):
        return rec
    rec["payment_method"] = "boleto"
    if (rec.get("document_type") or "outro").lower() in ("pix", "outro", ""):
        rec["document_type"] = "boleto"
    return rec


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
        client = anthropic.Anthropic(api_key=api_key, timeout=CLAUDE_API_TIMEOUT_SECONDS)
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
    hints = {"boleto":["cedente","beneficiário final","beneficiário"],"nfe":["emitente","razão social"],
             "nfse":["prestador","razão social"],"fatura":["operadora","empresa"]}
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if any(k in line.lower() for k in hints.get(doc_type,[])):
            for j in range(i+1, min(i+4,len(lines))):
                c = lines[j].strip()
                if len(c) > 5:
                    return c[:120]
    return None

# --- Beneficiário Final vence Beneficiário/Cedente (boleto securitizado) ---
# Em boleto securitizado/factoring, o "Beneficiário"/"Cedente" é a securitizadora/empresa
# de cobrança e o "Beneficiário Final" é o credor REAL (o fornecedor que vendeu). O
# fornecedor da conta deve ser o BENEFICIÁRIO FINAL. Override DETERMINÍSTICO (imune à
# escolha do LLM). Caso de origem: ids 561/562 (MB COBRANCAS LTDA → INORGAN INDUSTRIA
# QUIMICA LTDA). Só atua quando o rótulo "Beneficiário Final" existe no texto do PDF.
_BENEF_FINAL_LABEL_RE = re.compile(r'(?i)benefici[aá]rio\s+final')
_CNPJ_ANY_RE = re.compile(r'\d{2}\.?\d{3}\.?\d{3}/\d{4}-?\d{2}')

def extract_beneficiario_final(text):
    """(nome, cnpj_digitos) do 'Beneficiário Final' do boleto, ou (None, None). O
    nome/CNPJ pode estar na MESMA linha do rótulo ou nas 1-2 linhas seguintes."""
    if not text:
        return (None, None)
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if "beneficiario final" not in _ns(line):
            continue
        m_lab = _BENEF_FINAL_LABEL_RE.search(line)
        after = line[m_lab.end():] if m_lab else ""
        window = " ".join(
            [after.strip()] + [lines[j].strip() for j in range(i + 1, min(i + 3, len(lines)))]
        ).strip()
        if not window:
            continue
        m = _CNPJ_ANY_RE.search(window)
        cnpj = re.sub(r"\D", "", m.group(0)) if m else None
        name_part = window[:m.start()] if m else window
        # Corta o rótulo 'CNPJ'/'CPF' e a pontuação da cauda do nome.
        name = re.split(r'(?i)\bcnpj\b|\bcpf\b', name_part)[0].strip(" ,.-:;/")
        if len(name) >= 4:
            return (name, cnpj if (cnpj and len(cnpj) == 14) else None)
    return (None, None)

def apply_beneficiario_final(rec, text):
    """Beneficiário Final SEMPRE vence Beneficiário/Cedente: sobrescreve o fornecedor
    extraído (nome + CNPJ) quando o boleto traz 'Beneficiário Final' COM CNPJ. Idempotente
    e best-effort (não deve derrubar a extração).

    EXIGE o CNPJ do beneficiário final (não regredir): "Beneficiário Final" também aparece
    como RÓTULO DE COLUNA no cabeçalho de muitos boletos (ex.: "Ag./Cód. Beneficiário Final")
    — nesses o texto ao lado é lixo/o próprio beneficiário, SEM CNPJ. Exigir CNPJ distingue a
    securitização REAL (INORGAN: nome + CNPJ juntos) do rótulo de coluna, evitando corromper o
    fornecedor (revelado pelo backfill: 2 casos reais com CNPJ vs 36 rótulos-de-coluna sem)."""
    try:
        name, cnpj = extract_beneficiario_final(text)
    except Exception:
        return
    if not cnpj:  # sem CNPJ do beneficiário final → é rótulo de coluna, não securitização
        return
    changed = False
    if cnpj != rec.get("supplier_cnpj"):
        rec["supplier_cnpj"] = cnpj
        rec["supplier_cpf"] = None  # há CNPJ do beneficiário final → não é pessoa física
        changed = True
    if name and name != rec.get("supplier_name"):
        rec["supplier_name"] = name
        changed = True
    if changed:
        note = "Fornecedor = Beneficiário Final do boleto (vence Beneficiário/Cedente)"
        rec["processing_notes"] = (
            f"{rec['processing_notes']} | {note}" if rec.get("processing_notes") else note
        )

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


# --- Página INTEIRA espelhada (≠ campo isolado em coluna RTL) ---
# Rótulos de boleto usados como sonda. Só palavras isoladas: no PDF espelhado cada
# LINHA vem invertida, então um termo de duas palavras cai em linhas separadas.
_MIRRORED_PROBE_TOKENS = ("vencimento", "beneficiario", "documento", "pagamento",
                          "valor", "banco", "cedente", "sacado", "parcela",
                          "carteira", "agencia", "juros", "multa")
_MIRRORED_MIN_LINES = 3


def is_mirrored_text(text: str) -> bool:
    """True quando o pdfplumber entrega a PÁGINA INTEIRA espelhada — cada linha com os
    caracteres em ordem invertida ("otnemicneV"=Vencimento, "49,331 $R"=R$ 133,94,
    "A/S ARUS SORUGES"=SEGUROS SURA S/A). Caso real: boleto das seguradoras (SURA).

    Diferente de fix_reversed_lines, que anota CAMPOS isolados (CNPJ/data/valor/nosso
    número) invertidos numa coluna RTL: aqui vêm ao contrário os rótulos, os nomes e a
    LINHA DIGITÁVEL — e esta fica ainda fragmentada entre colunas, logo irrecuperável
    por regex mesmo depois de inverter. Por isso o caller manda o PDF ao Vision, que lê a
    página RENDERIZADA (visualmente correta) e recupera a linha digitável.

    Heurística por LINHA, não por contagem global: conta as linhas em que um rótulo de
    boleto aparece SÓ na versão invertida. Num PDF normal essas linhas não existem (lá o
    rótulo está no texto direto), então o falso positivo é improvável; exige
    _MIRRORED_MIN_LINES linhas para não disparar por coincidência. Contar por linha
    também cobre o PDF MISTO — páginas normais + a do boleto espelhada (caso SURA) —,
    em que somar acertos do documento inteiro poderia empatar."""
    hits = 0
    for line in (text or "").splitlines():
        s = line.strip()
        if len(s) < 4:
            continue
        direct  = _ns(s)
        flipped = _ns(s[::-1])
        if any(t in flipped and t not in direct for t in _MIRRORED_PROBE_TOKENS):
            hits += 1
            if hits >= _MIRRORED_MIN_LINES:
                return True
    return False


# --- Extração via pdfplumber ---
def extract_with_pdfplumber(pdf_path):
    full_text = ""
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            full_text += (page.extract_text() or "") + "\n"
    return fix_reversed_lines(full_text.strip()), "pdf_text"

# --- Extração via Claude Vision ---
def _vision_source_block(path: Path):
    """Monta o bloco de conteudo Vision (base64) conforme o tipo do arquivo e
    devolve (bloco, extraction_source).

    - Imagem (jpg/png/...): bloco type=image + media_type da imagem → 'image_vision'.
    - PDF: bloco type=document + application/pdf → 'pdf_vision' (Claude renderiza).
    """
    import base64
    data = base64.standard_b64encode(path.read_bytes()).decode()
    suffix = path.suffix.lower()
    if suffix in _IMAGE_MEDIA_TYPES:
        block = {"type": "image", "source": {"type": "base64",
                 "media_type": _IMAGE_MEDIA_TYPES[suffix], "data": data}}
        return block, "image_vision"
    block = {"type": "document", "source": {"type": "base64",
             "media_type": "application/pdf", "data": data}}
    return block, "pdf_vision"


def extract_with_vision(pdf_path):
    """Extrai os campos lendo o documento diretamente pelo Claude (sem pdftoppm/poppler).

    PDF → enviado como documento base64 (Claude renderiza internamente — cobre
    PDFs escaneados/imagem e fontes OCR-B ilegíveis pelo pdfplumber). IMAGEM (foto/
    scan de recibo, ex.: "Valor do porte" dos Correios) → enviada como bloco de
    imagem. Não depende de binário externo. Retorna (texto, extraction_source).
    """
    import anthropic
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise EnvironmentError("ANTHROPIC_API_KEY não definida no .env")

    block, src = _vision_source_block(Path(pdf_path))
    client = anthropic.Anthropic(api_key=api_key, timeout=CLAUDE_API_TIMEOUT_SECONDS)
    resp = client.messages.create(
        model=CLAUDE_MODEL, max_tokens=1200, temperature=0,
        messages=[{"role":"user","content":[
            block,
            {"type":"text","text":EXTRACTION_PROMPT}
        ]}]
    )
    return resp.content[0].text.strip(), src


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

    client = anthropic.Anthropic(api_key=api_key, timeout=CLAUDE_API_TIMEOUT_SECONDS)
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


def _format_brl(value) -> str:
    """Formata um valor numerico como moeda BR: 10999.99 -> 'R$ 10.999,99'."""
    # f-string usa formato US ('10,999.99'); troca os separadores para o padrao BR.
    s = f"{float(value):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {s}"


def fallback_invoice_number(doc_type: str, due_date, amount=None, payment_method="") -> str:
    """invoice_number sintetico quando o documento nao traz N do Documento.

    Regra de negocio:
    - Pagamento PIX sem tipo claro (payment_method='pix' E document_type='outro'):
      forma de pagamento + '_' + valor em moeda BR. Ex.: 'pix_R$ 10.999,99'.
    - Demais tipos: tipo_documento + '_' + vencimento em DDMMYY.
      Ex.: 'tributo_030626', 'boleto_100726'.
    A deduplicacao de sufixos '(2)', '(3)'... e feita no momento da gravacao
    no banco (read_emails.py — SupabaseControl.unique_invoice_number).
    """
    pm = (payment_method or "").lower()
    if pm == "pix" and (doc_type or "").lower() == "outro" and amount is not None:
        return f"{pm}_{_format_brl(amount)}"
    return f"{doc_type}_{_due_date_ddmmyy(due_date)}"


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
    apply_boleto_barcode_override(rec)
    apply_barcode_due_date(rec)   # vencimento AUTORITATIVO = fator do barcode (corrige inversao dia/mes)
    ensure_due_date(rec, notes)
    # Emissao nao confiavel em guia de tributo: prefira nulo a uma data errada.
    if rec["document_type"] in TAX_DOC_TYPES and rec.get("issue_date"):
        rec["issue_date"] = None
        notes.append("Emissão ignorada (guia de tributo não tem data de emissão confiável)")
    if not has_document_number(rec["invoice_number"]):
        rec["invoice_number"] = fallback_invoice_number(
            rec["document_type"], rec["due_date"], rec.get("amount"), rec.get("payment_method"))
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
    apply_boleto_barcode_override(rec)
    apply_barcode_due_date(rec)   # vencimento AUTORITATIVO = fator do barcode (corrige inversao dia/mes)
    ensure_due_date(rec, notes)
    if not has_document_number(rec["invoice_number"]):
        rec["invoice_number"] = fallback_invoice_number(
            rec["document_type"], rec["due_date"], rec.get("amount"), rec.get("payment_method"))
        notes.append("N documento ausente — gerado de tipo+vencimento")
    rec["processing_notes"] = " | ".join(notes)
    return rec


# --- Montar registro (dispatcher) ---
def build_record(pdf_path, raw, source):
    if source in ("pdf_vision", "image_vision"):
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
    # Vencimento pelo fator do barcode recuperado aqui (regex/Vision) — idempotente com o
    # builder; cobre o caso do LLM ter perdido o barcode que o regex/Vision recuperou. Os gates
    # (valor + venc >= emissao) evitam sobrescrever com fator mal lido/stale.
    apply_barcode_due_date(rec)
    # PRIORIDADE MAXIMA (analise do PDF REAL): a data de vencimento IMPRESSA no texto do PDF, quando
    # presente e plausivel (>= emissao), VENCE o LLM e o fator do barcode — a data impressa e a
    # verdade do boleto (id 473/474 securitizado: fator stale de 2025 vs vencimento impresso de 2026).
    text_due = extract_due_date_from_text(raw)
    if text_due and _due_date_plausible(text_due, rec.get("issue_date")):
        rec["due_date"] = text_due
    # Boleto com PIX: barcode de boleto valido (recuperado aqui via regex/Vision)
    # define o pagamento como boleto, sobrepondo um payment_method='pix' do LLM.
    apply_boleto_barcode_override(rec)
    # Beneficiário Final vence Beneficiário/Cedente (boleto securitizado): override
    # determinístico do fornecedor a partir do TEXTO do PDF (imune à escolha do LLM).
    apply_beneficiario_final(rec, raw)
    return rec

# --- Falha genérica (registro de erro) ---
def _failure_record(pdf_path, note: str) -> dict:
    return {"source_file": pdf_path.name, "document_type": "ERRO",
            "extraction_source": "falha", "status": "falha",
            "processing_notes": note, "extracted_at": datetime.now(timezone.utc).isoformat(),
            **{c: None for c in CSV_COLUMNS if c not in
               ["source_file", "document_type", "extraction_source",
                "status", "processing_notes", "extracted_at"]}}


# --- Descriptografia de PDF protegido por senha ---
def _pdf_is_encrypted(pdf_path) -> bool:
    """True se o PDF exige senha para abrir. Em erro, assume não-cifrado (não bloqueia)."""
    try:
        return pypdf.PdfReader(str(pdf_path)).is_encrypted
    except Exception:
        return False


def _pdf_text_readable(pdf_path) -> bool:
    """True se o pdfplumber/pdfminer consegue LER texto do PDF sem senha. Cobre o caso
    comum de boleto cifrado só com senha de DONO (senha de USUARIO vazia + flags de
    restrição): o pypdf marca is_encrypted=True e reader.decrypt('') devolve 0 (nao
    decifra), mas o pdfminer abre o arquivo transparentemente. Sem esse fallback, o
    boleto legivel era descartado como 'protegido por senha' (caso SB Credito)."""
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            return any((page.extract_text() or "").strip() for page in pdf.pages[:2])
    except Exception:
        return False


def _decrypt_pdf(pdf_path, passwords) -> "Path | None":
    """Tenta abrir o PDF cifrado com cada senha candidata (senha vazia primeiro, depois
    as fornecidas — ex.: CNPJ[:4]/[:5]/[:6] do pagador). Em sucesso, grava uma cópia
    DESCRIPTOGRAFADA num arquivo temporário e devolve seu Path. Sem senha que abra →
    None (o PDF segue ilegível e o caller cai no fallback do corpo). Um PdfReader novo
    por tentativa evita estado residual de uma senha incorreta anterior."""
    for pw in ["", *(passwords or [])]:
        try:
            reader = pypdf.PdfReader(str(pdf_path))
            if reader.decrypt(pw):  # > 0 = senha aceita
                writer = pypdf.PdfWriter()
                for page in reader.pages:
                    writer.add_page(page)
                fd, tmp = tempfile.mkstemp(suffix=".pdf", prefix="dec_")
                with os.fdopen(fd, "wb") as fh:
                    writer.write(fh)
                log.info(f"  → PDF descriptografado (senha de {len(pw)} dígitos)" if pw
                         else "  → PDF aberto sem senha (só restrições de dono)")
                return Path(tmp)
        except Exception:
            continue
    return None


# --- Documento com VÁRIOS pagáveis (carnê de boletos, guias FGTS Digital, etc.) ---
# Regex de PIX Copia-e-Cola (payload EMV do BR Code). Âncoras fortes de PIX de COBRANÇA:
# o payload começa em "000201..." e a chave de cobrança do BC é "br.gov.bcb.pix". Não casam
# texto comum. (Comprovante de pagamento JÁ feito é barrado a montante por
# subject_is_payment_confirmation, então isto não vira conta espúria.)
def _has_pix_emv(text: str) -> bool:
    """True se o texto tem um PIX Copia-e-Cola (payload EMV / BR Code)."""
    norm = re.sub(r"\s+", "", text or "").lower()
    return "br.gov.bcb.pix" in norm or "00020101" in norm


# Linha digitável de ARRECADAÇÃO: 4 blocos de 11 dígitos + 1 DV cada (48 no total),
# ou o código de barras contínuo de 48. Ancorado no FORMATO (não num "44+ chars" ganancioso,
# que casaria uma tabela de valores/CPFs numa página de detalhamento).
_ARRECADACAO_LINE_RE = re.compile(
    r"\d{11}[-.\s]?\d[-.\s]+\d{11}[-.\s]?\d[-.\s]+\d{11}[-.\s]?\d[-.\s]+\d{11}[-.\s]?\d"
)
_BARCODE_48_RE = re.compile(r"(?<!\d)\d{48}(?!\d)")


def _text_has_arrecadacao_barcode(text: str) -> bool:
    """True se o texto tem uma linha digitável/código de ARRECADAÇÃO de 48 dígitos
    (tributo/guia/concessionária) — validado por is_boleto_barcode. extract_linha_digitavel
    só cobre o boleto FEBRABAN de 47; esta é a outra família de pagável impressa."""
    t = text or ""
    for m in _ARRECADACAO_LINE_RE.finditer(t):
        if is_boleto_barcode(re.sub(r"\D", "", m.group())):
            return True
    for m in _BARCODE_48_RE.finditer(t):
        if is_boleto_barcode(m.group()):
            return True
    return False


def _page_has_payable(text: str) -> bool:
    """True quando a página traz um INSTRUMENTO DE PAGAMENTO — a definição genérica de
    "página pagável", que distingue uma guia/boleto de uma página de detalhamento
    (relação de trabalhadores, instruções). Em ordem de confiabilidade:
      1) linha digitável de boleto (47 díg FEBRABAN — extract_linha_digitavel);
      2) linha/código de arrecadação (48 díg — tributo/guia/concessionária);
      3) PIX Copia-e-Cola (guias sem código de barras, ex.: FGTS Digital/GFD).
    Página de detalhamento NUNCA tem instrumento próprio → não conta (verificado no PDF
    real do FGTS: p.1-2 têm PIX, p.3-10 de relação de trabalhadores não têm nada)."""
    return (
        bool(extract_linha_digitavel(text))
        or _text_has_arrecadacao_barcode(text)
        or _has_pix_emv(text)
    )


def _payable_pages(pdf_path) -> "list[int]":
    """Índices 0-based das páginas que são um PAGÁVEL (têm instrumento de pagamento — ver
    _page_has_payable). Com ≥2, process_pdf divide o PDF e emite um registro por página
    (carnê de boletos, guia FGTS Mensal + Consignado, etc.). Rede de segurança: se uma
    página não-pagável escapar do critério, o registro dela sai sem `amount` e o pipeline
    a jusante o descarta (validação `sem_valor` em extract_and_store_accounts) — não vira
    conta espúria; o gate ≥2 preserva o contrato "1 pagável ⇒ 1 registro"."""
    pages = []
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            for i, p in enumerate(pdf.pages):
                if _page_has_payable(p.extract_text() or ""):
                    pages.append(i)
    except Exception:
        pass
    return pages


def _write_single_page(pdf_path, index) -> Path:
    """Grava a página `index` num PDF temporário de uma página (para extrair 1 boleto)."""
    reader = pypdf.PdfReader(str(pdf_path))
    writer = pypdf.PdfWriter()
    writer.add_page(reader.pages[index])
    fd, tmp = tempfile.mkstemp(suffix=".pdf", prefix=f"p{index + 1}_")
    with os.fdopen(fd, "wb") as fh:
        writer.write(fh)
    return Path(tmp)


# --- Processar um PDF (orquestrador) ---
def process_pdf(pdf_path, force_vision=False, pdf_passwords=None):
    """Processa um PDF → LISTA de registros (1+).

    - PDF protegido por senha: tenta as senhas candidatas (CNPJ[:4]/[:5]/[:6] do pagador,
      threaded pelo read_emails) e descriptografa; esgotadas as tentativas, devolve um
      registro de falha (o read_emails cai no fallback do corpo).
    - Carnê (vários boletos, N páginas com linha digitável): emite UM registro por
      boleto (o downstream já cria uma conta por linha do CSV).
    - Demais PDFs: um único registro.
    """
    # Anexo de IMAGEM (jpg/png/...): vai direto ao Claude Vision. Não passa por
    # pdfplumber/descriptografia/carnê (todos abrem o arquivo como PDF e quebrariam).
    if _is_image_file(pdf_path):
        rec = _extract_image(pdf_path)
        rec["source_file"] = pdf_path.name
        return [rec]

    tmps: list[Path] = []
    work = pdf_path
    try:
        if _pdf_is_encrypted(pdf_path):
            dec = _decrypt_pdf(pdf_path, pdf_passwords)
            if dec is not None:
                tmps.append(dec)
                work = dec
            elif _pdf_text_readable(pdf_path):
                # Cifrado apenas com senha de DONO (senha de usuario vazia): o pypdf
                # nao decifra, mas o pdfminer/pdfplumber le normalmente. Segue com o
                # ORIGINAL em vez de descartar como ilegivel (caso SB Credito).
                log.info(f"  → {pdf_path.name}: cifrado so com restricoes de dono — lido via pdfplumber")
                work = pdf_path
            else:
                log.warning(f"  ✗ {pdf_path.name}: protegido por senha — nenhuma senha candidata abriu")
                return [_failure_record(pdf_path, "PDF protegido por senha — nenhuma senha candidata (CNPJ) abriu")]

        payable_pages = _payable_pages(work)
        if len(payable_pages) >= 2:
            log.info(f"  → {len(payable_pages)} pagáveis no PDF — um registro por página")
            recs = []
            for idx in payable_pages:
                page_pdf = _write_single_page(work, idx)
                tmps.append(page_pdf)
                rec = _extract_single(page_pdf, force_vision=force_vision)
                rec["source_file"] = pdf_path.name  # preserva o nome do arquivo original
                recs.append(rec)
                if rec.get("extraction_source") == "erro_api":
                    break  # circuit breaker: não gasta chamadas nos demais pagáveis
            return recs

        rec = _extract_single(work, force_vision=force_vision)
        rec["source_file"] = pdf_path.name
        return [rec]
    finally:
        for t in tmps:
            try:
                t.unlink()
            except Exception:
                pass


# --- Extrair UM documento de um PDF (uma página/boleto) ---
def _extract_single(pdf_path, force_vision=False):
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
            elif is_mirrored_text(raw):
                # Página espelhada (texto invertido): o volume de texto passa longe do
                # limiar acima, mas o conteúdo é ilegível e a LINHA DIGITÁVEL não sai por
                # regex. O Vision lê a página renderizada, que é visualmente correta.
                log.info("  → Texto espelhado (página invertida) — fallback Vision")
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
            log.exception(f"  ✗ API Anthropic indisponível ({pdf_path.name}): {e}")
            return _api_error_record(pdf_path, str(e))
        log.exception(f"  ✗ {pdf_path.name}: {e}")
        return _failure_record(pdf_path, str(e))

# --- Extrair UM documento de uma IMAGEM (foto/scan de recibo) ---
def _extract_image(img_path):
    """Processa um anexo de imagem via Claude Vision → registro único.

    Mesma classificação de falha do caminho de PDF: erro de API (crédito/auth/
    rate-limit) vira registro erro_api (circuit breaker); demais falhas viram
    registro de falha (o read_emails cai no fallback do corpo).
    """
    log.info(f"Processando imagem: {img_path.name}")
    try:
        raw, src = extract_with_vision(img_path)
        return build_record(img_path, raw, src)
    except Exception as e:
        if _is_api_unavailable(e):
            log.exception(f"  ✗ API Anthropic indisponível ({img_path.name}): {e}")
            return _api_error_record(img_path, str(e))
        log.exception(f"  ✗ {img_path.name}: {e}")
        return _failure_record(img_path, str(e))


# --- Núcleo reutilizável (CLI + in-process) ---
def extract_to_csv(input_path, output_dir, *, batch=False, force_vision=False, pdf_passwords=None):
    """Extrai PDF(s) e grava o CSV de registros. Retorna o Path do CSV gerado
    (registros válidos / erro_api) ou None quando nada foi extraído (só falhas).

    É o núcleo reutilizável tanto por main() (CLI) quanto pelo pipeline in-process
    (read_emails.run_extraction). Chamar esta função diretamente — em vez de gerar
    `python extract_pdf.py` num subprocesso — torna a extração imune a falhas de
    criação de processo do Windows (0xC0000142 / STATUS_DLL_INIT_FAILED), que
    derrubavam 100% das extrações quando o spawn partia do processo do Flask.
    """
    inp = Path(input_path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    if batch or inp.is_dir():
        # Lote/diretório: PDFs + imagens suportadas (jpg/png/...).
        files = sorted(p for p in inp.glob("*")
                       if p.suffix.lower() == ".pdf" or _is_image_file(p))
    else:
        files = [inp]
    if not files:
        raise FileNotFoundError(f"Nenhum arquivo (PDF/imagem) em {inp}")

    log.info(f"Total: {len(files)} arquivo(s)")
    records, errors = [], []

    api_down = False
    for src_file in files:
        # process_pdf devolve uma LISTA (carnê → 1 registro por boleto; imagem/demais → 1).
        for rec in process_pdf(src_file, force_vision=force_vision, pdf_passwords=pdf_passwords):
            (errors if rec.get("extraction_source") == "falha" else records).append(rec)
            # Circuit breaker: API indisponivel interrompe o lote com seguranca —
            # evita gastar chamadas e gravar registros incompletos para os demais PDFs.
            if rec.get("extraction_source") == "erro_api":
                log.error("API Anthropic indisponível — lote interrompido com segurança. "
                          "Recarregue os créditos e rode novamente.")
                api_down = True
                break
        if api_down:
            break

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_path = None
    if records:
        df = pd.DataFrame(records, columns=CSV_COLUMNS)
        csv_path = out / f"{ts}_extracted.csv"
        df.to_csv(csv_path, index=False, encoding="utf-8-sig", sep=";")
        log.info(f"✓ {csv_path} ({len(records)} registros)")
    if errors:
        epath = out / f"{ts}_errors.log"
        epath.write_text("\n".join(f"{e['source_file']} | {e['processing_notes']}"
                                   for e in errors), encoding="utf-8")
        log.warning(f"⚠ {epath} ({len(errors)} erros)")

    return csv_path


# --- CLI ---
def main():
    parser = argparse.ArgumentParser(description="Extrai PDFs financeiros → CSV")
    parser.add_argument("--input",  required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--batch",  action="store_true")
    parser.add_argument("--force-vision", action="store_true")
    args = parser.parse_args()

    try:
        extract_to_csv(args.input, args.output,
                       batch=args.batch, force_vision=args.force_vision)
    except FileNotFoundError as e:
        log.exception(str(e)); sys.exit(1)

if __name__ == "__main__":
    main()
