"""
Codigos de pagamento FEBRABAN — codigo de barras, linha digitavel e o que se deriva deles.

Modulo SEM DEPENDENCIAS (so stdlib) de proposito: o caminho do CORPO do e-mail precisa
apenas normalizar/validar digitos, e antes importava o `extract_pdf` inteiro para isso —
carregando pandas, pdfplumber, PIL e pypdf (~580 ms) so para rodar alguns regex. Era esse
peso que obrigava o import lazy com fallback silencioso em `read_emails`.

O `extract_pdf` reexporta tudo o que esta aqui, entao quem ja importava de la continua
funcionando.
"""

import re
from datetime import date, datetime, timedelta, timezone


def normalize_barcode(raw):
    """Normaliza E VALIDA — a escolha SEGURA, de proposito com o nome mais curto.

    Rejeita o codigo que o DV REFUTA (ver `barcode_dv_refuted`). Use esta em qualquer
    captura cuja procedencia voce nao possa garantir: e o comportamento correto quando os
    digitos podem ter sido COLADOS por uma janela de regex, caso em que o "codigo" nao e
    codigo de nada e envenenaria a dedup.

    Para os digitos vindos de uma captura ESTRUTURADA (5 campos FEBRABAN validados) ou de
    um extrator de documento (Vision/LLM), use `normalize_barcode_allow_misread` — la um
    DV que nao fecha e leitura corrompida de um codigo REAL, e apaga-lo perderia a unica
    chave de dedup do titulo.

    O padrao e o SEGURO porque as duas falhas nao se equivalem: codigo inventado causa
    dedup falsa e PERDA SILENCIOSA de pagavel; barcode ausente so custa a chave de dedup,
    com a conta gravada do mesmo jeito."""
    barcode = _normalize_barcode_format(raw)
    return None if barcode_dv_refuted(barcode) else barcode


def normalize_barcode_allow_misread(raw):
    """Normaliza SEM julgar o DV — para digitos de procedencia CONFIAVEL (captura
    estruturada ou extrator de documento), em que um DV que nao fecha significa OCR lendo
    errado um codigo REAL. Ver `normalize_barcode` para o porque da assimetria."""
    return _normalize_barcode_format(raw)


def _normalize_barcode_format(raw):
    """Normalizacao pura (sem politica de confianca): so digitos + comprimento valido.

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
        #
        # INVARIANTE: toda arrecadacao FEBRABAN comeca por '8' (identificador de
        # produto). O filtro existe porque as capturas FROUXAS de codigo de barras
        # (regex de janela, que atravessa quebra de linha) podem COLAR digitos de
        # trechos diferentes e formar 48 digitos — comprimento aceito aqui, gerando um
        # codigo INVENTADO que envenena a dedup por barcode. Verificado contra os dados
        # reais: 35/35 dos barcodes de 48 digitos gravados comecam por '8'.
        return digits if digits.startswith("8") else None
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


def barcode_dv_refuted(barcode) -> bool:
    """O DV REFUTA este codigo? (True = comprovadamente errado.)

    O nome afirma o que a funcao consegue PROVAR. Uma versao "is_valid" seria lida como
    "foi validado" e mentiria nos casos em que a regra nem se aplica — aqui, False
    significa apenas NAO REFUTADO (DV confere OU nao ha DV a conferir), nunca "valido".

    Layout: banco(3) moeda(1) DV(1) fator(4) valor(10) campo_livre(25). O DV e modulo 11
    sobre os 43 digitos restantes, pesos 2..9 ciclicos da DIREITA para a esquerda; resto
    0, 10 ou 11 => DV 1.

    Retorna False quando a regra NAO SE APLICA (chave de acesso NF-e/CT-e, arrecadacao de
    48, comprimento invalido, None): nao ha o que refutar.

    Medido contra os dados reais: `pdf_text` 228/228 e `email_body` 6/6 conferem — ou
    seja, digito extraido do TEXTO sempre fecha. `pdf_vision` fecha em 36/56: o DV e um
    discriminador preciso de leitura corrompida por OCR (o id 463, ja documentado como
    barcode corrompido, esta entre as falhas)."""
    if not is_boleto_barcode(barcode):
        return False
    digits = re.sub(r"\D", "", str(barcode))
    if len(digits) != 44:              # arrecadacao (48) tem outro esquema de DV
        return False
    corpo = digits[:4] + digits[5:]    # tudo menos o proprio DV (posicao 4)
    soma, peso = 0, 2
    for ch in reversed(corpo):
        soma += int(ch) * peso
        peso = 2 if peso == 9 else peso + 1
    dv = 11 - (soma % 11)
    return (1 if dv in (0, 10, 11) else dv) != int(digits[4])


# ── Arrecadacao (guia de tributo / concessionaria) ────────────────────────────
# Layout do CODIGO DE BARRAS de arrecadacao (44 digitos, sem os DVs de bloco):
#     produto(1)='8' segmento(1) id_valor(1) DV_geral(1) valor(11) empresa(4) campo_livre(25)
# A LINHA DIGITAVEL (48) e o mesmo conteudo em 4 blocos de 12 = 11 digitos + DV do bloco.
#
# O `id_valor` (posicao 3) diz o que o campo de 11 digitos SIGNIFICA e como o DV geral e
# calculado — os dois de uma vez, e por isso ele e a chave de tudo aqui:
#     6 = valor EFETIVO   (DV modulo 10)     8 = valor EFETIVO   (DV modulo 11)
#     7 = valor REFERENCIA (DV modulo 10)    9 = valor REFERENCIA (DV modulo 11)
# "Referencia" NAO e dinheiro — e um identificador (contrato, matricula, competencia).
# Tratar 7/9 como valor gravaria um numero enorme e arbitrario como se fosse R$.
_ARRECADACAO_VALOR_EFETIVO = ("6", "8")
_ARRECADACAO_MOD11 = ("8", "9")


def arrecadacao_44(barcode) -> "str | None":
    """Codigo de barras de arrecadacao com 44 digitos, a partir de 44 ou 48 (linha digitavel).

    Da linha digitavel de 48, descarta o DV de cada um dos 4 blocos de 12. Retorna None
    para qualquer coisa que nao seja arrecadacao (nao comeca por '8', outro comprimento)."""
    if not barcode:
        return None
    d = re.sub(r"\D", "", str(barcode))
    if not d.startswith("8"):
        return None                     # invariante do produto '8' (mesma de is_boleto_barcode)
    if len(d) == 44:
        return d
    if len(d) == 48:
        return d[0:11] + d[12:23] + d[24:35] + d[36:47]
    return None


def arrecadacao_dv_refuted(barcode) -> bool:
    """O DV GERAL refuta este codigo de arrecadacao? (True = comprovadamente errado.)

    Contraparte de `barcode_dv_refuted` para o esquema de arrecadacao, que aquela funcao
    declara nao cobrir ("arrecadacao (48) tem outro esquema de DV"). Mesma semantica de
    nome: False significa NAO REFUTADO (confere OU a regra nao se aplica), nunca "valido".

    O modulo vem do `id_valor`: 6/7 -> modulo 10; 8/9 -> modulo 11. Existe para que o
    valor embutido so seja adotado quando o codigo foi lido corretamente — sem isso, um
    barcode corrompido por OCR sobrescreveria um valor que o LLM leu certo (a mesma classe
    de falha do id 463, em que o fator de um barcode mal lido estragou o vencimento)."""
    d = arrecadacao_44(barcode)
    if d is None or d[2] not in ("6", "7", "8", "9"):
        return False                    # nao ha o que refutar
    corpo = d[:3] + d[4:]               # tudo menos o proprio DV (posicao 4)
    if d[2] in _ARRECADACAO_MOD11:
        soma, peso = 0, 2
        for ch in reversed(corpo):
            soma += int(ch) * peso
            peso = 2 if peso == 9 else peso + 1
        resto = soma % 11
        dv = 0 if resto in (0, 1) else 11 - resto
    else:                               # modulo 10
        soma, peso = 0, 2
        for ch in reversed(corpo):
            prod = int(ch) * peso
            soma += prod if prod < 10 else prod - 9
            peso = 1 if peso == 2 else 2
        dv = (10 - soma % 10) % 10
    return dv != int(d[3])


def amount_from_arrecadacao(barcode) -> "float | None":
    """Valor (R$) embutido no codigo de barras de ARRECADACAO — posicoes 5-15, em centavos.

    E o TOTAL A RECOLHER: o emissor codifica o valor que sera efetivamente debitado, ja
    com atualizacao monetaria, juros e multa. Numa GNRE isso o distingue do "Valor
    Principal" impresso ao lado, que e so a parcela do tributo — e era o que o LLM vinha
    copiando (27 das 31 guias gravadas A MENOR, R$ 297,17 no total).

    Retorna None quando o valor nao e confiavel, e cada motivo importa:
      - `id_valor` 7/9 => o campo e valor de REFERENCIA (identificador), nao dinheiro;
      - DV geral refutado => o codigo foi lido errado (OCR), entao o valor tambem esta;
      - fora da faixa plausivel => lixo.
    Determinístico e imune ao LLM, como o fator de vencimento e para o vencimento."""
    d = arrecadacao_44(barcode)
    if d is None or d[2] not in _ARRECADACAO_VALOR_EFETIVO:
        return None
    if arrecadacao_dv_refuted(barcode):
        return None
    try:
        valor = int(d[4:15]) / 100.0
    except ValueError:
        return None
    return valor if 0 < valor < 5_000_000 else None


def extract_barcode(text):
    # Prefere o padrao estruturado da linha digitavel (mais preciso)
    ld = extract_linha_digitavel(text)
    if ld:
        # Captura ESTRUTURADA (5 campos FEBRABAN) — procedencia confiavel.
        return normalize_barcode_allow_misread(ld)
    # Fallback FROUXO: janela de digitos SEM ancora de rotulo — num PDF cheio de tabelas
    # numericas ela cola numeros nao relacionados. Por isso valida o DV (strict): aqui,
    # ao contrario do caminho estruturado acima, um DV que nao fecha significa "isto nao
    # e um codigo de barras", nao "o OCR leu errado".
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

    # Padrao 5: separador ENTRE os campos tambem por PONTO (sem espaco nenhum) —
    # forma usada por e-mails HTML de fatura, em que a linha digitavel e um unico
    # token pontuado. Ex. (MOVVI, conta 693):
    #   "23793.39100.90000.004375.07000.842000.3.15250000018190"
    # Os padroes 1-4 exigem \s+ entre os campos e nao casam essa forma — o boleto
    # ficava sem barcode (perdendo a dedup por codigo de barras E o vencimento
    # autoritativo pelo fator FEBRABAN). Ultimo da ordem: so entra quando nenhum
    # dos anteriores casou, entao nao altera o resultado de nenhuma entrada atual.
    m = re.search(
        r"\d{5}[. ]\d{5}[.\s]+\d{5}[. ]\d{6}[.\s]+\d{5}[. ]\d{6}[.\s]+\d[.\s]+\d{14}",
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


def barcode_self_refuted(barcode, amount, ref_date=None) -> bool:
    """O codigo de barras se REFUTA a si mesmo? (True = comprovadamente corrompido.)

    Existe para o OCR de boleto ESCANEADO, que insere/desloca digitos: o codigo continua
    com 44 digitos — passa no filtro de COMPRIMENTO — mas os campos saem deslocados. Sinal
    medido nos dados reais: valor exatamente 10x o do documento e fator de vencimento
    impossivel (5370, 5380, 5420) onde o correto era 1537.

    Dois testes INDEPENDENTES, e so refuta quando os DOIS falham:
      1. **valor** embutido (posicoes 10-19) confere com o `amount` lido do documento;
      2. **fator de vencimento** decodifica numa data plausivel (`due_date_from_barcode`,
         que ja trata o reset FEBRABAN e a distancia maxima do `ref_date`).

    A conjuncao e deliberada: um boleto legitimo cujo `amount` o extrator leu errado ainda
    tem fator plausivel, e um boleto sem valor no codigo ainda tem o valor conferindo por
    outra via. Exigir os dois evita apagar codigo bom — medido: dos 442 barcodes gravados,
    isto refuta 18 (todos `pdf_vision`) e preserva os 7 em que so o valor diverge
    (349 consistentes + 68 nao-boleto + 7 so-valor + 18 refutados = 442).

    Por que APAGAR e melhor que manter: o barcode e a impressao digital 1 da deduplicacao,
    a mais forte. Um codigo corrompido nao casa o boleto REAL quando ele chega pela 2a via
    — a dedup falha e nasce uma conta DUPLICADA. Sem barcode, a dedup cai nas impressoes 2
    e 3 (documento+valor, valor+vencimento), que funcionam. Codigo errado e pior que ausente.

    Retorna False quando a regra nao se aplica (chave NF-e/CT-e, arrecadacao de 48,
    comprimento invalido, None): nao ha o que refutar.
    """
    d = re.sub(r"\D", "", str(barcode or ""))
    if len(d) != 44 or d[3] != "9" or d[:3] == "000":
        return False                      # nao e boleto bancario FEBRABAN
    if amount not in (None, ""):
        try:
            valor = amount_from_barcode(d)
            if valor is not None and abs(valor - float(amount)) <= 0.01:
                return False              # o valor confirma o codigo
        except (TypeError, ValueError):
            pass                          # amount ilegivel: decide so pelo fator
    # Fator 0 = boleto A VISTA (sem vencimento embutido): legitimo, nao ha fator a
    # conferir. Sem esta saida o gate leria "ausencia de prova" como "prova de erro" e
    # apagaria o codigo de todo boleto a vista.
    if int(d[5:9]) == 0:
        return False
    return due_date_from_barcode(d, ref_date) is None


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
        # MESMO invariante de normalize_barcode: arrecadacao FEBRABAN comeca por '8'
        # (identificador de produto). Sem ele, qualquer sequencia de 48 digitos —
        # inclusive a colada por captura frouxa, ou um numero longo de tabela — seria
        # tratada como pagavel. A regra vive nos dois pontos porque esta funcao tambem
        # julga texto CRU, que nao passou por normalize_barcode
        # (ex.: _text_has_arrecadacao_barcode, na deteccao de pagina pagavel).
        return d.startswith("8")
    return len(d) == 44 and d[3] == "9" and d[:3] != "000"
