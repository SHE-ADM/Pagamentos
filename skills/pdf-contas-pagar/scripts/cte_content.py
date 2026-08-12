"""Conteudo do CT-e (peso, rota, NF vinculada, frete) — Onda 5, item 5.3.

Modulo SEM DEPENDENCIAS (so stdlib), pelo mesmo motivo do `fiscal_key.py` e do `febraban.py`:
quem so precisa interpretar texto ja extraido nao deve arrastar pdfplumber/pandas junto.

POR QUE SO A FATURA BRASPRESS, E NAO O DACTE (escopo deliberado)
    Medido em 2026-08-12 lendo os 144 PDFs fiscais do bucket: o conteudo de transporte vive em
    dois lugares, com custos muito diferentes.

      - **Fatura agregada BRASPRESS** (10 PDFs, 55 CT-e): tabela REGULAR, um emissor, um layout.
        Sai por regex, com custo zero de LLM e resultado verificavel.
      - **DACTE individual** (83 PDFs, 123 docs): o layout varia por emissor (Rodonaves, Oksman,
        STC, RTE…) — os rotulos que existem em um faltam no outro. Medido: "PESO" aparece em
        80/83, mas "VALOR TOTAL DA PRESTACAO" em apenas 5/83. Regex ali seria um parser por
        emissor, que quebra a cada transportadora nova; e o caminho honesto e LLM (item 5.3-b,
        nao implementado).

    Comecar pelo barato e verificavel foi a recomendacao registrada no roadmap.

O ORACULO QUE TORNA ISTO CONFIAVEL (e por que ele e FAIL-CLOSED)
    A propria fatura imprime um SUB-TOTAL de peso e frete. `parse_braspress_invoice` soma o que
    extraiu e compara: **se nao fechar, devolve NADA daquele PDF** em vez de devolver as linhas
    que casaram.

    O motivo e a natureza do dado: estes numeros sao um RATEIO da fatura por conhecimento. Um
    rateio a que faltam linhas nao e "quase certo" — ele atribui ao conjunto errado, e a soma
    passa a discordar da conta a pagar correspondente sem que nada acuse. Dado ausente e uma
    pergunta sem resposta; rateio incompleto e uma resposta errada com aparencia de certa.

🔴 O VALOR DO FRETE AQUI E DECOMPOSICAO, NUNCA UMA SEGUNDA DESPESA
    A fatura inteira ja esta em `financial_account_control` como conta a pagar (ela vem com
    boleto). O frete por CT-e e a MESMA quantia vista por outro eixo — rota, destinatario, nota
    fiscal. Somar `freight_amount` com `gasto_por_*` conta o mesmo dinheiro duas vezes.

    Na Onda 3 essa barreira era ESTRUTURAL (a tabela nao tinha coluna de valor). Aqui ela passa
    a ser DECLARADA — no dicionario do chat e na descricao da tool — e por isso ganhou guarda
    de teste propria: `regression.test.ts` reprova se a tool expuser campo de valor sem que o
    SYSTEM_PROMPT carregue a advertencia de nao somar.
"""

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

# Linha de conhecimento da fatura BRASPRESS. Exemplo real (fatura 2607128724):
#
#   005709378 CCT RIO 14/07/2026 96,00 248632 24.156,61 652,60 HANDRED STUDIO COMERCIO LTDA
#   Chave CTe 35260748740351011442570000057093781966739743
#
# Colunas: AWB | percurso ORIGEM | DESTINO | data | peso | nota fiscal | vlr. mercadoria |
#          vlr. frete | destinatario
#
# A nota fiscal e o unico campo NAO numerico do meio: vem o numero da NF ou o literal "DIVER."
# (varias notas no mesmo conhecimento) — por isso `\S+` e nao `\d+`. Tratar "DIVER." como
# numero produziria uma NF vinculada inventada.
_LINHA_RE = re.compile(
    r"^(?P<awb>\d{6,12})\s+"
    r"(?P<origin>[A-Z0-9]{2,4})\s+(?P<destination>[A-Z0-9]{2,4})\s+"
    r"(?P<service_date>\d{2}/\d{2}/\d{4})\s+"
    r"(?P<weight>[\d.]+,\d{2})\s+"
    r"(?P<invoice>\S+)\s+"
    r"(?P<cargo>[\d.]+,\d{2})\s+"
    r"(?P<freight>[\d.]+,\d{2})\s+"
    r"(?P<receiver>.+?)\s*$"
)

# A chave vem na linha SEGUINTE ("Chave CTe <44 digitos>"). Casar "a proxima chave do documento"
# em vez da linha seguinte deixaria uma linha sem chave herdar a chave da linha de baixo — o
# rateio inteiro se desloca de um, e todo registro fica atribuido ao CT-e errado.
_CHAVE_RE = re.compile(r"(?:CHAVE\s*CTE\s*)?(\d{44})", re.IGNORECASE)

# SUB-TOTAL 107,28 26.968,21 935,17   → peso, mercadoria, frete
_SUBTOTAL_RE = re.compile(
    r"SUB-?TOTAL\s+(?P<weight>[\d.]+,\d{2})\s+(?P<cargo>[\d.]+,\d{2})\s+"
    r"(?P<freight>[\d.]+,\d{2})", re.IGNORECASE)

# Marcador do emissor. Sem ele o parser rodaria sobre qualquer PDF e o regex generico
# ("numero, sigla, sigla, data, valores") casaria linha de outra tabela por acaso.
#
# O `S{1,2}` nao e frouxidao: a transportadora grafa o proprio nome das DUAS formas no MESMO
# documento — "BRASPRES TRANSPORTES URGENTES LTDA" na razao social impressa e "braspress.com.br"
# no rodape. Exigir a grafia com dois S faria a deteccao depender de qual trecho do cabecalho
# o pdfplumber conseguiu extrair naquele arquivo.
_BRASPRESS_RE = re.compile(r"BRASPRES{1,2}\b", re.IGNORECASE)

# Tolerancia do oraculo: centavos de arredondamento do proprio emissor. Nao e folga para
# linha faltando — uma linha vale dezenas ou centenas de reais.
TOTAL_TOLERANCE = Decimal("0.02")

# Valor sentinela da nota fiscal quando o conhecimento cobre varias notas.
DIVERSAS = "DIVER."


def _to_decimal(texto: str) -> "Decimal | None":
    """'1.920,00' -> Decimal('1920.00'). None quando nao e numero no formato BR."""
    try:
        return Decimal(texto.replace(".", "").replace(",", "."))
    except (InvalidOperation, AttributeError):
        return None


def _to_date(texto: str) -> "date | None":
    try:
        return datetime.strptime(texto, "%d/%m/%Y").date()
    except (ValueError, TypeError):
        return None


def is_braspress_invoice(text: str) -> bool:
    """O texto e uma fatura agregada da BRASPRESS? Barato: decide antes de varrer linha a linha."""
    return bool(text) and bool(_BRASPRESS_RE.search(text)) and bool(_SUBTOTAL_RE.search(text))


def parse_braspress_invoice(text: str) -> "list[dict]":
    """Conhecimentos da fatura, ou lista VAZIA se o oraculo do SUB-TOTAL nao fechar.

    Cada item traz `access_key` (a chave do CT-e, que casa 1:1 com `fiscal_document`) e os
    campos de conteudo. Devolve lista vazia — em vez de levantar — porque "este PDF nao e uma
    fatura BRASPRESS" e o resultado esperado na maioria dos objetos do bucket.
    """
    if not is_braspress_invoice(text):
        return []

    linhas = text.splitlines()
    itens: list[dict] = []
    for i, linha in enumerate(linhas):
        m = _LINHA_RE.match(linha.strip())
        if not m:
            continue
        proxima = linhas[i + 1] if i + 1 < len(linhas) else ""
        mk = _CHAVE_RE.search(proxima)
        if not mk:
            continue

        peso = _to_decimal(m.group("weight"))
        frete = _to_decimal(m.group("freight"))
        carga = _to_decimal(m.group("cargo"))
        data = _to_date(m.group("service_date"))
        if peso is None or frete is None or carga is None or data is None:
            continue

        nf = m.group("invoice")
        itens.append({
            "access_key":      mk.group(1),
            "awb":             m.group("awb"),
            "origin":          m.group("origin"),
            "destination":     m.group("destination"),
            "service_date":    data,
            "cargo_weight_kg": peso,
            "cargo_amount":    carga,
            "freight_amount":  frete,
            # "DIVER." nao e numero de nota: e a declaracao de que sao varias. Guardar o
            # literal seria gravar uma NF inexistente; None diz "nao ha uma unica NF".
            "linked_invoice":  None if nf.upper().startswith(DIVERSAS[:5]) else nf,
            "receiver_name":   m.group("receiver").strip() or None,
        })

    if not itens or not totals_match(text, itens):
        return []
    return itens


def totals_match(text: str, itens: "list[dict]") -> bool:
    """A soma do que foi extraido bate com o SUB-TOTAL impresso na fatura?

    Este e o oraculo do modulo — INDEPENDENTE do regex das linhas, porque le outro trecho do
    documento, escrito pelo proprio emissor. Sem ele, "o parser casou 9 de 10 linhas" e
    indistinguivel de "a fatura tinha 9 linhas".
    """
    m = _SUBTOTAL_RE.search(text)
    if not m:
        return False
    peso_impresso = _to_decimal(m.group("weight"))
    frete_impresso = _to_decimal(m.group("freight"))
    if peso_impresso is None or frete_impresso is None:
        return False
    soma_peso = sum((i["cargo_weight_kg"] for i in itens), Decimal(0))
    soma_frete = sum((i["freight_amount"] for i in itens), Decimal(0))
    return (abs(soma_peso - peso_impresso) <= TOTAL_TOLERANCE
            and abs(soma_frete - frete_impresso) <= TOTAL_TOLERANCE)
