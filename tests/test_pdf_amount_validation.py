"""
Regressão da validação de `amount` (F5).

A extração NUNCA deve fabricar um valor: se o JSON do Claude vier sem `amount`
(ou com valor inválido), build_record_from_json mantém amount=None. Quem rejeita
a conta sem valor é a camada de gravação (read_emails: 'Validacao 1: valor
ausente ou zero' -> registra 'sem_valor' e NÃO cria conta). Este teste trava o
contrato da camada de extração para o caso não ser duplicado lá.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import extract_pdf as e  # noqa: E402


class BuildRecordAmountTest(unittest.TestCase):
    def _data(self, **over):
        base = {
            "document_type": "boleto",
            "supplier_name": "Fornecedor X",
            "supplier_cnpj": "12345678000199",
            "invoice_number": "123",
            "due_date": "2026-07-01",
        }
        base.update(over)
        return base

    def test_amount_ausente_nao_e_fabricado(self):
        rec = e.build_record_from_json(Path("doc.pdf"), self._data(), "pdf_text")
        self.assertIsNone(rec["amount"], "amount não pode ser inventado quando ausente")

    def test_amount_invalido_vira_none(self):
        rec = e.build_record_from_json(Path("doc.pdf"), self._data(amount="abc"), "pdf_text")
        self.assertIsNone(rec["amount"])

    def test_amount_valido_e_preservado(self):
        rec = e.build_record_from_json(Path("doc.pdf"), self._data(amount="1.234,56"), "pdf_text")
        self.assertEqual(rec["amount"], 1234.56)


if __name__ == "__main__":
    unittest.main()
