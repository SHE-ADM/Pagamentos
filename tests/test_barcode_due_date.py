"""
Vencimento AUTORITATIVO pelo FATOR DE VENCIMENTO do código de barras FEBRABAN.

Falha grave de origem (id 435): boleto OBER cujo Vision INVERTEU dia/mês do vencimento —
gravou 2026-08-07 (07/08) no lugar de 2026-07-08 (08/07). O fator de vencimento do código de
barras é DETERMINÍSTICO (o emissor o codifica) e não sofre inversão, então é a fonte de verdade.
`due_date_from_barcode` decodifica o fator (tratando o reset FEBRABAN de 22/02/2025) e
`apply_barcode_due_date` sobrescreve a data extraída se divergir.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import extract_pdf as e  # noqa: E402

# Barcode real da conta 435 (Itaú 341, fator 1501, valor 795,00) → vencimento 08/07/2026.
BC_435 = "34191150100000795001097308595621248093807000"
REF_435 = "2026-05-09"  # emissão (referência p/ desambiguar o reset da base FEBRABAN)


class DueDateFromBarcodeTest(unittest.TestCase):
    def test_fator_1501_da_08_07_2026(self):
        self.assertEqual(e.due_date_from_barcode(BC_435, REF_435), "2026-07-08")

    def test_desambiguacao_sem_ref_usa_hoje(self):
        # Com ref em 2026, a base NOVA (2026-07-08) vence a antiga (2001-11-16).
        self.assertEqual(e.due_date_from_barcode(BC_435, "2026-01-01"), "2026-07-08")

    def test_fator_zero_e_none(self):
        # fator 0000 = boleto à vista / sem vencimento.
        bc = "3419" + "0000" + "0000079500" + "1" * 25 + "0"  # 44 díg, moeda 9, fator 0000
        bc = bc[:44]
        self.assertIsNone(e.due_date_from_barcode(bc, REF_435))

    def test_nao_boleto_e_none(self):
        self.assertIsNone(e.due_date_from_barcode(None))
        self.assertIsNone(e.due_date_from_barcode(""))
        self.assertIsNone(e.due_date_from_barcode("12345"))                 # curto
        self.assertIsNone(e.due_date_from_barcode("3" * 44))                # moeda != 9
        self.assertIsNone(e.due_date_from_barcode("0" * 44))                # banco 000
        self.assertIsNone(e.due_date_from_barcode("1" * 48))               # arrecadação (48)


class ApplyBarcodeDueDateTest(unittest.TestCase):
    def _rec(self, **over):
        base = {"barcode": BC_435, "issue_date": REF_435, "due_date": None,
                "processing_notes": None}
        base.update(over)
        return base

    def test_corrige_data_invertida(self):
        rec = self._rec(due_date="2026-08-07")  # inversão dia/mês (o bug)
        self.assertTrue(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-07-08")
        self.assertIn("código de barras", rec["processing_notes"])

    def test_define_quando_ausente(self):
        rec = self._rec(due_date=None)
        self.assertTrue(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-07-08")

    def test_data_correta_nao_muda(self):
        rec = self._rec(due_date="2026-07-08")
        self.assertFalse(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-07-08")
        self.assertIsNone(rec["processing_notes"])

    def test_sem_barcode_nao_muda(self):
        rec = self._rec(barcode=None, due_date="2026-08-07")
        self.assertFalse(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-08-07")

    def test_barcode_nao_boleto_nao_muda(self):
        rec = self._rec(barcode="3" * 44, due_date="2026-08-07")  # chave NF-e (moeda != 9)
        self.assertFalse(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-08-07")


if __name__ == "__main__":
    unittest.main()
