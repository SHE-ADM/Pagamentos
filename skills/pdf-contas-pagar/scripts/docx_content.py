"""Leitura de anexo .docx (Word moderno) — texto e imagem embutida, SEM dependencia nova.

Modulo SO STDLIB, pelo mesmo motivo do `febraban.py`, do `fiscal_key.py` e do `cte_content.py`:
quem so precisa abrir um ZIP e ler texto nao deve arrastar pdfplumber/pandas/PIL junto. Um .docx
e um ZIP com XML dentro — `zipfile` da stdlib basta.

POR QUE ESTE MODULO EXISTE
    E-mail `email_control` 1516 ("BOLETO: 0003150-04.2023.8.26.0577", 17/08/2026): boleto judicial
    anexado como .docx. O filtro de `save_attachments` so conhecia PDF e imagem, entao o anexo era
    descartado num `continue` SILENCIOSO — sem log, sem rastro. O e-mail seguia como "sem anexo",
    caia no fallback do corpo (que tinha 184 chars de cabecalho de encaminhamento) e terminava em
    'falha' com a nota "Corpo sem sinal financeiro": o pipeline culpava o e-mail por um documento
    que ele proprio jogou fora. Medidos 3 e-mails com o mesmo padrao.

AS TRES CAMADAS, NESTA ORDEM
    1. TEXTO (`docx_text`) — o boleto gerado por editor traz a linha digitavel como texto de
       verdade. Determinístico, custo zero, sem LLM no caminho.
    2. IMAGEM EMBUTIDA (`docx_largest_image`) — quando o documento e so uma figura colada (print
       do boleto), o texto vem vazio e a maior imagem de `word/media/` vai para o Claude Vision.
    3. Falha explicita — quem chama transforma em `_failure_record` com motivo legivel.

🔴 O CONTEUDO VEM DE REMETENTE NAO CONFIAVEL — as defesas abaixo NAO sao opcionais
    Um .docx e um ZIP, e ZIP recebido por e-mail e superficie de ataque classica:

      - **Zip bomb**: alguns KB que descomprimem para gigabytes. Defesa em DOIS niveis, porque o
        `file_size` do cabecalho e DECLARADO pelo proprio arquivo e pode mentir: conferimos a soma
        declarada ANTES de descomprimir **e** lemos cada entrada com teto real (`_read_limited`).
        Só o primeiro nivel seria uma guarda que o atacante controla.
      - **Path traversal** (`../../etc/passwd` como nome de entrada): lemos apenas entradas de nome
        CONHECIDO e nunca usamos `extractall`. A imagem extraida e gravada com nome gerado por nos —
        o nome vindo do ZIP nunca toca o sistema de arquivos.
      - **Billion laughs / XXE**: NAO usamos parser XML. O texto sai por regex sobre as tags de
        conteudo, o que elimina a classe inteira sem `defusedxml` (dependencia nova). Aqui isso nao
        e concessao: o alvo e linha digitavel e valor, nao fidelidade tipografica.

    Toda funcao publica e BEST-EFFORT: devolve vazio/None e loga. Nenhuma levanta — elas rodam
    dentro do laco de extracao, e uma excecao aqui derrubaria o lote inteiro de um e-mail.
"""

import html
import logging
import re
import zipfile
from pathlib import Path

log = logging.getLogger("pdf-contas-pagar")

DOCX_SUFFIX = ".docx"

# Tetos. Um boleto em .docx real tem dezenas de KB; estes numeros sao folga larga para documento
# legitimo e corte duro para o abusivo.
DOCX_MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024   # soma DECLARADA de todas as entradas
DOCX_MAX_XML_BYTES          = 10 * 1024 * 1024   # uma unica entrada de texto
DOCX_MAX_IMAGE_BYTES        = 12 * 1024 * 1024   # uma unica imagem embutida
DOCX_MAX_ENTRIES            = 2_000              # ZIP com dezenas de milhares de entradas e ataque

# Entradas de TEXTO que interessam, em ordem de leitura. Cabecalho e rodape entram porque boleto
# montado em editor frequentemente poe a linha digitavel no rodape da pagina.
_TEXT_ENTRY_RE = re.compile(
    r"^word/(document|header\d*|footer\d*)\.xml$", re.IGNORECASE)

# Imagens embutidas. So os formatos que o Claude Vision aceita — .emf/.wmf (metarquivo do Windows,
# comum em documento do Word) ficam de fora de proposito: enviá-los seria gastar uma chamada de API
# para receber erro.
_MEDIA_ENTRY_RE = re.compile(
    r"^word/media/[^/]+\.(png|jpe?g|gif|webp)$", re.IGNORECASE)

# Tokens de conteudo do WordprocessingML. O prefixo de namespace e generico (`w:t`, mas tambem
# `a:t` de caixa de texto/grafico) porque os dois carregam texto de verdade.
#
# 🔴 A ORDEM DAS ALTERNATIVAS E A AUSENCIA DE SEPARADOR SAO O CERNE DESTE MODULO.
# O Word fragmenta uma frase em varios `<w:t>` por motivo de formatacao/revisao: a linha digitavel
# `34191.79001 01043.510047 91020.150008 8 92510000012345` costuma chegar partida em 5 a 10 runs.
# Concatenar SEM separador dentro do mesmo paragrafo e o que a remonta — inserir espaco entre runs
# quebraria o casamento de `extract_linha_digitavel` e o boleto sumiria com o arquivo intacto.
# `</w:p>` e `<w:br/>` viram quebra de linha; `<w:tab/>` vira espaco.
_TOKEN_RE = re.compile(
    r"<(?:[A-Za-z0-9]+:)?t(?:\s[^>]*)?>(?P<txt>.*?)</(?:[A-Za-z0-9]+:)?t>"
    r"|<(?:[A-Za-z0-9]+:)?tab\b[^>]*>"
    r"|<(?:[A-Za-z0-9]+:)?br\b[^>]*>"
    r"|</(?:[A-Za-z0-9]+:)?p>",
    re.DOTALL,
)


def is_docx(path) -> bool:
    """True quando o arquivo deve ser tratado como .docx — SO pela extensao.

    Deliberadamente NAO checa a assinatura do ZIP. Roteamento tem de ser estavel: um .docx
    corrompido precisa cair no ramo de docx e virar falha legivel ("nao e um ZIP valido"), nao
    escorregar para o pdfplumber e produzir um erro de PDF sobre um arquivo que nunca foi PDF.
    A validacao do conteudo e responsabilidade de quem le (`docx_text`/`docx_largest_image`).
    """
    try:
        return Path(path).suffix.lower() == DOCX_SUFFIX
    except Exception:  # noqa: BLE001 — path invalido nao e motivo para derrubar o lote
        return False


def _read_limited(zf: zipfile.ZipFile, name: str, limit: int) -> bytes:
    """Le uma entrada com teto REAL de bytes descomprimidos.

    `ZipInfo.file_size` e declarado pelo arquivo e um ZIP malicioso pode mentir; por isso lemos
    `limit + 1` e recusamos se estourar, em vez de confiar no cabecalho.
    """
    with zf.open(name) as fh:
        data = fh.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"entrada '{name}' excede o teto de {limit} bytes")
    return data


def _open_docx(path) -> zipfile.ZipFile:
    """Abre o .docx validando estrutura e tamanho — levanta em qualquer anomalia.

    Uso interno: as funcoes publicas capturam e degradam. Manter o `raise` aqui e o que permite
    distinguir, no log, "nao e ZIP" de "ZIP bom sem o que procuro".
    """
    zf = zipfile.ZipFile(path)
    try:
        infos = zf.infolist()
        if len(infos) > DOCX_MAX_ENTRIES:
            raise ValueError(f"ZIP com {len(infos)} entradas (teto {DOCX_MAX_ENTRIES})")
        total = sum(i.file_size for i in infos)
        if total > DOCX_MAX_UNCOMPRESSED_BYTES:
            raise ValueError(
                f"conteudo descomprimido declarado de {total} bytes "
                f"(teto {DOCX_MAX_UNCOMPRESSED_BYTES}) — possivel zip bomb")
    except Exception:
        zf.close()
        raise
    return zf


def _xml_to_text(xml: str) -> str:
    """Texto de um XML do WordprocessingML, preservando a colagem dos runs."""
    partes = []
    for m in _TOKEN_RE.finditer(xml):
        txt = m.group("txt")
        if txt is not None:
            partes.append(html.unescape(txt))
            continue
        tag = m.group(0)
        # `<w:tab/>` vira espaco; `<w:br/>` e `</w:p>` viram quebra de linha.
        partes.append(" " if re.match(r"<(?:[A-Za-z0-9]+:)?tab\b", tag) else "\n")
    return "".join(partes)


def docx_text(path) -> str:
    """Texto do .docx (documento + cabecalhos + rodapes). "" em qualquer falha.

    Best-effort por contrato: e chamado no caminho de extracao e no `_pdf_text` do reader (que
    alimenta a regra LEBIANCO e o gancho de documento fiscal). Falhar ali nao pode custar o e-mail.
    """
    try:
        with _open_docx(path) as zf:
            nomes = [i.filename for i in zf.infolist() if _TEXT_ENTRY_RE.match(i.filename)]
            if not nomes:
                log.info(f"  [DOCX] {Path(path).name}: ZIP sem word/document.xml — nao e um .docx")
                return ""
            # `document.xml` primeiro; cabecalhos/rodapes depois, em ordem estavel.
            nomes.sort(key=lambda n: (0 if "document" in n.lower() else 1, n.lower()))
            blocos = []
            for nome in nomes:
                try:
                    bruto = _read_limited(zf, nome, DOCX_MAX_XML_BYTES)
                except Exception as e:  # noqa: BLE001 — entrada ruim nao invalida as outras
                    log.warning(f"  [DOCX] {Path(path).name}: entrada '{nome}' ignorada ({e})")
                    continue
                blocos.append(_xml_to_text(bruto.decode("utf-8", errors="replace")))
            return "\n".join(b for b in blocos if b).strip()
    except Exception as e:  # noqa: BLE001 — best-effort por design
        log.warning(f"  [DOCX] nao foi possivel ler o texto de {Path(path).name}: {e}")
        return ""


def docx_largest_image(path, dest_dir):
    """Extrai a MAIOR imagem embutida para `dest_dir` e devolve o caminho, ou None.

    "A maior" e a mesma heuristica de `save_inline_images` no reader: num documento que e um print
    de boleto, o documento E a imagem grande; logo/assinatura sao pequenas.

    🔴 O nome do arquivo de destino e GERADO AQUI, nunca copiado da entrada do ZIP — e o que fecha
    o path traversal. A EXTENSAO e preservada porque `_vision_source_block` (extract_pdf.py) escolhe
    o media_type pelo sufixo: gravar como `.bin` faria o bloco Vision ser montado como PDF.
    """
    try:
        with _open_docx(path) as zf:
            midias = [i for i in zf.infolist() if _MEDIA_ENTRY_RE.match(i.filename)]
            if not midias:
                return None
            maior = max(midias, key=lambda i: i.file_size)
            try:
                dados = _read_limited(zf, maior.filename, DOCX_MAX_IMAGE_BYTES)
            except Exception as e:  # noqa: BLE001
                log.warning(f"  [DOCX] {Path(path).name}: imagem embutida ignorada ({e})")
                return None
        ext = Path(maior.filename).suffix.lower()
        destino = Path(dest_dir) / f"{Path(path).stem}_docx_media{ext}"
        destino.write_bytes(dados)
        log.info(f"  [DOCX] imagem embutida extraida: {destino.name} ({len(dados)} bytes)")
        return destino
    except Exception as e:  # noqa: BLE001 — best-effort por design
        log.warning(f"  [DOCX] nao foi possivel extrair imagem de {Path(path).name}: {e}")
        return None
