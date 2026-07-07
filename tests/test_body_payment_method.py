"""
Forma de pagamento DECLARADA no corpo do e-mail → financial_account_control.payment_method.

Regra de negócio (pedido do usuário): quando o corpo declara como foi/será pago, capturar a
forma em `payment_method` em vez de gravar 'outro'. Ex.: "PAGAMENTO EM DINHEIRO" → 'dinheiro'
(caso de origem: id 442, MANOS DOCES, R$ 182,49). PIX e boleto (código de barras) têm
tratamento próprio e precedência; esta regra só preenche o que cairia em 'outro'.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class ClassifyBodyPaymentMethodTest(unittest.TestCase):
    def test_dinheiro(self):
        self.assertEqual(read_emails._classify_body_payment_method("PAGAMENTO EM DINHEIRO"), "dinheiro")
        self.assertEqual(read_emails._classify_body_payment_method("Pago dinheiro"), "dinheiro")

    def test_deposito_com_acento(self):
        self.assertEqual(read_emails._classify_body_payment_method("Pagamento depósito"), "depósito")
        self.assertEqual(read_emails._classify_body_payment_method("pago deposito"), "depósito")

    def test_pix(self):
        self.assertEqual(read_emails._classify_body_payment_method("pagamento via pix"), "pix")

    def test_cheque_ted_transferencia(self):
        self.assertEqual(read_emails._classify_body_payment_method("pagamento em cheque"), "cheque")
        self.assertEqual(read_emails._classify_body_payment_method("pago via TED"), "ted")
        self.assertEqual(read_emails._classify_body_payment_method("transferência bancária"), "transferência")

    def test_credito_debito_vencem_cartao(self):
        # 'cartão de crédito' → crédito (mais específico), não 'cartão'.
        self.assertEqual(read_emails._classify_body_payment_method("no cartão de crédito"), "crédito")
        self.assertEqual(read_emails._classify_body_payment_method("no cartão de débito"), "débito")
        self.assertEqual(read_emails._classify_body_payment_method("pago no cartão"), "cartão")

    def test_sem_forma_declarada_none(self):
        self.assertIsNone(read_emails._classify_body_payment_method("Valor R$ 100,00"))
        self.assertIsNone(read_emails._classify_body_payment_method(""))
        self.assertIsNone(read_emails._classify_body_payment_method(None))

    def test_nao_casa_substring(self):
        # 'documento' não deve casar 'doc'; palavra inteira apenas.
        self.assertIsNone(read_emails._classify_body_payment_method("segue o documento anexo"))

    def test_corpo_tem_precedencia_sobre_assunto(self):
        self.assertEqual(
            read_emails._classify_body_payment_method("pagamento em dinheiro", "PAGAMENTO PIX"),
            "dinheiro",
        )

    def test_corpo_ted_vence_assunto_pix(self):
        # id 325: corpo declara TED (conta específica); assunto diz PIX (mislabel) → corpo vence.
        self.assertEqual(
            read_emails._classify_body_payment_method(
                "NOME: RICARDO\r\nTED AGÊNCIA 1767 CONTA CORRENTE 48815-1", "PAGAMENTO PIX RICARDO"),
            "ted",
        )

    def test_debito_automatico_valor_proprio(self):
        # 'Débito Automático' é valor próprio do enum (não colapsa em 'débito' de cartão).
        self.assertEqual(
            read_emails._classify_body_payment_method("Tipo de pagamento: Débito Automático"),
            "débito automático")
        # 'cartão de débito' continua em 'débito' (cartão-débito), não em 'débito automático'.
        self.assertEqual(read_emails._classify_body_payment_method("pago no cartão de débito"), "débito")

    def test_vale(self):
        self.assertEqual(read_emails._classify_body_payment_method("pagamento em vale"), "vale")
        self.assertEqual(read_emails._classify_body_payment_method("vale refeição"), "vale")


class ExtractFromBodyPaymentMethodTest(unittest.TestCase):
    def _extract(self, body, subject="PAGAMENTO - FORNECEDOR X"):
        return read_emails.extract_from_email_body(
            body, "2026-07-07T10:00:00", "<msg-pay@test>", subject=subject)

    def test_id442_dinheiro(self):
        # Corpo real do id 442.
        body = "NOME MANOS DOCES\r\n\r\nVALOR R$ 182,49\r\n\r\nPAGAMENTO EM DINHEIRO"
        rec = self._extract(body, subject="PAGAMENTO - MANOS DOCES")
        self.assertIsNotNone(rec)
        self.assertEqual(rec["payment_method"], "dinheiro")

    def test_deposito_no_corpo(self):
        body = "Fornecedor: Padaria Y\r\nValor R$ 50,00\r\nPago depósito"
        rec = self._extract(body)
        self.assertEqual(rec["payment_method"], "depósito")

    def test_pix_mantem_precedencia(self):
        body = "Fornecedor: Loja Z\r\nValor R$ 90,00\r\nPagamento via PIX"
        rec = self._extract(body)
        self.assertEqual(rec["payment_method"], "pix")

    def test_sem_forma_fica_outro(self):
        body = "Fornecedor: Loja W\r\nValor R$ 30,00"
        rec = self._extract(body)
        self.assertEqual(rec["payment_method"], "outro")


if __name__ == "__main__":
    unittest.main()
