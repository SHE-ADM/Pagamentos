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


if __name__ == "__main__":
    unittest.main()
