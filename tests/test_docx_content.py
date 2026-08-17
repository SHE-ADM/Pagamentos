"""Testes de `docx_content` — leitura de anexo .docx (texto, imagem embutida e ataques).

Origem: e-mail `email_control` 1516 ("BOLETO: 0003150-04.2023.8.26.0577"), cujo boleto vinha em
.docx e era descartado em silencio por `save_attachments`.

O conteudo vem de remetente NAO CONFIAVEL, entao metade destes casos e adversarial: zip bomb,
path traversal, XML hostil, container trocado. Cada guarda tem o mutante que a valida anotado.
"""

import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import docx_content as D  # noqa: E402
import febraban as F  # noqa: E402

from fixtures_docx import (  # noqa: E402
    LINHA_DIGITAVEL, build_docx, docx_com_linha_digitavel, docx_so_com_imagem,
)


class _TmpMixin(unittest.TestCase):
    """Isola disco: NENHUM teste pode herdar estado do projeto (licao MainDryRunTest)."""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.tmp = Path(self._td.name)
        self.addCleanup(self._td.cleanup)

    def _arquivo(self, dados: bytes, nome: str = "boleto.docx") -> Path:
        p = self.tmp / nome
        p.write_bytes(dados)
        return p


class IsDocxTest(unittest.TestCase):
    def test_decide_por_extensao(self):
        self.assertTrue(D.is_docx("boleto.docx"))
        self.assertTrue(D.is_docx(Path("BOLETO.DOCX")))
        for nao in ("boleto.pdf", "foto.png", "contrato.doc", "planilha.xlsx", "sem_extensao"):
            self.assertFalse(D.is_docx(nao), nao)

    def test_nao_le_o_conteudo(self):
        # Roteamento tem de ser estavel: um .docx CORROMPIDO precisa cair no ramo de docx e
        # virar falha legivel, nao escorregar para o pdfplumber. Mutante: checar o magic aqui.
        self.assertTrue(D.is_docx("qualquer_coisa.docx"))


class DocxTextTest(_TmpMixin):
    def test_remonta_linha_digitavel_partida_em_runs(self):
        # 🔴 O CASO CENTRAL. O Word parte a linha em varios `<w:t>`; a concatenacao SEM
        # separador dentro do paragrafo e o que a remonta.
        # Mutante: `" ".join` no lugar do `"".join` -> extract_linha_digitavel devolve None.
        texto = D.docx_text(self._arquivo(docx_com_linha_digitavel()))
        self.assertIn("Prezado cliente", texto)
        self.assertEqual(F.extract_linha_digitavel(texto), LINHA_DIGITAVEL)

    def test_paragrafos_nao_sao_colados(self):
        # O inverso do caso acima: `</w:p>` TEM de virar quebra de linha. Sem isso, dois
        # numeros nao relacionados em paragrafos vizinhos formariam uma sequencia longa e
        # poderiam produzir um "pagavel" que nao existe no documento.
        # Mutante: remover o `\n` de `</w:p>` -> os dois blocos viram um numero so.
        docx = build_docx([["1234567890123456789012"], ["3456789012345678901234"]])
        texto = D.docx_text(self._arquivo(docx))
        self.assertIn("\n", texto)
        self.assertNotIn("12345678901234567890123456789012345678901234", texto)

    def test_desescapa_entidades_e_referencias_numericas(self):
        docx = build_docx([["Casa &amp; Cia", " ", "n&#186;", " ", "10"]])
        self.assertIn("Casa & Cia", D.docx_text(self._arquivo(docx)))

    def test_le_cabecalho_e_rodape(self):
        # Boleto montado em editor costuma por a linha digitavel no rodape da pagina.
        from fixtures_docx import document_xml

        docx = build_docx(
            [["corpo do documento"]],
            extra_parts={"word/footer1.xml": document_xml([["texto no rodape"]])},
        )
        texto = D.docx_text(self._arquivo(docx))
        self.assertIn("corpo do documento", texto)
        self.assertIn("texto no rodape", texto)

    def test_documento_sem_texto_devolve_vazio(self):
        self.assertEqual(D.docx_text(self._arquivo(build_docx([]))), "")

    def test_tab_vira_espaco_e_br_vira_quebra(self):
        docx = build_docx(
            [], document_xml_override=(
                '<?xml version="1.0"?><w:document '
                'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
                "<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>"
                "</w:body></w:document>"))
        self.assertEqual(D.docx_text(self._arquivo(docx)).strip(), "A B\nC")


class DocxTextAdversarialTest(_TmpMixin):
    def test_arquivo_que_nao_e_zip(self):
        self.assertEqual(D.docx_text(self._arquivo(b"%PDF-1.4 nao sou um zip")), "")

    def test_arquivo_inexistente(self):
        self.assertEqual(D.docx_text(self.tmp / "nao_existe.docx"), "")

    def test_zip_valido_sem_document_xml(self):
        # Pode ser um .xlsx/.odt renomeado. Nao e erro do pipeline — e "nao e um docx".
        self.assertEqual(D.docx_text(self._arquivo(build_docx(omit_document=True))), "")

    def test_zip_bomb_declarado_e_recusado_ANTES_de_descomprimir(self):
        # A guarda le `ZipInfo.file_size` (declarado) e recusa antes de qualquer `zf.open`.
        # A prova e o mock: se `open` for chamado, o teste falha — ou seja, o teto NAO pode
        # estar depois da leitura. Mutante: mover a checagem para depois do open.
        docx = self._arquivo(docx_com_linha_digitavel())
        with mock.patch.object(D, "DOCX_MAX_UNCOMPRESSED_BYTES", 10), \
             mock.patch.object(zipfile.ZipFile, "open",
                               side_effect=AssertionError("descomprimiu apesar do teto")):
            self.assertEqual(D.docx_text(docx), "")

    def test_entrada_individual_acima_do_teto_e_recusada(self):
        # Teto POR ENTRADA (`DOCX_MAX_XML_BYTES`), independente do total declarado.
        #
        # ⚠️ ESCOPO HONESTO: este caso prova que o teto por entrada existe e e aplicado; ele NAO
        # prova a defesa contra cabecalho MENTIROSO (ZIP que declara `file_size` pequeno e
        # contem mais). Medido por mutante: trocar `fh.read(limit + 1)` por `fh.read()` mantem
        # este teste VERDE, porque a comparacao de tamanho acontece depois em ambos os casos.
        # Fabricar um ZIP com header mentiroso exigiria montar os bytes do container a mao — a
        # protecao ali e ESTRUTURAL (ler com limite em vez de confiar no cabecalho), e esta
        # registrada como tal, nao como coberta por teste.
        docx = self._arquivo(docx_com_linha_digitavel())
        with mock.patch.object(D, "DOCX_MAX_XML_BYTES", 5):
            self.assertEqual(D.docx_text(docx), "")

    def test_zip_com_entradas_demais(self):
        docx = self._arquivo(docx_com_linha_digitavel())
        with mock.patch.object(D, "DOCX_MAX_ENTRIES", 1):
            self.assertEqual(D.docx_text(docx), "")

    def test_XML_hostil_nao_expande_entidade_E_o_parser_continua_lendo(self):
        # Billion laughs nao e "mitigado", e estruturalmente impossivel: nao ha expansor de
        # entidade porque nao ha parser XML. As DUAS asercoes importam — a negativa sozinha
        # ficaria verde com um parser cego que nao le nada.
        hostil = (
            '<?xml version="1.0"?>'
            '<!DOCTYPE w:document [<!ENTITY lol "AAAAAAAAAA">'
            '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>texto legitimo</w:t></w:r>"
            "<w:r><w:t>&lol2;</w:t></w:r></w:p></w:body></w:document>"
        )
        texto = D.docx_text(self._arquivo(build_docx(document_xml_override=hostil)))
        self.assertIn("texto legitimo", texto)            # sanidade do parser
        self.assertNotIn("AAAAAAAAAA", texto)             # nada foi expandido


class DocxLargestImageTest(_TmpMixin):
    def test_escolhe_a_maior_imagem(self):
        origem = self._arquivo(docx_so_com_imagem(tamanhos=(4_000, 40_000, 9_000)))
        destino = D.docx_largest_image(origem, self.tmp)
        self.assertIsNotNone(destino)
        self.assertGreater(destino.stat().st_size, 39_000)
        self.assertEqual(destino.suffix, ".png")

    def test_extensao_preservada_para_o_bloco_vision(self):
        # `_vision_source_block` escolhe o media_type pelo SUFIXO: gravar como .bin faria o
        # bloco ser montado como application/pdf. Mutante: sufixo fixo no destino.
        origem = self._arquivo(build_docx([["x"]], media={"foto.jpg": b"\xff\xd8" + b"y" * 9_000}))
        self.assertEqual(D.docx_largest_image(origem, self.tmp).suffix, ".jpg")

    def test_ignora_formato_que_o_vision_nao_aceita(self):
        origem = self._arquivo(build_docx([["x"]], media={"desenho.emf": b"z" * 90_000}))
        self.assertIsNone(D.docx_largest_image(origem, self.tmp))

    def test_sem_media_devolve_none(self):
        self.assertIsNone(D.docx_largest_image(self._arquivo(build_docx([["x"]])), self.tmp))

    def test_imagem_acima_do_teto_e_recusada(self):
        origem = self._arquivo(docx_so_com_imagem(tamanhos=(40_000,)))
        with mock.patch.object(D, "DOCX_MAX_IMAGE_BYTES", 100):
            self.assertIsNone(D.docx_largest_image(origem, self.tmp))

    def test_entrada_com_BARRA_no_nome_nem_e_lida(self):
        # 🔴 PATH TRAVERSAL, 1a barreira (a mais forte): o padrao de midia exige `[^/]+`, entao
        # `word/media/../../evil.png` nao casa e a entrada sequer e aberta. Mutante: trocar
        # `[^/]+` por `.+` no `_MEDIA_ENTRY_RE`.
        docx = build_docx(
            [["x"]], raw_entries={"word/media/../../evil.png": b"\x89PNG" + b"e" * 9_000})
        destino_dir = self.tmp / "saida"
        destino_dir.mkdir()

        self.assertIsNone(D.docx_largest_image(self._arquivo(docx), destino_dir))
        self.assertEqual(list(self.tmp.rglob("evil.png")), [])
        self.assertEqual(list(self.tmp.parent.glob("evil.png")), [])

    def test_o_destino_NAO_deriva_do_nome_da_entrada_do_zip(self):
        # 🔴 PATH TRAVERSAL, 2a barreira: mesmo para entrada legitima, o nome gravado e GERADO
        # por nos (stem do .docx + sufixo fixo) — o nome vindo do ZIP nunca toca o filesystem.
        #
        # ⚠️ Assertar apenas "nada foi escrito fora do dest_dir" NAO basta — medido por mutante:
        # com `dest_dir / maior.filename`, a escrita falha por diretorio inexistente e o teste
        # ficaria VERDE sem que a guarda existisse. Por isso o caso observa o NOME do resultado.
        docx = build_docx([["x"]], media={"imagem_do_remetente.png": b"\x89PNG" + b"e" * 9_000})
        destino_dir = self.tmp / "saida"
        destino_dir.mkdir()
        resultado = D.docx_largest_image(self._arquivo(docx, "origem.docx"), destino_dir)

        self.assertIsNotNone(resultado)
        self.assertEqual(resultado.name, "origem_docx_media.png")   # nome NOSSO, nao o do ZIP
        self.assertEqual(resultado.parent.resolve(), destino_dir.resolve())
        self.assertNotIn("imagem_do_remetente", str(resultado))

    def test_nao_levanta_com_arquivo_corrompido(self):
        self.assertIsNone(D.docx_largest_image(self._arquivo(b"nao sou zip"), self.tmp))


class ConstantesTest(unittest.TestCase):
    def test_tetos_sao_coerentes_entre_si(self):
        # Uma entrada isolada nunca pode ter teto maior que o do arquivo inteiro — seria uma
        # guarda inalcancavel, que passa a impressao de proteger sem proteger.
        self.assertLessEqual(D.DOCX_MAX_XML_BYTES, D.DOCX_MAX_UNCOMPRESSED_BYTES)
        self.assertLessEqual(D.DOCX_MAX_IMAGE_BYTES, D.DOCX_MAX_UNCOMPRESSED_BYTES)

    def test_media_aceita_so_o_que_o_vision_le(self):
        # Espelha `_IMAGE_MEDIA_TYPES` do extract_pdf: mandar .emf/.wmf/.svg seria gastar uma
        # chamada de API para receber erro.
        import extract_pdf as E

        aceitos = {m.group(1).lower()
                   for m in re.finditer(r"\|?(png|jpe\?g|gif|webp)", D._MEDIA_ENTRY_RE.pattern)}
        self.assertTrue(aceitos, "parser da guarda nao achou nenhuma extensao no regex")
        for ext in aceitos:
            base = ".jpg" if ext == "jpe?g" else f".{ext}"
            self.assertIn(base, E._IMAGE_MEDIA_TYPES,
                          f"docx_content aceita {base}, que o Vision nao sabe enviar")


if __name__ == "__main__":
    unittest.main()
