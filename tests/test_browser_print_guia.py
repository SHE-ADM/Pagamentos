"""
Guia de arrecadação impressa pelo NAVEGADOR como imagem — caso conta 1863 (05/10/2026).

DAMSP/ISS da Prefeitura de São Paulo, vencimento impresso 13/10/2026. O PDF ("Salvar como
PDF" do Chrome) tem a guia como IMAGEM; o único texto extraível é a moldura do navegador
("05/10/2026, 14:32 Usuário: …" + URL + "1/1"), ~220 chars — acima do limiar de 80. O
caminho de TEXTO mandou a moldura ao modelo, o vencimento caiu no default "data da
extração" (05/10) e o tier 2 não disparou porque o VALOR veio do código de arrecadação.

Três defesas, uma por camada:
  1. a moldura não conta como conteúdo → o PDF vai direto ao Vision;
  2. guia de arrecadação com vencimento PRESUMIDO no texto → tier 2 (rede para molduras
     que o item 1 não reconheça);
  3. código de arrecadação com DV refutado no Vision é descartado (o Vision embaralhou os
     blocos desta guia) e recuperado pela releitura dedicada da linha de 48, só se o valor
     embutido bater com o lido.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import extract_pdf as E   # noqa: E402
import febraban as F      # noqa: E402

# Texto REAL extraído pelo pdfplumber do PDF da conta 1863.
MOLDURA_CHROME = (
    "05/10/2026, 14:32 Usuário: 50.208.420/0001-36 - NF-e - Nota Fiscal Eletrônica de "
    "Serviços - São Paulo\n"
    "https://nfe.prefeitura.sp.gov.br/contribuinte/guiaprint.aspx?guia=56573525&returnurl="
    "guias.aspx%3fv%3d1%26inscricao%3d82634041%26tipo%… 1/1")

# Linha digitável REAL da guia (48 dígitos, como impressa) e o código que o Vision devolveu
# para o MESMO documento: 44 dígitos com os blocos embaralhados.
DAMSP_48 = "818300000000796657012610013020056577352500299678"
DAMSP_EMBARALHADO = "81836577352500299670000000796657016100130200"
DAMSP_VALOR = 79.66
DAMSP_VENCIMENTO = "2026-10-13"

BOLETO_BANCARIO = "23792152400000502400289090000010602503122940"


def _json_visual(**over):
    base = {"document_type": "iss", "amount": DAMSP_VALOR, "due_date": DAMSP_VENCIMENTO,
            "barcode": DAMSP_EMBARALHADO,
            "supplier_name": "PREFEITURA DO MUNICIPIO DE SAO PAULO"}
    base.update(over)
    return json.dumps(base)


def _pdfplumber_com_texto(texto):
    """`pdfplumber.open` simulado: um PDF de uma página cujo texto é `texto`."""
    pagina = mock.Mock()
    pagina.extract_text.return_value = texto
    pdf = mock.MagicMock()
    pdf.__enter__.return_value.pages = [pagina]
    return mock.Mock(return_value=pdf)


class PremissasTest(unittest.TestCase):
    """Os fatos sobre os códigos que os testes abaixo assumem."""

    def test_codigo_real_fecha_e_o_embaralhado_e_refutado(self):
        self.assertFalse(F.arrecadacao_dv_refuted(DAMSP_48))
        self.assertAlmostEqual(F.amount_from_arrecadacao(DAMSP_48), DAMSP_VALOR, places=2)
        self.assertTrue(F.arrecadacao_dv_refuted(DAMSP_EMBARALHADO))
        # A 1ª barreira do visual NÃO o pegava: é por isso que ele seria gravado.
        self.assertFalse(F.barcode_dv_refuted(DAMSP_EMBARALHADO))


class MolduraDoNavegadorTest(unittest.TestCase):

    def test_moldura_sozinha_nao_e_conteudo(self):
        self.assertGreaterEqual(len(MOLDURA_CHROME), E.MIN_CONTENT_TEXT_CHARS)  # o bug
        self.assertLess(E.content_text_len(MOLDURA_CHROME), E.MIN_CONTENT_TEXT_CHARS)

    def test_conteudo_real_sobrevive_a_remocao_da_moldura(self):
        """Sanidade do parser: a remoção é por LINHA de moldura, não apaga o documento."""
        corpo = ("PREFEITURA DO MUNICÍPIO DE SÃO PAULO\nVencimento 13/10/2026\n"
                 "Valor (R$) 79,66\nReceita ISS incidente sobre Notas Fiscais de Serviços\n")
        medido = E.content_text_len(MOLDURA_CHROME + "\n" + corpo)
        self.assertEqual(medido, len(corpo.strip()))

    def test_variantes_de_moldura(self):
        for linha in ("5/10/26, 2:32 PM Guia", "05/10/2026 14:32:07", "file:///C:/x.html",
                      "https://a.b/c 2/3", "Página 1 de 2", "1/1", "page 1 of 2"):
            with self.subTest(linha=linha):
                self.assertEqual(E.content_text_len(linha), 0)

    def test_linha_de_conteudo_com_data_sem_hora_nao_e_moldura(self):
        self.assertGreater(E.content_text_len("13/10/2026 79,66"), 0)

    def test_competencia_e_data_parcial_isoladas_nao_sao_contador(self):
        """'N/M' só é contador com 1 <= N <= M e até 3 dígitos: competência e dia/mês ficam."""
        for linha in ("09/2026", "12/10", "0/1", "https://a.b/c 13/10"):
            with self.subTest(linha=linha):
                self.assertGreater(E.content_text_len(linha), 0)

    def test_is_scanned_pdf_trata_impressao_do_navegador_como_scan(self):
        with mock.patch.object(E.pdfplumber, "open", _pdfplumber_com_texto(MOLDURA_CHROME)):
            self.assertTrue(E.is_scanned_pdf(Path("guia.pdf")))

    def test_is_scanned_pdf_mantem_pdf_digital_no_texto(self):
        texto = MOLDURA_CHROME + "\n" + "Linha de conteúdo do documento financeiro. " * 3
        with mock.patch.object(E.pdfplumber, "open", _pdfplumber_com_texto(texto)):
            self.assertFalse(E.is_scanned_pdf(Path("guia.pdf")))


class GuiaImpressaComoImagemTest(unittest.TestCase):
    """Executa `_extract_records` — a função de topo — com o `is_scanned_pdf` REAL."""

    def _extrair(self, releitura):
        claude_texto = mock.Mock(side_effect=AssertionError("moldura não vai ao modelo de texto"))
        with mock.patch.object(E.pdfplumber, "open", _pdfplumber_com_texto(MOLDURA_CHROME)), \
                mock.patch.object(E, "extract_fields_with_claude", claude_texto), \
                mock.patch.object(E, "extract_with_vision",
                                  return_value=(_json_visual(), "pdf_vision")), \
                mock.patch.object(E, "_try_barcode_vision", return_value=releitura) as rel:
            recs = E._extract_records(Path("guia.pdf"))
        return recs, rel

    def test_vencimento_impresso_e_codigo_recuperado(self):
        recs, rel = self._extrair(DAMSP_48)
        self.assertEqual(len(recs), 1)
        rec = recs[0]
        self.assertEqual(rec["extraction_source"], "pdf_vision")
        self.assertEqual(rec["due_date"], DAMSP_VENCIMENTO)
        self.assertNotIn(E.DUE_DATE_ABSENT_NOTE, rec.get("processing_notes") or "")
        self.assertEqual(rec["barcode"], DAMSP_48)
        self.assertFalse(F.barcode_was_discarded(rec.get("processing_notes")))
        rel.assert_called_once()

    def test_releitura_falha_codigo_fica_descartado_e_marcado(self):
        recs, _ = self._extrair(None)
        rec = recs[0]
        self.assertEqual(rec["due_date"], DAMSP_VENCIMENTO)
        self.assertIsNone(rec["barcode"])                 # nunca grava o embaralhado
        self.assertTrue(F.barcode_was_discarded(rec.get("processing_notes")))

    def test_releitura_com_valor_divergente_nao_e_adotada(self):
        # Outro código de arrecadação válido (GNRE real, R$ 47,51): valor ≠ 79,66.
        recs, _ = self._extrair("858800000008475100902623120120260736170318519000")
        self.assertIsNone(recs[0]["barcode"])


class DescarteArrecadacaoVisualTest(unittest.TestCase):

    def test_build_vision_descarta_arrecadacao_refutada(self):
        recs = E.build_records(Path("g.pdf"), _json_visual(), "pdf_vision")
        self.assertIsNone(recs[0]["barcode"])
        self.assertIn(E.ARRECADACAO_DV_DISCARD_REASON, recs[0]["processing_notes"])

    def test_build_vision_preserva_arrecadacao_integra(self):
        recs = E.build_records(Path("g.pdf"), _json_visual(barcode=DAMSP_48), "pdf_vision")
        self.assertEqual(recs[0]["barcode"], DAMSP_48)

    def test_imagem_anexada_recupera_o_codigo(self):
        """`_extract_image` (topo do caminho image_vision) também relê a linha de 48."""
        with mock.patch.object(E, "extract_with_vision",
                               return_value=(_json_visual(), "image_vision")), \
                mock.patch.object(E, "_try_barcode_vision", return_value=DAMSP_48) as rel:
            recs = E._extract_image(Path("guia.jpg"))
        rel.assert_called_once_with(Path("guia.jpg"))
        self.assertEqual(recs[0]["barcode"], DAMSP_48)
        self.assertEqual(recs[0]["due_date"], DAMSP_VENCIMENTO)

    def test_docx_com_imagem_recupera_o_codigo_enquanto_o_temporario_existe(self):
        """No .docx a releitura recebe a IMAGEM embutida — e ela precisa existir na hora."""
        vista = {}

        def _imagem(_docx, td):
            img = Path(td) / "image1.png"
            img.write_bytes(b"png")
            return img

        def _releitura(path):
            vista["existia"] = Path(path).exists()
            return DAMSP_48

        with mock.patch.object(E, "docx_text", return_value=""), \
                mock.patch.object(E, "docx_largest_image", side_effect=_imagem), \
                mock.patch.object(E, "extract_with_vision",
                                  return_value=(_json_visual(), "image_vision")), \
                mock.patch.object(E, "_try_barcode_vision", side_effect=_releitura):
            recs = E._extract_docx(Path("guia.docx"))
        self.assertTrue(vista.get("existia"), "releitura não rodou ou o temporário já sumira")
        self.assertEqual(recs[0]["barcode"], DAMSP_48)
        self.assertEqual(recs[0]["extraction_source"], "docx_vision")

    def test_releitura_dedicada_aceita_imagem_e_recusa_docx(self):
        """O bloco sai de `_vision_source_block` — imagem vira bloco `image`; .docx nem chama."""
        cliente = mock.Mock()
        cliente.messages.create.return_value.content = [mock.Mock(text=DAMSP_48)]
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "x"}), \
                mock.patch("anthropic.Anthropic", return_value=cliente), \
                mock.patch.object(E, "_vision_source_block",
                                  return_value=({"type": "image"}, "image_vision")) as blk:
            self.assertEqual(E._try_barcode_vision(Path("guia.png")), DAMSP_48)
            self.assertIsNone(E._try_barcode_vision(Path("guia.docx")))
        blk.assert_called_once_with(Path("guia.png"))
        conteudo = cliente.messages.create.call_args.kwargs["messages"][0]["content"]
        self.assertEqual(conteudo[0], {"type": "image"})

    def test_releitura_so_roda_para_descarte_de_arrecadacao(self):
        recs = E.build_records(Path("g.pdf"), _json_visual(barcode=DAMSP_48), "pdf_vision")
        with mock.patch.object(E, "_try_barcode_vision") as rel:
            self.assertFalse(E._recover_arrecadacao_barcode(Path("g.pdf"), recs))
        rel.assert_not_called()


class Tier2VencimentoTest(unittest.TestCase):
    """Rede para moldura NÃO reconhecida: o texto passou do limiar, mas não trouxe a guia."""

    TEXTO = ("Relatório de impressão gerado pelo portal do contribuinte municipal — "
             "documento de arrecadação anexo em imagem, sem campos em texto.\n")

    def _extrair(self, visual, barcode_texto=DAMSP_48):
        with mock.patch.object(E, "is_scanned_pdf", return_value=False), \
                mock.patch.object(E, "extract_with_pdfplumber",
                                  return_value=(self.TEXTO, "pdf_text")), \
                mock.patch.object(E, "extract_fields_with_claude",
                                  return_value={"document_type": "nfse", "amount": None,
                                                "due_date": None}), \
                mock.patch.object(E, "_try_barcode_vision", return_value=barcode_texto), \
                mock.patch.object(E, "extract_with_vision",
                                  return_value=(visual, "pdf_vision")) as vis:
            recs = E._extract_records(Path("guia.pdf"))
        return recs, vis

    def test_guia_sem_data_no_texto_vai_ao_vision_e_herda_o_codigo_do_texto(self):
        recs, vis = self._extrair(_json_visual(barcode=None))
        vis.assert_called_once()
        self.assertEqual(recs[0]["due_date"], DAMSP_VENCIMENTO)
        self.assertEqual(recs[0]["barcode"], DAMSP_48)
        self.assertFalse(F.barcode_was_discarded(recs[0].get("processing_notes")))

    def test_vision_tambem_sem_data_mantem_o_texto(self):
        recs, _ = self._extrair(_json_visual(due_date=None, barcode=None))
        self.assertEqual(recs[0]["extraction_source"], "pdf_text")
        self.assertEqual(recs[0]["barcode"], DAMSP_48)

    def test_boleto_bancario_nao_dispara_tier2_de_vencimento(self):
        """Boleto bancário tem fator: a data sai do código, não há Vision extra a pagar."""
        recs, vis = self._extrair(_json_visual(), barcode_texto=BOLETO_BANCARIO)
        vis.assert_not_called()
        self.assertEqual(recs[0]["extraction_source"], "pdf_text")

    def test_guia_DIGITAL_com_data_limite_no_texto_nao_chama_o_vision(self):
        """A marca "Vencimento ausente" sobrevive à correção feita pelo próprio texto (o modelo
        não devolveu `due_date`, o regex da data-limite deu 31/07). Isso não pode disparar o
        tier 2b: seria um Vision pago trocando um registro já correto."""
        texto = ("GUIA NACIONAL DE RECOLHIMENTO - GNRE\n"
                 "Documento Válido para pagamento 31/07/2026\n"
                 "Contribuinte OTIMOTEX TECIDOS LTDA inscricao estadual 1234567890\n")
        gnre = "858800000008475100902623120120260736170318519000"
        with mock.patch.object(E, "is_scanned_pdf", return_value=False), \
                mock.patch.object(E, "extract_with_pdfplumber", return_value=(texto, "pdf_text")), \
                mock.patch.object(E, "extract_fields_with_claude",
                                  return_value={"document_type": "GNRE", "amount": 47.51,
                                                "due_date": None}), \
                mock.patch.object(E, "_try_barcode_vision", return_value=gnre), \
                mock.patch.object(E, "extract_with_vision") as vis:
            recs = E._extract_records(Path("gnre.pdf"))
        self.assertEqual(recs[0]["due_date"], "2026-07-31")
        vis.assert_not_called()
        self.assertEqual(recs[0]["extraction_source"], "pdf_text")
        # A marca de presunção sai junto: a data passou a ser LIDA do documento.
        self.assertNotIn(E.DUE_DATE_ABSENT_NOTE, recs[0]["processing_notes"] or "")

    def test_rotulo_vencimento_no_texto_retira_a_marca_de_presuncao(self):
        """O3 pelo outro call site (`apply_text_due_date`, rótulo "Vencimento")."""
        rec = {"due_date": "2026-10-06", "issue_date": None, "barcode": None,
               "processing_notes": f"{E.DUE_DATE_ABSENT_NOTE} | outra nota"}
        self.assertTrue(E.apply_text_due_date(rec, "Vencimento 13/10/2026"))
        self.assertEqual(rec["due_date"], "2026-10-13")
        self.assertEqual(rec["processing_notes"], "outra nota")

    def test_fator_do_boleto_retira_a_marca_de_presuncao(self):
        """O3 pelo terceiro call site (`apply_barcode_due_date`): presumida a >60 dias do
        fator ⇒ o fator vence (31/07/2026) e a marca "usando data da extração" sai."""
        rec = {"due_date": "2026-12-01", "issue_date": None, "amount": 502.40,
               "barcode": BOLETO_BANCARIO, "document_type": "boleto",
               "processing_notes": E.DUE_DATE_ABSENT_NOTE}
        self.assertTrue(E.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-07-31")
        self.assertNotIn(E.DUE_DATE_ABSENT_NOTE, rec["processing_notes"])

    def test_marca_obsoleta_com_data_no_texto_nao_dispara(self):
        """Segunda trava, independente da limpeza da marca: com data determinística no TEXTO
        o tier 2b não dispara nem que a marca tenha sobrado (ex.: data implausível)."""
        rec = {"amount": 47.51, "barcode": DAMSP_48,
               "processing_notes": E.DUE_DATE_ABSENT_NOTE}
        self.assertEqual(E._text_read_incomplete(rec, "Texto sem data"), "vencimento")
        self.assertIsNone(E._text_read_incomplete(rec, "Vencimento 13/10/2026"))
        self.assertIsNone(E._text_read_incomplete(
            rec, "Documento Válido para pagamento 31/07/2026"))

    def test_motivos(self):
        self.assertEqual(E._text_read_incomplete({"amount": None}), "valor")
        self.assertEqual(E._text_read_incomplete(
            {"amount": 1.0, "barcode": DAMSP_48,
             "processing_notes": E.DUE_DATE_ABSENT_NOTE}), "vencimento")
        self.assertIsNone(E._text_read_incomplete(
            {"amount": 1.0, "barcode": DAMSP_48, "processing_notes": None}))


if __name__ == "__main__":
    unittest.main()
