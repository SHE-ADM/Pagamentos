"""
Chave de acesso de documento fiscal eletronico (SEFAZ) — 44 digitos.

Modulo SEM DEPENDENCIAS (so stdlib), pelo mesmo motivo do `febraban.py`: quem precisa
apenas validar digitos nao deve arrastar pandas/pdfplumber/PIL junto. O `extract_pdf`
reexporta o que esta aqui, entao um rename futuro estoura no import em vez de degradar
em silencio.

POR QUE ISTO NAO ESTA NO `febraban.py`
    Sao dominios diferentes. La sao codigos de PAGAMENTO (boleto/arrecadacao, padrao
    FEBRABAN); aqui e documento FISCAL (padrao SEFAZ). Os dois tem 44 digitos e ambos
    usam modulo 11, mas a posicao do DV e a regra do resto DIVERGEM:

        boleto  -> DV na posicao  4, resto 0/10/11 => DV 1   (barcode_dv_refuted)
        SEFAZ   -> DV na posicao 43, resto 0/1     => DV 0   (aqui)

    Usar um no lugar do outro nao levanta erro: devolve um veredito plausivel e errado.
    `barcode_dv_refuted` inclusive devolve False ("nao ha o que refutar") para chave de
    acesso de proposito — ela sabe que a regra dela nao se aplica aqui.

LAYOUT DA CHAVE (posicoes 0-based)

    0-1    UF do emitente (codigo IBGE)
    2-5    AAMM da emissao
    6-19   CNPJ do emitente
    20-21  modelo — 55 NF-e · 57 CT-e · 59 CF-e-SAT · 65 NFC-e
    22-24  serie
    25-33  numero do documento
    34     tipo de emissao
    35-42  codigo numerico
    43     DV (modulo 11)

POR QUE A VALIDACAO E EM CINCO CAMADAS (nao regredir para "44 digitos")
    Medido no banco em 2026-08-01: das 8 contas com barcode de 44 digitos que nao sao
    boleto, **7 sao lixo** (guias DAM/DARF/DAE e recibos cujo codigo de arrecadacao foi
    gravado truncado) e so uma e chave de acesso real. Filtrar por comprimento produz
    87% de falso positivo.

    As camadas — UF valida, mes 01-12, ANO plausivel, modelo no dominio e DV — derrubam
    as sete, o que importa porque o texto de um PDF e cheio de tabelas de numeros.

    A camada do ANO foi acrescentada DEPOIS, pelo backfill: das 207 chaves varridas no
    bucket, uma passou nas outras quatro por acaso — 44 digitos dentro de um "Boleto de
    Aluguel", com AAMM 9109 (setembro de 1991), UF 41, modelo 59 e DV fechando. Nenhum
    documento fiscal eletronico existe antes de 2006 (a NF-e e de 2006; CT-e 2008; CF-e
    2015), entao a janela [2006, ano corrente + 1] e um filtro de domínio, nao um chute
    sobre estes dados. Lição: sequencia aleatoria de 44 digitos PASSA em teste de DV com
    probabilidade ~1/11 — o DV sozinho nunca foi suficiente.
"""

import re
from datetime import date

# Modelos aceitos. O dominio TEM de espelhar o CHECK da migration 107 — ha teste
# cross-layer lendo o arquivo da migration e comparando com este dict.
FISCAL_MODELS: dict[int, str] = {
    55: "nfe",    # NF-e   — nota fiscal eletronica (mercadoria)
    57: "cte",    # CT-e   — conhecimento de transporte eletronico
    59: "cfe",    # CF-e   — cupom fiscal eletronico (SAT)
    65: "nfce",   # NFC-e  — nota fiscal de consumidor eletronica
}

ACCESS_KEY_LEN = 44

# Primeiro ano em que existe documento fiscal eletronico (NF-e, 2006). CT-e e de 2008 e
# CF-e-SAT de 2015 — 2006 e o piso seguro para os quatro modelos.
MIN_ISSUE_YEAR = 2006
# Tolerancia para o futuro: relogio do emissor adiantado ou documento pos-datado. Um ano
# e generoso; o que importa e barrar "2091".
MAX_ISSUE_YEAR_AHEAD = 1

# Codigos IBGE de UF. NFS-e nao entra neste modulo (e municipal e nao tem chave nacional
# de 44 digitos) — fica para a Onda 9 do roadmap.
_UF_CODES = frozenset({
    11, 12, 13, 14, 15, 16, 17,               # Norte
    21, 22, 23, 24, 25, 26, 27, 28, 29,       # Nordeste
    31, 32, 33, 35,                           # Sudeste
    41, 42, 43,                               # Sul
    50, 51, 52, 53,                           # Centro-Oeste + DF
})

# Sequencia de digitos possivelmente formatada: o DACTE costuma imprimir a chave em
# blocos de 4 separados por espaco, e alguns emissores usam ponto ou hifen.
_DIGIT_RUN_RE = re.compile(r"[\d][\d\s.\-]*[\d]")


def access_key_dv_ok(digits: str) -> bool:
    """O DV (posicao 43) confere para os 43 digitos anteriores?

    Modulo 11 com pesos 2..9 ciclicos da DIREITA para a esquerda; resto 0 ou 1 => DV 0.
    O nome afirma o que a funcao prova de fato: aqui, ao contrario do boleto, o digito
    sempre existe e sempre se aplica — nao ha o caso "regra nao aplicavel" que obrigou
    o `barcode_dv_refuted` a ser nomeado pela negativa.
    """
    if len(digits) != ACCESS_KEY_LEN or not digits.isdigit():
        return False
    soma, peso = 0, 2
    for ch in reversed(digits[:43]):
        soma += int(ch) * peso
        peso = 2 if peso == 9 else peso + 1
    resto = soma % 11
    dv = 0 if resto in (0, 1) else 11 - resto
    return dv == int(digits[43])


def parse_access_key(raw, ref_date=None) -> "dict | None":
    """Decompoe a chave de acesso, ou None quando ela nao passa nas cinco camadas.

    Devolve None (em vez de levantar) porque o chamador varre texto livre: "isto nao e
    uma chave" e o resultado ESPERADO na esmagadora maioria dos candidatos.

    `ref_date` existe para o teste fixar o "hoje" (mesmo padrao de
    `febraban.due_date_from_barcode`) — em producao o default e a data corrente.
    """
    if raw is None:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) != ACCESS_KEY_LEN:
        return None

    uf = int(digits[0:2])
    if uf not in _UF_CODES:
        return None

    mes = int(digits[4:6])
    if not 1 <= mes <= 12:
        return None

    # AA = 2 ultimos digitos do ano. Fora da janela do domínio, nao e chave — foi assim
    # que um "Boleto de Aluguel" gerou uma CF-e de 1991 no primeiro backfill.
    ano = 2000 + int(digits[2:4])
    ano_max = (ref_date or date.today()).year + MAX_ISSUE_YEAR_AHEAD
    if not MIN_ISSUE_YEAR <= ano <= ano_max:
        return None

    model = int(digits[20:22])
    if model not in FISCAL_MODELS:
        return None

    if not access_key_dv_ok(digits):
        return None

    return {
        "access_key":       digits,
        "model":            model,
        "model_name":       FISCAL_MODELS[model],
        "uf_code":          uf,
        "issue_year":       ano,
        "issue_yearmonth":  digits[2:6],          # AAMM, como impresso na chave
        "emitter_cnpj":     digits[6:20],
        "series":           int(digits[22:25]),
        "doc_number":       int(digits[25:34]),
        "dv":               int(digits[43]),
    }


def extract_access_keys(text, ref_date=None) -> "list[str]":
    """Todas as chaves de acesso validas do texto, na ordem de aparicao, sem repetir.

    Para cada sequencia de digitos (tolerando espaco/ponto/hifen no meio, que e como o
    DACTE imprime) roda uma janela de 44 sobre os digitos: a chave costuma vir isolada,
    mas as vezes chega colada a outro numero da mesma celula da tabela. A janela so e
    segura porque `parse_access_key` valida UF + mes + modelo + DV.
    """
    if not text:
        return []
    achadas, vistas = [], set()
    for run in _DIGIT_RUN_RE.finditer(str(text)):
        digits = re.sub(r"\D", "", run.group())
        for off in range(len(digits) - ACCESS_KEY_LEN + 1):
            cand = digits[off:off + ACCESS_KEY_LEN]
            if cand in vistas:
                continue
            if parse_access_key(cand, ref_date):
                vistas.add(cand)
                achadas.append(cand)
    return achadas
