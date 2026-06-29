"""
Testes para _extract_body_installments (read_emails.py).

Regra de negócio coberta (NÃO regredir): quando o corpo do e-mail lista MÚLTIPLOS
boletos/parcelas com documentos/vencimentos diferentes, o pipeline deve criar UMA
conta por boleto — NUNCA uma conta somada com o total. Esta função detecta a tabela.

Formato real (OBER): o webmail quebra cada campo em uma linha (\r):
  Documento  Parcela  Emissão  Vencimento  Valor  Dias
  963901  001  19/06/2026  19/07/2026  R$ 463,19  25
  963901  002  19/06/2026  18/08/2026  R$ 463,2   55
  963901  003  19/06/2026  17/09/2026  R$ 463,21  85
  Total  R$ 1.389,60
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Corpo real (OBER) com os campos quebrados por \r, como chega do webmail.
OBER_BODY = (
    "Prezado(a)  TEXTIL E CONFECCOES OTIMOTEX LTDA\r"
    "  Segue(m) em anexo o(s) boleto(s) de cobrança referente(s) aos títulos listados abaixo.\r"
    "  Documento \r  Parcela \r  Emissão \r  Vencimento \r  Valor \r  Dias \r"
    "  963901 \r  001 \r  19/06/2026 \r  19/07/2026 \r  R$ 463,19 \r  25 \r"
    "  963901 \r  002 \r  19/06/2026 \r  18/08/2026 \r  R$ 463,2 \r  55 \r"
    "  963901 \r  003 \r  19/06/2026 \r  17/09/2026 \r  R$ 463,21 \r  85 \r"
    "  Total \r  R$ 1.389,60 \r"
)


class TestExtractBodyInstallments(unittest.TestCase):
    def test_detecta_tres_parcelas(self):
        rows = read_emails._extract_body_installments(OBER_BODY)
        self.assertEqual(len(rows), 3)

    def test_valores_vencimentos_corretos(self):
        rows = read_emails._extract_body_installments(OBER_BODY)
        self.assertEqual([r["parcela"] for r in rows], ["001", "002", "003"])
        self.assertEqual([r["amount"] for r in rows], [463.19, 463.2, 463.21])
        self.assertEqual(
            [r["due_date"] for r in rows],
            ["2026-07-19", "2026-08-18", "2026-09-17"],
        )
        self.assertTrue(all(r["doc"] == "963901" for r in rows))
        self.assertTrue(all(r["issue_date"] == "2026-06-19" for r in rows))

    def test_nao_inclui_linha_total(self):
        # A soma das parcelas (1389.60) NUNCA pode aparecer como uma linha.
        rows = read_emails._extract_body_installments(OBER_BODY)
        self.assertNotIn(1389.6, [r["amount"] for r in rows])
        self.assertEqual(round(sum(r["amount"] for r in rows), 2), 1389.60)

    def test_corpo_sem_tabela_retorna_vazio(self):
        body = "Segue boleto. Valor: R$ 297,08 + R$ 6,96  Total: R$ 304,04  Venc 10/07/2026"
        self.assertEqual(read_emails._extract_body_installments(body), [])

    def test_uma_unica_parcela_nao_dispara(self):
        body = "963901 \r 001 \r 19/06/2026 \r 19/07/2026 \r R$ 463,19 \r 25 \r"
        self.assertEqual(read_emails._extract_body_installments(body), [])

    def test_mesmo_vencimento_e_doc_nao_dispara(self):
        # Duas linhas idênticas em doc/parcela e vencimento → não é conjunto de
        # parcelas distintas (cai no caminho de valor único/total).
        body = (
            "963901 \r 001 \r 19/06/2026 \r 19/07/2026 \r R$ 463,19 \r 25 \r"
            "963901 \r 001 \r 19/06/2026 \r 19/07/2026 \r R$ 463,19 \r 25 \r"
        )
        self.assertEqual(read_emails._extract_body_installments(body), [])


if __name__ == "__main__":
    unittest.main()
