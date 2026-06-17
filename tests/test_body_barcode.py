"""
Teste de unificação da normalização de barcode do CORPO do e-mail (F2).

O caminho do corpo passou a reusar a função canônica extract_pdf.normalize_barcode
(via _normalize_body_barcode), em vez de um re.sub solto que aceitava qualquer
sequência de 44-48 dígitos. Regras canônicas: 44/48 mantidos, 47 -> 44 (linha
digitável bancária FEBRABAN), outros comprimentos -> None.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class NormalizeBodyBarcodeTest(unittest.TestCase):
    def test_44_digitos_mantidos(self):
        bc = "3" * 44
        self.assertEqual(read_emails._normalize_body_barcode(bc), bc)

    def test_48_digitos_arrecadacao_mantidos(self):
        bc = "8" * 48
        self.assertEqual(read_emails._normalize_body_barcode(bc), bc)

    def test_47_digitos_convertidos_para_44(self):
        # Linha digitável bancária (47) deve virar código de barras (44).
        ld = "0" * 47
        got = read_emails._normalize_body_barcode(ld)
        self.assertIsNotNone(got)
        self.assertEqual(len(got), 44)

    def test_comprimento_invalido_retorna_none(self):
        # 45/46 dígitos NÃO são código válido — antes da unificação passavam.
        self.assertIsNone(read_emails._normalize_body_barcode("1" * 45))
        self.assertIsNone(read_emails._normalize_body_barcode("1" * 46))

    def test_remove_mascara_pontos_espacos(self):
        mascarado = "34191.79001 01043.510047 91020.150008 1 99999999999999"
        got = read_emails._normalize_body_barcode(mascarado)
        # 47 dígitos sob a máscara -> normaliza para 44.
        self.assertIsNotNone(got)
        self.assertEqual(len(got), 44)

    def test_none_e_vazio(self):
        self.assertIsNone(read_emails._normalize_body_barcode(None))
        self.assertIsNone(read_emails._normalize_body_barcode(""))


if __name__ == "__main__":
    unittest.main()
