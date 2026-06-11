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
