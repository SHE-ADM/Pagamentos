"""
Testes do override de GUIA TRIBUTÁRIA pelo acrônimo no ASSUNTO
(_classify_tax_doc_type_from_subject) e sua aplicação nos dois caminhos de extração.

Origem (regressão): financial_account_control id 326, assunto "PAGAMENTO DARE - REF.
T05S1", extraído do PDF como 'gare' (o Claude confunde guias estaduais quase idênticas).
O assunto declara "DARE" — deve prevalecer sobre a classificação do PDF.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class ClassifyTaxDocTypeFromSubjectTest(unittest.TestCase):
    def test_dare_no_assunto(self):
        for txt in ("PAGAMENTO DARE - REF. T05S1", "Enc: dare estadual", "DARE SP"):
            self.assertEqual(read_emails._classify_tax_doc_type_from_subject(txt), "dare", txt)

    def test_guias_estaduais_nao_se_confundem(self):
        self.assertEqual(read_emails._classify_tax_doc_type_from_subject("PAGAMENTO GARE"), "gare")
        self.assertEqual(read_emails._classify_tax_doc_type_from_subject("ENC: GUIA GNRE"), "gnre")
        self.assertEqual(read_emails._classify_tax_doc_type_from_subject("PAGAMENTO DAE"), "dae")

    def test_outros_acronimos(self):
        casos = {
            "PAGAMENTO DARF SP": "darf",
            "Guia GPS junho": "gps",
            "GRU federal": "gru",
            "IPVA 2026": "ipva",
            "IPTU parcela": "iptu",
            "ISS a recolher": "iss",
            "ITBI compra": "itbi",
            "DUAM municipal": "dam / duam",
            "PAGAMENTO MULTA de trânsito": "multa",
        }
        for txt, esperado in casos.items():
            self.assertEqual(read_emails._classify_tax_doc_type_from_subject(txt), esperado, txt)

    def test_das_so_por_frase_inequivoca(self):
        # 'das' puro é artigo do português — NÃO pode casar (robustez contra falso positivo).
        self.assertIsNone(read_emails._classify_tax_doc_type_from_subject("PAGAMENTO DAS CONTAS"))
        self.assertIsNone(read_emails._classify_tax_doc_type_from_subject("resumo das faturas"))
        # Frase inequívoca sim.
        self.assertEqual(
            read_emails._classify_tax_doc_type_from_subject("Guia Simples Nacional"), "das")

    def test_assunto_sem_guia_retorna_none(self):
        for txt in ("Boleto fornecedor XYZ", "Nota fiscal", "PAGAMENTO PIX JOAO", None, ""):
            self.assertIsNone(read_emails._classify_tax_doc_type_from_subject(txt), txt)

    def test_acronimo_nao_casa_dentro_de_palavra(self):
        # palavra inteira: 'iss' não casa em "emissão", 'dae' não casa em "cidade".
        self.assertIsNone(read_emails._classify_tax_doc_type_from_subject("emissao de nota"))


class PdfPayloadTaxSubjectTest(unittest.TestCase):
    def test_caso_326_dare_sobrepoe_gare_do_pdf(self):
        # O PDF classificou 'gare', mas o assunto "PAGAMENTO DARE" define 'dare'.
        row = {"document_type": "gare", "amount": "105686.76", "due_date": "2026-07-01",
               "invoice_number": "260590141158705"}
        payload = read_emails.build_financial_payload(
            row, "<msg-326>", received_at="2026-07-01T10:00:00+00:00",
            subject="PAGAMENTO DARE - REF. T05S1",
        )
        self.assertEqual(payload["document_type"], "dare")
        # Não deve mexer no número já extraído.
        self.assertEqual(payload["invoice_number"], "260590141158705")

    def test_assunto_sem_guia_preserva_tipo_do_pdf(self):
        row = {"document_type": "gare", "amount": "100.00", "due_date": "2026-07-01"}
        payload = read_emails.build_financial_payload(
            row, "<msg-x>", received_at="2026-07-01T10:00:00+00:00", subject="Pagamento guia",
        )
        self.assertEqual(payload["document_type"], "gare")

    def test_utility_tem_precedencia_sobre_guia_tributaria(self):
        # Concessionária é precedência máxima; se ambos aparecerem, vence a utility.
        row = {"document_type": "boleto", "amount": "80.00", "due_date": "2026-07-01"}
        payload = read_emails.build_financial_payload(
            row, "<msg-y>", received_at="2026-07-01T10:00:00+00:00",
            subject="CONTA DE LUZ - DARE",
        )
        self.assertEqual(payload["document_type"], "conta de luz")


class BodyTaxSubjectTest(unittest.TestCase):
    def test_corpo_com_assunto_dare(self):
        # Corpo genérico, assunto declara DARE → document_type 'dare'.
        body = "Segue guia para pagamento.\nValor R$ 1.234,56\nVencimento: 10/07/2026"
        payload = read_emails.extract_from_email_body(
            body, "2026-07-01T10:00:00+00:00", "<msg-body-dare>",
            "financeiro@otimotex.com.br", subject="PAGAMENTO DARE - REF. T05S1",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["document_type"], "dare")


if __name__ == "__main__":
    unittest.main()
