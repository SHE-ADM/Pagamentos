"""
test_beneficiario_final.py — regra "Beneficiário Final SEMPRE vence Beneficiário/Cedente"
(boleto securitizado): o fornecedor da conta é o BENEFICIÁRIO FINAL (credor real), não a
securitizadora/empresa de cobrança (cedente). Override determinístico em extract_pdf.
Caso de origem: ids 561/562 (MB COBRANCAS LTDA → INORGAN INDUSTRIA QUIMICA LTDA).
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))
import extract_pdf as E  # noqa: E402

# Layout REAL do boleto INORGAN (rótulo numa linha, nome+CNPJ na seguinte).
_BOLETO_REAL = (
    "Beneficiario Agencia / Codigo do Beneficiario Especie Quantidade Nosso numero\n"
    "MB COBRANCAS LTDA - CNPJ: 45.175.261/0001-80 0741/99767-0 REAL 24880967-8\n"
    "Pagador\n"
    "TEXTIL E CONFEC OTIMOTEX LTDA, CNPJ: 47.273.917/0001-23\n"
    "Beneficiario Final\n"
    "INORGAN INDUSTRIA QUIMICA LTDA, CNPJ: 56.879.838/0001-51\n"
)


class ExtractBeneficiarioFinalTest(unittest.TestCase):
    def test_layout_real_label_em_linha_propria(self):
        self.assertEqual(
            E.extract_beneficiario_final(_BOLETO_REAL),
            ("INORGAN INDUSTRIA QUIMICA LTDA", "56879838000151"),
        )

    def test_mesma_linha_com_dois_pontos(self):
        txt = "Beneficiário Final: ACME LTDA, CNPJ: 12.345.678/0001-99\n"
        self.assertEqual(E.extract_beneficiario_final(txt), ("ACME LTDA", "12345678000199"))

    def test_com_acento_e_label_cnpj_sem_dois_pontos(self):
        txt = "Benefício\nBeneficiário Final\nFOO BAR LTDA CNPJ 11.222.333/0001-44\n"
        self.assertEqual(E.extract_beneficiario_final(txt), ("FOO BAR LTDA", "11222333000144"))

    def test_sem_beneficiario_final(self):
        txt = "Beneficiario: MB COBRANCAS LTDA\nPagador: OTIMOTEX\n"
        self.assertEqual(E.extract_beneficiario_final(txt), (None, None))


class ApplyBeneficiarioFinalTest(unittest.TestCase):
    def _rec(self, **over):
        base = {"supplier_name": "MB COBRANCAS LTDA", "supplier_cnpj": "45175261000180",
                "supplier_cpf": None, "processing_notes": None}
        base.update(over)
        return base

    def test_override_nome_e_cnpj(self):
        rec = self._rec()
        E.apply_beneficiario_final(rec, _BOLETO_REAL)
        self.assertEqual(rec["supplier_name"], "INORGAN INDUSTRIA QUIMICA LTDA")
        self.assertEqual(rec["supplier_cnpj"], "56879838000151")
        self.assertIsNone(rec["supplier_cpf"])
        self.assertIn("Beneficiário Final", rec["processing_notes"])

    def test_idempotente(self):
        rec = self._rec()
        E.apply_beneficiario_final(rec, _BOLETO_REAL)
        first = dict(rec)
        E.apply_beneficiario_final(rec, _BOLETO_REAL)
        # 2ª passada não altera nome/CNPJ (já são o beneficiário final).
        self.assertEqual(rec["supplier_name"], first["supplier_name"])
        self.assertEqual(rec["supplier_cnpj"], first["supplier_cnpj"])

    def test_noop_sem_beneficiario_final(self):
        rec = self._rec(supplier_name="FOO", supplier_cnpj="11111111111111")
        E.apply_beneficiario_final(rec, "Beneficiario: FOO\nPagador: X\n")
        self.assertEqual(rec["supplier_name"], "FOO")
        self.assertEqual(rec["supplier_cnpj"], "11111111111111")
        self.assertIsNone(rec["processing_notes"])

    def test_noop_quando_rotulo_de_coluna_sem_cnpj(self):
        # "Beneficiário Final" como RÓTULO DE COLUNA no cabeçalho (BRASPRESS), sem CNPJ ao
        # lado — NÃO pode sobrescrever o fornecedor (revelado pelo backfill: 36 falsos
        # positivos). O CNPJ é o discriminador entre securitização real e rótulo de coluna.
        txt = ("Vencimento Ag./Cód. Beneficiário Final Espécie Quantidade "
               "BRASPRESS TRANSPORTES URGENTES LTDA 03/07/2026 REAL\n")
        rec = self._rec(supplier_name="BRASPRESS TRANP.", supplier_cnpj="48740351000391")
        E.apply_beneficiario_final(rec, txt)
        self.assertEqual(rec["supplier_name"], "BRASPRESS TRANP.")
        self.assertEqual(rec["supplier_cnpj"], "48740351000391")
        self.assertIsNone(rec["processing_notes"])


if __name__ == "__main__":
    unittest.main()
