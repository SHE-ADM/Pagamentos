"""
Testes dos tipos de conta de concessionaria (agua/luz/telefone-internet) e da
captura do numero de documento pelo rotulo "Número do documento" no corpo.

Origem: financial_account_control id 171 (assunto "PAGAMENTO CONTA DE ÁGUA",
fornecedor Sabesp) ficou com document_type='outro' e invoice_number='outro_010726'
mesmo havendo "Número do documento: SOR202659903949" no corpo.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


# Corpo real (resumido) do caso 171.
AGUA_BODY = (
    "Fornecedor: Sabesp\r\n"
    "CNPJ: 43.776.517/0001-80\r\n\r\n"
    "Número do documento: SOR202659903949\r\n\r\n"
    "Valor: R$ 163,96\r\n\r\n"
    "Data de emissão: 22/06/2026\r\n"
    "Data de vencimento: 01/07/2026\r\n\r\n"
    "Tipo de pagamento: Débito Automático"
)


class ClassifyUtilityDocTypeTest(unittest.TestCase):
    def test_agua_com_e_sem_de_e_acento(self):
        for txt in ("PAGAMENTO CONTA DE ÁGUA", "conta agua", "Conta de Agua", "CONTA ÁGUA"):
            self.assertEqual(read_emails._classify_utility_doc_type(txt), "conta de água", txt)

    def test_luz_com_e_sem_de(self):
        for txt in ("PAGAMENTO CONTA DE LUZ", "conta luz"):
            self.assertEqual(read_emails._classify_utility_doc_type(txt), "conta de luz", txt)

    def test_telefone_internet_todas_as_variantes(self):
        for txt in ("conta de telefone", "conta telefone", "conta vivo", "vivo conta",
                    "conta de internet", "conta internet", "Fatura Vivo", "internet fibra"):
            self.assertEqual(
                read_emails._classify_utility_doc_type(txt),
                "conta de telefone / internet", txt,
            )

    def test_nao_utility_retorna_none(self):
        for txt in ("Boleto fornecedor XYZ", "minha conta corrente", "DARF do mês",
                    "Nota fiscal de serviço"):
            self.assertIsNone(read_emails._classify_utility_doc_type(txt), txt)

    def test_combina_assunto_e_corpo(self):
        # A frase pode estar no assunto OU no corpo; ambos alimentam a classificação.
        self.assertEqual(
            read_emails._classify_utility_doc_type("Pagamento", "favor pagar a conta de luz"),
            "conta de luz",
        )


class ClassifyUtilityBySupplierTest(unittest.TestCase):
    def test_luz_por_marca(self):
        for name in ("Enel", "ENEL DISTRIBUIÇÃO SP", "Eletropaulo Metropolitana"):
            self.assertEqual(read_emails._classify_utility_by_supplier(name), "conta de luz", name)

    def test_telefone_internet_por_marca(self):
        for name in ("Vivo", "Claro S.A.", "TIM CELULAR S.A."):
            self.assertEqual(
                read_emails._classify_utility_by_supplier(name),
                "conta de telefone / internet", name,
            )

    def test_agua_por_marca(self):
        self.assertEqual(read_emails._classify_utility_by_supplier("Sabesp"), "conta de água")

    def test_fornecedor_sem_marca_retorna_none(self):
        for name in ("DENAMU", "Editora Globo S.A.", None, ""):
            self.assertIsNone(read_emails._classify_utility_by_supplier(name), name)

    def test_marca_so_no_nome_nao_no_corpo(self):
        # "claro"/"vivo" sao palavras comuns: no CORPO nao podem classificar (só "vivo"
        # entra pela lista de frases, mas "claro" jamais). Garante que a marca é
        # escopada ao supplier_name.
        self.assertIsNone(read_emails._classify_utility_doc_type("Está claro que vou pagar"))


class BodyDocNumberCaptureTest(unittest.TestCase):
    def test_captura_numero_do_documento_alfanumerico(self):
        payload = read_emails.extract_from_email_body(
            AGUA_BODY, "2026-06-22T10:00:00+00:00", "<msg-agua>",
            "barbara@otimotex.com.br", subject="PAGAMENTO CONTA DE ÁGUA",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["invoice_number"], "SOR202659903949")

    def test_rotulo_frouxo_nao_captura(self):
        # Só o rótulo explícito "Número do documento" captura; "Documento: Banco" não.
        body = "Documento: Banco do Brasil\nValor R$ 10,00"
        payload = read_emails.extract_from_email_body(
            body, "2026-06-22T10:00:00+00:00", "<msg-frouxo>", "x@y.com",
        )
        self.assertIsNotNone(payload)
        self.assertNotEqual(payload["invoice_number"], "Banco")


class ExtractAguaBodyTest(unittest.TestCase):
    def test_caso_171_completo(self):
        payload = read_emails.extract_from_email_body(
            AGUA_BODY, "2026-06-22T10:00:00+00:00", "<msg-171>",
            "barbara@otimotex.com.br", subject="PAGAMENTO CONTA DE ÁGUA",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["document_type"], "conta de água")
        self.assertEqual(payload["invoice_number"], "SOR202659903949")
        self.assertEqual(payload["amount"], 163.96)
        self.assertEqual(payload["supplier_cnpj"], "43776517000180")
        self.assertEqual(payload["supplier_name"], "Sabesp")

    def test_assunto_utility_tem_precedencia_sobre_fatura_no_corpo(self):
        # Corpo parece fatura, mas o assunto "CONTA DE LUZ" define o tipo.
        body = "Segue sua fatura mensal.\nValor R$ 250,00\nVencimento: 10/07/2026"
        payload = read_emails.extract_from_email_body(
            body, "2026-06-22T10:00:00+00:00", "<msg-luz>",
            "atendimento@enel.com.br", subject="PAGAMENTO CONTA DE LUZ",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["document_type"], "conta de luz")

    def test_classifica_pela_marca_do_fornecedor_sem_frase_no_assunto(self):
        # Assunto neutro, mas "Fornecedor: Sabesp" no corpo → conta de água pela marca.
        body = "Fornecedor: Sabesp\nValor R$ 80,00\nVencimento: 10/07/2026"
        payload = read_emails.extract_from_email_body(
            body, "2026-06-22T10:00:00+00:00", "<msg-sabesp>",
            "cobranca@sabesp.com.br", subject="Pagamento",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["document_type"], "conta de água")


class PdfPayloadUtilityTest(unittest.TestCase):
    def test_build_payload_classifica_pelo_assunto(self):
        # Caminho de PDF: extract_pdf classifica 'boleto', mas o assunto "CONTA VIVO"
        # tem precedência → conta de telefone / internet.
        row = {"document_type": "boleto", "amount": "120.00", "due_date": "2026-07-05"}
        payload = read_emails.build_financial_payload(
            row, "<msg-vivo>", received_at="2026-06-22T10:00:00+00:00",
            subject="PAGAMENTO CONTA VIVO",
        )
        self.assertEqual(payload["document_type"], "conta de telefone / internet")

    def test_build_payload_classifica_pela_marca_do_fornecedor(self):
        # Assunto neutro; a marca "Enel" no supplier_name do PDF define conta de luz.
        row = {"document_type": "boleto", "supplier_name": "ENEL DISTRIBUIÇÃO SP",
               "amount": "300.00", "due_date": "2026-07-05"}
        payload = read_emails.build_financial_payload(
            row, "<msg-enel>", received_at="2026-06-22T10:00:00+00:00", subject="Boleto",
        )
        self.assertEqual(payload["document_type"], "conta de luz")


if __name__ == "__main__":
    unittest.main()
