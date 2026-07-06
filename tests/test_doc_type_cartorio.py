"""
Testes do override de CARTÓRIO pelo contexto do ASSUNTO/FORNECEDOR
(_apply_cartorio_doc_type) e sua aplicação nos dois caminhos de extração.

Origem: financial_account_control id 400, assunto "PAGAMENTO CARTORIO Serviços
prestados no mês de Junho/2026", extraído do PDF como 'boleto' (tem código de barras
de boleto válido). O assunto declara "CARTORIO" — deve virar document_type='cartório'.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class ApplyCartorioDocTypeTest(unittest.TestCase):
    def test_assunto_cartorio_relabela_generico(self):
        for tipo in ("boleto", "outro", "pix", ""):
            self.assertEqual(
                read_emails._apply_cartorio_doc_type(tipo, "PAGAMENTO CARTORIO Junho/2026", None),
                "cartório", tipo)

    def test_cartorio_com_acento_no_assunto(self):
        self.assertEqual(
            read_emails._apply_cartorio_doc_type("boleto", "Custas de cartório", None), "cartório")

    def test_tabelionato_e_tabeliao(self):
        self.assertEqual(
            read_emails._apply_cartorio_doc_type("boleto", "Pagamento tabelionato de notas", None),
            "cartório")
        self.assertEqual(
            read_emails._apply_cartorio_doc_type("boleto", None, "2 TABELIAO DE PROTESTO SP"),
            "cartório")

    def test_preserva_tipo_especifico(self):
        # ITBI pago no cartório continua ITBI (só tipos genéricos são re-rotulados).
        self.assertEqual(
            read_emails._apply_cartorio_doc_type("itbi", "PAGAMENTO CARTORIO ITBI", None), "itbi")
        self.assertEqual(
            read_emails._apply_cartorio_doc_type("cte", "cartorio transportadora", None), "cte")

    def test_sem_contexto_cartorio_preserva(self):
        self.assertEqual(
            read_emails._apply_cartorio_doc_type("boleto", "Boleto fornecedor XYZ", None), "boleto")

    def test_nao_casa_dentro_de_palavra(self):
        # palavra inteira: não deve casar num termo que apenas contenha a substring.
        self.assertEqual(
            read_emails._apply_cartorio_doc_type("boleto", "cartorial de teste", None), "boleto")

    def test_idempotente(self):
        self.assertEqual(
            read_emails._apply_cartorio_doc_type("cartório", "PAGAMENTO CARTORIO", None), "cartório")


class PdfPayloadCartorioTest(unittest.TestCase):
    def test_caso_400_boleto_vira_cartorio(self):
        # Reproduz o id 400: PDF classificou 'boleto', assunto "PAGAMENTO CARTORIO".
        row = {"document_type": "boleto", "amount": "54.68", "due_date": "2026-07-10",
               "invoice_number": "09/61/840000021-9",
               "barcode": "23798150300000054680054096184000002100032970"}
        payload = read_emails.build_financial_payload(
            row, "<msg-400>", received_at="2026-06-30T10:00:00+00:00",
            subject="PAGAMENTO CARTORIO Serviços prestados no mês de Junho/2026",
        )
        self.assertEqual(payload["document_type"], "cartório")
        # Não deve mexer no número já extraído.
        self.assertEqual(payload["invoice_number"], "09/61/840000021-9")

    def test_assunto_sem_cartorio_preserva(self):
        row = {"document_type": "boleto", "amount": "100.00", "due_date": "2026-07-01"}
        payload = read_emails.build_financial_payload(
            row, "<msg-x>", received_at="2026-07-01T10:00:00+00:00", subject="Boleto fornecedor",
        )
        self.assertEqual(payload["document_type"], "boleto")


class BodyCartorioTest(unittest.TestCase):
    def test_corpo_com_assunto_cartorio(self):
        body = "Segue custa para pagamento.\nValor R$ 54,68\nVencimento: 10/07/2026"
        payload = read_emails.extract_from_email_body(
            body, "2026-06-30T10:00:00+00:00", "<msg-body-cartorio>",
            "financeiro@otimotex.com.br", subject="PAGAMENTO CARTORIO Junho/2026",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["document_type"], "cartório")


if __name__ == "__main__":
    unittest.main()
