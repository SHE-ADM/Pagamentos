"""
Testes para extracao de conta a partir de corpo SO-HTML + mapa de remetente.

Caso Correios: e-mail sem anexo extraivel (link de portal HTML falha) mas com
todos os campos no corpo HTML. get_body_text() volta vazio; _html_to_text
recupera o conteudo e extract_from_email_body gera a conta:
  - fornecedor = "Correios" (mapa por dominio do remetente)
  - numero do documento = numero da fatura ("Fatura nº: 3918439")
  - valor = "Valor da fatura R$ 1.530,47"
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

_CORREIOS_HTML = (
    "<html><body><p>Email Correios</p>"
    "<div>Informamos que o pagamento da fatura abaixo relacionada foi realizado com sucesso.</div>"
    "<table><tr><td>Fatura n&ordm;: 3918439</td></tr>"
    "<tr><td>M&ecirc;s de emiss&atilde;o: 05/2026</td></tr>"
    "<tr><td>Valor da fatura R$ 1.530,47</td></tr></table></body></html>"
)


class HtmlToTextTest(unittest.TestCase):
    def test_remove_tags_desescapa_e_preserva_campos(self):
        txt = R._html_to_text(_CORREIOS_HTML)
        self.assertIn("Fatura nº: 3918439", txt)
        self.assertIn("R$ 1.530,47", txt)
        self.assertNotIn("<", txt)

    def test_html_vazio(self):
        self.assertEqual(R._html_to_text(""), "")


class SupplierFromSenderTest(unittest.TestCase):
    def test_correios(self):
        self.assertEqual(R._supplier_from_sender("noreply_componentes@correios.com.br"), "Correios")

    def test_subdominio_correios(self):
        self.assertEqual(R._supplier_from_sender("x@mail.correios.com.br"), "Correios")

    def test_desconhecido(self):
        self.assertIsNone(R._supplier_from_sender("alguem@empresa.com.br"))


class CorreiosBodyExtractionTest(unittest.TestCase):
    def test_gera_conta_do_corpo_html(self):
        body = R._html_to_text(_CORREIOS_HTML)
        p = R.extract_from_email_body(
            body, "2026-06-03T19:00:00+00:00", "<x@correios>",
            sender_email="noreply_componentes@correios.com.br")
        self.assertIsNotNone(p)
        self.assertEqual(p["supplier_name"], "Correios")
        self.assertEqual(p["amount"], 1530.47)
        self.assertEqual(p["invoice_number"], "3918439")
        # Item 1: tipo do documento = fatura.
        self.assertEqual(p["document_type"], "fatura")
        # Item 2: grava SEMPRE 'pendente' — a baixa/atualizacao do status e do usuario,
        # mesmo quando o corpo diz "pagamento ... realizado com sucesso".
        self.assertEqual(p["status"], "pendente")


if __name__ == "__main__":
    unittest.main()
