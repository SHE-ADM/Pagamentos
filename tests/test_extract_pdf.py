"""Testes de regressão para extract_pdf.py (skill pdf-contas-pagar)."""

import sys
import unittest
from datetime import datetime
from pathlib import Path

# extract_pdf vive na skill; adiciona o diretório ao path para importar.
sys.path.insert(0, str(Path(__file__).parents[1] / "skills" / "pdf-contas-pagar" / "scripts"))

import extract_pdf as e  # noqa: E402


class ApplyPixOverrideTest(unittest.TestCase):
    """Override de pix só vale para tipo indefinido — nunca apaga um tipo fiscal.

    Regressão: um DACTE (CT-e) da Arlete Transportes virava 'pix' só porque o
    texto mencionava pix, perdendo o tipo real e o tratamento de chave/barcode.
    """

    def test_nao_sobrescreve_documento_fiscal_identificado(self):
        for dtype in ("cte", "boleto", "nfe", "nfse", "DARF"):
            rec = {"document_type": dtype, "payment_method": "pix"}
            got = e.apply_pix_override(dict(rec))["document_type"]
            self.assertEqual(got, dtype, f"{dtype} não deve virar pix")

    def test_sobrescreve_apenas_tipo_indefinido(self):
        for dtype in ("outro", ""):
            rec = {"document_type": dtype, "payment_method": "pix"}
            got = e.apply_pix_override(dict(rec))["document_type"]
            self.assertEqual(got, "pix")

    def test_sem_pix_mantem_tipo(self):
        rec = {"document_type": "outro", "payment_method": "boleto"}
        got = e.apply_pix_override(dict(rec))["document_type"]
        self.assertEqual(got, "outro")


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
    """N documento sintetico: PIX usa o valor; demais tipos usam tipo+vencimento."""

    def test_pix_usa_valor_em_moeda_br(self):
        self.assertEqual(
            e.fallback_invoice_number("pix", "2026-06-20", 10999.99),
            "PIX_R$ 10.999,99")
        self.assertEqual(
            e.fallback_invoice_number("pix", None, 1250),
            "PIX_R$ 1.250,00")

    def test_pix_sem_valor_cai_para_tipo_vencimento(self):
        self.assertEqual(
            e.fallback_invoice_number("pix", "2026-06-20", None),
            "pix_200626")

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
