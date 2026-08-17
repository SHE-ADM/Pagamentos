"""Roteamento de .docx em `extract_pdf` — as tres camadas, sem rede.

Complementa `test_docx_content.py` (modulo puro): aqui o alvo e o CALL SITE — `process_pdf`
desviando o .docx antes do pdfplumber, a fonte `docx_text`/`docx_vision` chegando ao registro, e
os dois pontos que declaravam `application/pdf` para qualquer sufixo desconhecido.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import extract_pdf as E  # noqa: E402

from fixtures_docx import build_docx, docx_com_linha_digitavel, docx_so_com_imagem  # noqa: E402

_JSON_BOLETO = {
    "document_type": "boleto",
    "supplier_name": "ADVOGADO EXEMPLO",
    "amount": "1.234,56",
    "due_date": "2026-08-25",
}


class _TmpMixin(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.tmp = Path(self._td.name)
        self.addCleanup(self._td.cleanup)

    def _docx(self, dados: bytes, nome: str = "boleto.docx") -> Path:
        p = self.tmp / nome
        p.write_bytes(dados)
        return p


class RoteamentoTest(_TmpMixin):
    def test_docx_NAO_passa_por_pdfplumber_nem_descriptografia(self):
        # 🔴 WIRING. Um .docx e um ZIP: pdfplumber, `_pdf_is_encrypted` e `_payable_pages` todos
        # o abririam como PDF. Os mocks com side_effect provam a AUSENCIA de chamada — executar
        # e o que prova, ler o codigo so provaria que a linha existe (CLAUDE.md §2 item 6).
        docx = self._docx(docx_com_linha_digitavel())
        with mock.patch.object(E, "extract_with_pdfplumber",
                               side_effect=AssertionError("abriu o .docx como PDF")), \
             mock.patch.object(E, "_pdf_is_encrypted",
                               side_effect=AssertionError("checou senha de PDF num .docx")), \
             mock.patch.object(E, "_payable_pages",
                               side_effect=AssertionError("paginou um .docx como PDF")), \
             mock.patch.object(E, "extract_fields_with_claude", return_value=_JSON_BOLETO):
            recs = E.process_pdf(docx)

        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["extraction_source"], "docx_text")
        self.assertEqual(recs[0]["source_file"], "boleto.docx")

    def test_camada1_texto_com_linha_digitavel(self):
        docx = self._docx(docx_com_linha_digitavel())
        with mock.patch.object(E, "extract_fields_with_claude", return_value=_JSON_BOLETO), \
             mock.patch.object(E, "extract_with_vision",
                               side_effect=AssertionError("gastou Vision com texto suficiente")):
            recs = E.process_pdf(docx)

        self.assertEqual(recs[0]["extraction_source"], "docx_text")
        self.assertTrue(recs[0].get("barcode"), "a linha digitável do .docx não virou barcode")

    def test_camada2_imagem_embutida_vai_ao_vision_COMO_IMAGEM(self):
        # 🔴 O argumento que chega ao Vision tem de ser a IMAGEM extraida (.png), NUNCA o .docx:
        # é isso que impede o bloco `application/pdf` com bytes de ZIP. Mutante: passar o
        # próprio .docx a `extract_with_vision`.
        recebidos = []

        def _fake_vision(path):
            recebidos.append(Path(path))
            return json.dumps(_JSON_BOLETO), "image_vision"

        docx = self._docx(docx_so_com_imagem())
        with mock.patch.object(E, "extract_with_vision", side_effect=_fake_vision):
            recs = E.process_pdf(docx)

        self.assertEqual(len(recebidos), 1)
        self.assertEqual(recebidos[0].suffix, ".png")
        self.assertEqual(recs[0]["extraction_source"], "docx_vision")
        self.assertEqual(recs[0]["source_file"], "boleto.docx")

    def test_camada3_sem_pagavel_e_sem_imagem_vira_falha(self):
        docx = self._docx(build_docx([["Prezados, segue contrato para assinatura."]]))
        with mock.patch.object(E, "extract_with_vision",
                               side_effect=AssertionError("mandou prosa ao Vision")), \
             mock.patch.object(E, "extract_fields_with_claude",
                               side_effect=AssertionError("mandou prosa ao Claude")):
            recs = E.process_pdf(docx)

        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["extraction_source"], "falha")
        self.assertIn("sem instrumento de pagamento", recs[0]["processing_notes"])

    def test_docx_invalido_nao_derruba_o_lote(self):
        recs = E.process_pdf(self._docx(b"nao sou um zip"))
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["extraction_source"], "falha")

    def test_lote_inclui_docx(self):
        # Sem isto, o modo `--batch` recriaria o descarte silencioso que este trabalho fechou.
        self._docx(docx_com_linha_digitavel())
        with mock.patch.object(E, "extract_fields_with_claude", return_value=_JSON_BOLETO):
            saida = self.tmp / "out"
            saida.mkdir()
            csv = E.extract_to_csv(self.tmp, saida, batch=True)
        self.assertIsNotNone(csv, "o .docx não entrou no lote")


class BuildRecordsFonteTest(unittest.TestCase):
    def test_docx_vision_segue_o_caminho_JSON(self):
        # 🔴 `build_records` roteia JSON x texto por lista de fontes. Se `docx_vision` nao
        # estiver em VISION_SOURCES, a resposta JSON do Vision cai no parser de TEXTO — sem
        # erro, produzindo registro vazio que o pipeline leria como "documento sem valor".
        # ⚠️ A asserção tem de olhar o CONTEÚDO, não só a fonte. Medido por mutante: removendo
        # 'docx_vision' de VISION_SOURCES, o registro cai em `_build_records_text`, que ENGOLE a
        # falha do Claude e reconstrói por regex — devolvendo 1 registro que ainda carrega
        # `extraction_source='docx_vision'`. Um teste que checasse só a contagem e a fonte
        # ficaria VERDE com o defeito instalado (foi o que aconteceu na primeira versão).
        with mock.patch.object(E, "extract_fields_with_claude",
                               side_effect=AssertionError("tratou JSON como texto")):
            recs = E.build_records(Path("boleto.docx"), json.dumps(_JSON_BOLETO), "docx_vision")
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["extraction_source"], "docx_vision")
        self.assertEqual(recs[0]["supplier_name"], "ADVOGADO EXEMPLO")
        self.assertEqual(str(recs[0]["amount"]), "1234.56")

    def test_as_fontes_de_visao_estao_declaradas(self):
        self.assertIn("docx_vision", E.VISION_SOURCES)
        self.assertIn("pdf_vision", E.VISION_SOURCES)
        self.assertIn("image_vision", E.VISION_SOURCES)
        self.assertNotIn("docx_text", E.VISION_SOURCES)   # texto NAO e JSON


class VisionSourceBlockTest(_TmpMixin):
    def test_pdf_e_imagem_continuam_funcionando(self):
        pdf = self.tmp / "a.pdf"
        pdf.write_bytes(b"%PDF-1.4")
        bloco, src = E._vision_source_block(pdf)
        self.assertEqual((bloco["type"], src), ("document", "pdf_vision"))

        png = self.tmp / "a.png"
        png.write_bytes(b"\x89PNG")
        bloco, src = E._vision_source_block(png)
        self.assertEqual((bloco["type"], bloco["source"]["media_type"], src),
                         ("image", "image/png", "image_vision"))

    def test_sufixo_desconhecido_e_RECUSADO(self):
        # Antes, qualquer sufixo fora do mapa de imagens caia no bloco de PDF por default: um
        # .docx seria declarado `application/pdf` a Anthropic e voltaria 400 remoto, longe da
        # causa. Mutante: restaurar o fallback silencioso.
        for nome in ("x.docx", "x.xyz", "sem_extensao"):
            alvo = self.tmp / nome
            alvo.write_bytes(b"PK\x03\x04")
            with self.assertRaises(ValueError, msg=nome):
                E._vision_source_block(alvo)


class TryBarcodeVisionTest(_TmpMixin):
    def test_recusa_arquivo_que_nao_e_pdf_SEM_chamar_a_API(self):
        # O bloco desta funcao e `application/pdf` HARDCODED. O caminho `docx_text` passa por
        # `_build_records_text`, que a chama quando a linha digitavel nao casa — sem o guard,
        # bytes de ZIP iriam declarados como PDF. Mutante: remover o guard -> `anthropic` é
        # instanciado e o AssertionError do mock derruba o teste.
        docx = self._docx(build_docx([["sem barcode aqui"]]))
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
             mock.patch("anthropic.Anthropic",
                        side_effect=AssertionError("chamou a API com um .docx")):
            self.assertIsNone(E._try_barcode_vision(docx))


if __name__ == "__main__":
    unittest.main()
