"""Construtor de .docx SINTETICO para os testes — nenhum binario no repositorio.

Vive em arquivo proprio, e nao dentro de um dos test_*.py, pelo mesmo motivo de
`fixtures_cte.py`: `test_docx_content.py` (modulo puro), `test_docx_extract.py` (roteamento) e
`test_docx_pipeline.py` (wiring do reader) precisam do MESMO docx. Copiada, a fixture diverge no
primeiro ajuste e os tres arquivos passam a testar documentos diferentes com o mesmo nome.

NAO e `conftest.py` porque estes testes sao `unittest.TestCase`, que nao recebe fixture por
parametro.
"""

import io
import zipfile

# Markup minimo de WordprocessingML. `<w:t>` por RUN — o Word parte uma frase em varios runs por
# formatacao/revisao, e reproduzir isso e o ponto principal das fixtures.
_DOC_ABERTURA = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    "<w:body>"
)
_DOC_FECHAMENTO = "</w:body></w:document>"

_CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Default Extension="png" ContentType="image/png"/>'
    "</Types>"
)


def paragrafo_xml(runs) -> str:
    """Um `<w:p>` com um `<w:t>` por run — a fragmentacao que o Word produz de verdade."""
    corpo = "".join(f"<w:r><w:t>{r}</w:t></w:r>" for r in runs)
    return f"<w:p>{corpo}</w:p>"


def document_xml(paragrafos) -> str:
    """`word/document.xml` a partir de uma lista de paragrafos (cada um: lista de runs)."""
    return _DOC_ABERTURA + "".join(paragrafo_xml(p) for p in paragrafos) + _DOC_FECHAMENTO


def build_docx(paragrafos=(), *, media=None, extra_parts=None,
               omit_document=False, duplicate_document=False,
               raw_entries=None, document_xml_override=None) -> bytes:
    """Monta um .docx EM MEMORIA e devolve os bytes.

    paragrafos              lista de paragrafos; cada paragrafo e uma lista de runs (strings)
    media                   dict {nome_do_arquivo: bytes} gravado em `word/media/`
    extra_parts             dict {caminho_completo_no_zip: str} — header/footer, por exemplo
    omit_document           nao grava `word/document.xml` (ZIP valido que nao e docx)
    duplicate_document      grava `word/document.xml` DUAS vezes (ambiguidade = sinal de ataque)
    raw_entries             dict {nome: bytes} gravado cru — usado para nomes hostis (`../`)
    document_xml_override   texto literal do document.xml (para XML hostil)
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        if not omit_document:
            conteudo = (document_xml_override if document_xml_override is not None
                        else document_xml(paragrafos))
            zf.writestr("word/document.xml", conteudo)
            if duplicate_document:
                zf.writestr("word/document.xml", conteudo)
        for caminho, texto in (extra_parts or {}).items():
            zf.writestr(caminho, texto)
        for nome, dados in (media or {}).items():
            zf.writestr(f"word/media/{nome}", dados)
        for nome, dados in (raw_entries or {}).items():
            zf.writestr(nome, dados)
    return buf.getvalue()


# Linha digitavel de boleto REAL, ja usada em outro teste do projeto — passa no DV do
# `febraban` (`extract_linha_digitavel` E `normalize_barcode`).
#
# ⚠️ NAO substituir por uma sequencia inventada de 47 digitos: a primeira versao desta fixture
# usava uma, e ela era RECUSADA pelo DV. O teste teria ficado verde pelo motivo errado — a
# camada 1 recusaria o documento por "sem pagavel" em vez de por defeito do parser, e o caso
# que importa (remontar a linha partida em runs) nunca seria exercitado.
LINHA_DIGITAVEL = "23793159800000151088350709000001339840016800000"

#: A MESMA linha, fatiada como o Word faria — o caso que o parser precisa remontar.
#
# 🔴 OS CORTES CAEM NO MEIO DE GRUPOS DE DIGITOS, de proposito. A primeira versao cortava nos
# ESPACOS ("23793.15980" | " " | "00001.510883" | ...), e isso tornava o teste da colagem
# INUTIL: validado por mutante, trocar o `"".join` por `" ".join` no parser deixava a suite
# VERDE, porque `extract_linha_digitavel` tolera espaco a mais entre os campos. Cortando dentro
# do numero, o mesmo mutante quebra a linha de verdade e o teste fica vermelho — que e o
# comportamento que o caso promete. (CLAUDE.md §2: teste que promete uma garantia tem de
# entrega-la; a pergunta e "o que aconteceria se eu quebrasse isto de proposito?".)
LINHA_EM_RUNS = ["23793.1", "5980 00001.5", "10883 50709.0", "00001 3 3984", "0016800000"]


def docx_com_linha_digitavel() -> bytes:
    """.docx cujo texto traz a linha digitavel FRAGMENTADA em varios runs."""
    return build_docx([["Prezado cliente, segue o boleto para pagamento."], LINHA_EM_RUNS])


def docx_so_com_imagem(*, tamanhos=(4_000, 40_000)) -> bytes:
    """.docx sem pagavel no texto e com imagens embutidas de tamanhos distintos."""
    media = {f"image{i + 1}.png": b"\x89PNG" + b"x" * n for i, n in enumerate(tamanhos)}
    return build_docx([["Segue em anexo o boleto."]], media=media)
