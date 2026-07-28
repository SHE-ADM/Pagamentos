"""Testes de regressão para extract_pdf.py (skill pdf-contas-pagar)."""

import sys
import unittest
from datetime import datetime
from pathlib import Path

# extract_pdf vive na skill; adiciona o diretório ao path para importar.
sys.path.insert(0, str(Path(__file__).parents[1] / "skills" / "pdf-contas-pagar" / "scripts"))

import extract_pdf as e  # noqa: E402


# Codigo de barras FEBRABAN de boleto: 44 digitos, moeda '9' (pos 4), banco != '000'.
BOLETO_44 = "0019" + "0" * 40
# Chave de acesso NF-e/CT-e: 44 digitos, moeda != '9' -> NAO e boleto.
CHAVE_44 = "1234" + "0" * 40
# Linha digitavel de arrecadacao (guia/tributo/concessionaria): 48 digitos.
ARREC_48 = "8" * 48


class BoletoBarcodeOverrideTest(unittest.TestCase):
    """Boleto com PIX -> paga-se como boleto (barcode de boleto vence pix).

    Chave de acesso NF-e/CT-e (44 sem moeda '9') NAO dispara o override.
    """

    def test_is_boleto_barcode(self):
        self.assertTrue(e.is_boleto_barcode(BOLETO_44))
        self.assertTrue(e.is_boleto_barcode(ARREC_48))
        # Aceita mascara (pontos/espacos) em codigo de 44 digitos — normaliza para digitos.
        self.assertTrue(e.is_boleto_barcode("0019." + ".".join(["0000"] * 10)))
        self.assertFalse(e.is_boleto_barcode(CHAVE_44))
        for bad in (None, "", "123", "9" * 45, "9" * 46):
            self.assertFalse(e.is_boleto_barcode(bad), repr(bad))

    def test_boleto_com_pix_vira_boleto(self):
        rec = {"document_type": "pix", "payment_method": "pix", "barcode": BOLETO_44}
        got = e.apply_boleto_barcode_override(dict(rec))
        self.assertEqual(got["payment_method"], "boleto")
        self.assertEqual(got["document_type"], "boleto")

    def test_pix_puro_sem_barcode_continua_pix(self):
        rec = {"document_type": "pix", "payment_method": "pix", "barcode": None}
        got = e.apply_boleto_barcode_override(dict(rec))
        self.assertEqual(got["payment_method"], "pix")
        self.assertEqual(got["document_type"], "pix")

    def test_cte_com_chave_de_acesso_nao_muda(self):
        rec = {"document_type": "cte", "payment_method": "pix", "barcode": CHAVE_44}
        got = e.apply_boleto_barcode_override(dict(rec))
        self.assertEqual(got["payment_method"], "pix")
        self.assertEqual(got["document_type"], "cte")

    def test_guia_arrecadacao_preserva_tipo_fiscal(self):
        # Guia (48 digitos) paga em boleto: metodo vira boleto, tipo real preservado.
        rec = {"document_type": "dare", "payment_method": "pix", "barcode": ARREC_48}
        got = e.apply_boleto_barcode_override(dict(rec))
        self.assertEqual(got["payment_method"], "boleto")
        self.assertEqual(got["document_type"], "dare")

    def test_build_record_from_json_forca_boleto(self):
        data = {"document_type": "pix", "payment_method": "pix", "barcode": BOLETO_44}
        rec = e.build_record_from_json(Path("x.pdf"), data, "pdf_vision")
        self.assertEqual(rec["payment_method"], "boleto")
        self.assertEqual(rec["document_type"], "boleto")
        self.assertEqual(rec["barcode"], BOLETO_44)


class ImageAttachmentVisionTest(unittest.TestCase):
    """Anexos de IMAGEM (jpg/png/...) são lidos via Claude Vision (image_vision)."""

    def test_is_image_file_por_extensao(self):
        for ok in ("recibo.jpg", "foto.JPEG", "scan.png", "x.gif", "y.webp"):
            self.assertTrue(e._is_image_file(ok), ok)
        for no in ("boleto.pdf", "nota.xml", "arquivo.txt"):
            self.assertFalse(e._is_image_file(no), no)

    def test_vision_source_block_imagem(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            img = Path(d) / "recibo.png"
            img.write_bytes(b"\x89PNG fake bytes")
            block, src = e._vision_source_block(img)
            self.assertEqual(src, "image_vision")
            self.assertEqual(block["type"], "image")
            self.assertEqual(block["source"]["media_type"], "image/png")

    def test_vision_source_block_pdf(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            pdf = Path(d) / "boleto.pdf"
            pdf.write_bytes(b"%PDF-1.4 fake")
            block, src = e._vision_source_block(pdf)
            self.assertEqual(src, "pdf_vision")
            self.assertEqual(block["type"], "document")
            self.assertEqual(block["source"]["media_type"], "application/pdf")

    def test_build_record_dispatch_image_vision(self):
        # build_record com source=image_vision usa o caminho JSON (sem rede) e
        # preserva extraction_source — mesma rota do pdf_vision.
        raw = ('{"document_type":"recibo","amount":"172,39",'
               '"supplier_name":"CORREIOS","payment_method":"pix"}')
        rec = e.build_record(Path("recibo.jpg"), raw, "image_vision")
        self.assertEqual(rec["extraction_source"], "image_vision")
        self.assertEqual(rec["amount"], 172.39)
        self.assertEqual(rec["supplier_name"], "CORREIOS")


class FallbackInvoiceNumberTest(unittest.TestCase):
    """N documento sintetico: pagamento PIX + tipo 'outro' usa forma+valor
    (pix_R$ …); demais casos usam tipo+vencimento."""

    def test_pix_outro_usa_forma_de_pagamento_e_valor(self):
        # payment_method='pix' E document_type='outro' → 'pix_' + valor BR (minúsculo).
        self.assertEqual(
            e.fallback_invoice_number("outro", "2026-06-20", 10999.99, "pix"),
            "pix_R$ 10.999,99")
        self.assertEqual(
            e.fallback_invoice_number("outro", None, 1250, "pix"),
            "pix_R$ 1.250,00")

    def test_pix_sem_valor_cai_para_tipo_vencimento(self):
        self.assertEqual(
            e.fallback_invoice_number("outro", "2026-06-20", None, "pix"),
            "outro_200626")

    def test_tipo_definido_pago_por_pix_usa_tipo_vencimento(self):
        # Tipo real (boleto) pago via pix NÃO vira 'pix_…' — só 'outro' dispara a regra.
        self.assertEqual(
            e.fallback_invoice_number("boleto", "2026-07-10", 50.00, "pix"),
            "boleto_100726")

    def test_demais_tipos_usam_tipo_vencimento(self):
        self.assertEqual(
            e.fallback_invoice_number("boleto", "2026-07-10", 50.00),
            "boleto_100726")


class EnsureDueDateTest(unittest.TestCase):
    """Regra: vencimento ausente -> data da extracao (hoje). Ex.: CT-e sem vencimento."""

    def test_preenche_com_hoje_quando_ausente(self):
        today = datetime.now().strftime("%Y-%m-%d")
        for missing in (None, ""):
            rec, notes = {"due_date": missing}, []
            e.ensure_due_date(rec, notes)
            self.assertEqual(rec["due_date"], today)
            self.assertEqual(len(notes), 1)

    def test_mantem_vencimento_existente(self):
        rec, notes = {"due_date": "2026-07-10"}, []
        e.ensure_due_date(rec, notes)
        self.assertEqual(rec["due_date"], "2026-07-10")
        self.assertEqual(notes, [])


# Barcode REAL (MOVVI, conta 693): Bradesco 237, DV geral confere.
BARCODE_OK = "23793152500000181903391090000004370700084200"
# O mesmo com o DV (posicao 4) adulterado — leitura corrompida.
BARCODE_DV_RUIM = BARCODE_OK[:4] + ("0" if BARCODE_OK[4] != "0" else "1") + BARCODE_OK[5:]


class BarcodeDvTest(unittest.TestCase):
    """DV geral FEBRABAN (modulo 11) do codigo de barras bancario de 44 digitos.

    `barcode_dv_refuted` afirma o que consegue PROVAR: False significa NAO REFUTADO
    (o DV confere OU nao ha DV a conferir), nunca "validado".

    Medido contra os dados reais: `pdf_text` 228/228 e `email_body` 6/6 conferem — digito
    vindo do TEXTO sempre fecha, o que valida a implementacao. `pdf_vision` fecha em
    36/56: o DV discrimina com precisao a leitura corrompida por OCR.
    """

    def test_barcode_real_nao_e_refutado(self):
        self.assertFalse(e.barcode_dv_refuted(BARCODE_OK))

    def test_dv_adulterado_e_refutado(self):
        self.assertTrue(e.barcode_dv_refuted(BARCODE_DV_RUIM))

    def test_nao_se_aplica_nao_refuta(self):
        # Chave de acesso NF-e/CT-e (44 sem moeda '9'), arrecadacao (48), lixo e None:
        # a regra nao os julga — devolver True deixa a funcao servir de porta em
        # qualquer chamador sem rejeitar o que ela nao sabe avaliar.
        for valor in ("3" * 44, "8" + "1" * 47, "123", None, ""):
            with self.subTest(valor=valor):
                self.assertFalse(e.barcode_dv_refuted(valor))


class NormalizeBarcodeGuardsTest(unittest.TestCase):
    """Guardas contra codigo INVENTADO por captura frouxa — fonte UNICA, herdada pelos
    caminhos de PDF e de corpo."""

    def test_48_digitos_sem_o_8_inicial_e_rejeitado(self):
        # Invariante FEBRABAN (produto '8'): 35/35 dos barcodes de 48 digitos reais.
        self.assertIsNone(e.normalize_barcode("1" * 48))

    def test_arrecadacao_real_e_preservada(self):
        real = "8" + "1" * 47
        self.assertEqual(e.normalize_barcode(real), real)

    def test_o_padrao_valida_e_a_concessao_esta_no_nome(self):
        # Assimetria deliberada, com o padrao no lado SEGURO: captura de procedencia
        # incerta descarta (codigo colado nao e codigo de nada); quem leu o DOCUMENTO
        # preserva (e OCR errando um codigo REAL, unica chave de dedup do titulo).
        self.assertIsNone(e.normalize_barcode(BARCODE_DV_RUIM))
        self.assertEqual(e.normalize_barcode_allow_misread(BARCODE_DV_RUIM), BARCODE_DV_RUIM)
        self.assertEqual(e.normalize_barcode(BARCODE_OK), BARCODE_OK)

    def test_extract_barcode_nao_inventa_codigo_de_tabela_numerica(self):
        # Fallback FROUXO do caminho de PDF: janela de digitos SEM ancora de rotulo.
        # Numa tabela numerica ela cola numeros nao relacionados.
        tabela = "1234 5678 9012 3456 7890 1234 5678 9012 3456 7890 1234 5678"
        self.assertIsNone(e.extract_barcode(tabela))

    def test_fator_sem_data_de_referencia_usa_hoje(self):
        # Caminho `ref_date=None` -> datetime.now(timezone.utc): ficou SEM cobertura por
        # muito tempo e, na extração do módulo `febraban`, o cabeçalho escrito à mão
        # esqueceu de importar `timezone` — NameError que só apareceria em runtime.
        got = e.due_date_from_barcode(BARCODE_OK)          # sem ref_date
        self.assertEqual(got, e.due_date_from_barcode(BARCODE_OK, "2026-07-26"))
        self.assertRegex(got, r"^\d{4}-\d{2}-\d{2}$")

    def test_is_boleto_barcode_aplica_o_mesmo_invariante_do_48(self):
        # A regra vive nos DOIS pontos porque is_boleto_barcode também julga texto CRU,
        # que não passou por normalize_barcode (ex.: detecção de página pagável).
        self.assertTrue(e.is_boleto_barcode("8" + "1" * 47))
        self.assertFalse(e.is_boleto_barcode("1" * 48))
        self.assertTrue(e.is_boleto_barcode(BARCODE_OK))
        self.assertFalse(e.is_boleto_barcode("3" * 44))   # chave de acesso NF-e/CT-e

    def test_extract_barcode_ainda_le_a_linha_digitavel_real(self):
        self.assertEqual(
            e.extract_barcode("23793.39100 90000.004375 07000.842000 3 15250000018190"),
            BARCODE_OK)


if __name__ == "__main__":
    unittest.main()
