"""
Testes da regra CT-e / transporte (regras 1-5 do plano CTe):

  - O CT-e (documento FISCAL) NAO gera conta a pagar; so o BOLETO de frete gera.
  - Um BOLETO de transporte (contexto cte/transporte/transportadora ou fornecedor de
    transporte) e rotulado como document_type='cte'.
  - CT-e/transporte SEM boleto vira 'ignorado' (nao gera conta, nao e 'falha').

Cobre os helpers (_is_transport_supplier/_is_transport_context/
_apply_transport_boleto_doc_type), o caminho de PDF (build_financial_payload), o
caminho de corpo (extract_from_email_body) e o skip em try_extract_from_body.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Codigos de barras (mesmos formatos de test_extract_pdf).
BOLETO_44 = "0019" + "0" * 40           # FEBRABAN moeda '9' banco '001' -> boleto
CHAVE_44  = "1234" + "0" * 40           # chave de acesso NF-e/CT-e -> NAO e boleto
ARREC_48  = "8" + "0" * 47              # linha de arrecadacao (48 dig) -> boleto pagavel


class FakeControl:
    """Stub de SupabaseControl — registra chamadas em vez de tocar o banco."""

    def __init__(self):
        self.financial_calls = []
        self.error_calls = []
        self.duplicate = False

    def register_financial(self, payload):
        self.financial_calls.append(payload)
        return True

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

    def unique_invoice_number(self, base):
        return base

    def find_financial_duplicate(self, payload):
        return {"id": 999} if self.duplicate else None

    def resolve_supplier(self, payload):
        return 1

    def supplier_defaults(self, sk_supplier):
        return (0, 0)


class IsTransportSupplierTest(unittest.TestCase):
    def test_nomes_de_transportadora_casam(self):
        for name in ("ACME TRANSPORTES LTDA", "Rodonaves Transporte", "Braspress Transportadora",
                     "XPTO Logistica S.A.", "Cargas Pesadas ME", "Expresso Encomendas",
                     "Frete Rapido", "Fretes Unidos"):
            self.assertTrue(read_emails._is_transport_supplier(name), name)

    def test_nao_transportadora_nao_casa(self):
        for name in ("ACME COMERCIO", "Editora Globo S.A.", "Padaria do Joao", None, ""):
            self.assertFalse(read_emails._is_transport_supplier(name), name)


class IsTransportContextTest(unittest.TestCase):
    def test_assunto_de_transporte(self):
        for subj in ("CT-e 12345", "Conhecimento de transporte", "PAGAMENTO TRANSPORTADORA",
                     "cte RODONAVES", "DACTE frete"):
            self.assertTrue(read_emails._is_transport_context(subj, None, None), subj)

    def test_fornecedor_de_transporte(self):
        self.assertTrue(read_emails._is_transport_context("PAGAMENTO", "ACME TRANSPORTES", None))

    def test_document_type_cte(self):
        self.assertTrue(read_emails._is_transport_context(None, None, "cte"))

    def test_sem_contexto_de_transporte(self):
        self.assertFalse(read_emails._is_transport_context("PAGAMENTO BOLETO", "ACME COMERCIO", "boleto"))
        # 'cte' como substring de outra palavra NAO casa (palavra inteira).
        self.assertFalse(read_emails._is_transport_context("conecte agora", None, None))


class ApplyTransportBoletoDocTypeTest(unittest.TestCase):
    def test_boleto_de_transporte_vira_cte(self):
        got = read_emails._apply_transport_boleto_doc_type("boleto", "PAGAMENTO", "ACME TRANSPORTES", BOLETO_44)
        self.assertEqual(got, "cte")

    def test_boleto_por_assunto_de_transporte(self):
        got = read_emails._apply_transport_boleto_doc_type("boleto", "CT-e 999 RODONAVES", "ACME", BOLETO_44)
        self.assertEqual(got, "cte")

    def test_boleto_nao_transporte_permanece_boleto(self):
        got = read_emails._apply_transport_boleto_doc_type("boleto", "PAGAMENTO", "ACME COMERCIO", BOLETO_44)
        self.assertEqual(got, "boleto")

    def test_cte_sem_boleto_permanece_cte(self):
        # Chave de acesso (nao-boleto) — nao relabela, o document_type segue 'cte'.
        got = read_emails._apply_transport_boleto_doc_type("cte", "CT-e", "RODONAVES TRANSPORTE", CHAVE_44)
        self.assertEqual(got, "cte")

    def test_guia_de_transportadora_preserva_tipo(self):
        # Uma transportadora que manda um DARE (guia com barcode de arrecadacao) NAO
        # vira cte — tipos fiscais/guias sao preservados.
        got = read_emails._apply_transport_boleto_doc_type("dare", "PAGAMENTO DARE", "ACME TRANSPORTES", ARREC_48)
        self.assertEqual(got, "dare")


class BuildFinancialPayloadTransportTest(unittest.TestCase):
    """Caminho de PDF — build_financial_payload aplica o re-rotulo boleto->cte."""

    def _row(self, **over):
        row = {"document_type": "boleto", "supplier_name": "ACME COMERCIO",
               "barcode": BOLETO_44, "amount": "100,00", "invoice_number": "123"}
        row.update(over)
        return row

    def test_boleto_de_transportadora_vira_cte(self):
        p = read_emails.build_financial_payload(
            self._row(supplier_name="RODONAVES TRANSPORTES LTDA"), "<m1>", subject="PAGAMENTO BOLETO")
        self.assertEqual(p["document_type"], "cte")

    def test_boleto_por_assunto_cte_vira_cte(self):
        p = read_emails.build_financial_payload(
            self._row(), "<m2>", subject="CT-e 555 - frete")
        self.assertEqual(p["document_type"], "cte")

    def test_boleto_comum_permanece_boleto(self):
        p = read_emails.build_financial_payload(self._row(), "<m3>", subject="PAGAMENTO BOLETO")
        self.assertEqual(p["document_type"], "boleto")

    def test_cte_fiscal_com_chave_permanece_cte(self):
        # CT-e fiscal (chave de acesso, sem boleto) — o document_type segue 'cte'
        # (o skip da conta acontece no loop de extract_and_store_accounts).
        p = read_emails.build_financial_payload(
            self._row(document_type="cte", barcode=CHAVE_44, supplier_name="RODONAVES TRANSPORTES"),
            "<m4>", subject="CT-e RODONAVES")
        self.assertEqual(p["document_type"], "cte")


class TryExtractFromBodyTransportTest(unittest.TestCase):
    def test_transporte_sem_boleto_ignora(self):
        ctrl = FakeControl()
        body = ("Fornecedor: RODONAVES TRANSPORTES LTDA\r\n"
                "Valor: R$ 200,00\r\n"
                "Vencimento: 20/06/2026\r\n")
        rec = {"message_id": "<cte-1>", "subject": "CT-e 12345 RODONAVES"}
        outcome = read_emails.try_extract_from_body(
            rec, body, "2026-06-10T00:00:00+00:00", "<cte-1>", ctrl)
        self.assertEqual(outcome, read_emails.BODY_IGNORED)
        self.assertEqual(ctrl.financial_calls, [])   # nada gravado
        self.assertEqual(ctrl.error_calls, [])        # skip silencioso, nao e erro

    def test_boleto_de_transporte_no_corpo_grava_como_cte(self):
        ctrl = FakeControl()
        body = ("Fornecedor: RODONAVES TRANSPORTES LTDA\r\n"
                "Valor: R$ 200,00\r\n"
                "Vencimento: 20/06/2026\r\n"
                f"codigo de barras {ARREC_48}\r\n")
        rec = {"message_id": "<cte-2>", "subject": "Frete RODONAVES"}
        outcome = read_emails.try_extract_from_body(
            rec, body, "2026-06-10T00:00:00+00:00", "<cte-2>", ctrl)
        self.assertEqual(outcome, read_emails.BODY_CREATED)
        self.assertEqual(len(ctrl.financial_calls), 1)
        self.assertEqual(ctrl.financial_calls[0]["document_type"], "cte")
        self.assertEqual(ctrl.financial_calls[0]["payment_method"], "boleto")


class StatusForResultNonpayableTest(unittest.TestCase):
    def test_nonpayable_vira_ignorado_antes_de_csv(self):
        # PDF do CT-e gera CSV mas nenhuma conta — nonpayable tem precedencia sobre
        # csv_generated para nao marcar 'extraído' por engano.
        self.assertEqual(
            read_emails.status_for_result(
                has_attachment=True, csv_generated=True, body_created=False,
                accounts_saved=0, nonpayable=True),
            "ignorado",
        )

    def test_conta_salva_vence_nonpayable(self):
        # E-mail misto (CT-e fiscal pulado + boleto gravado) segue 'extraído'.
        self.assertEqual(
            read_emails.status_for_result(
                has_attachment=True, csv_generated=True, body_created=False,
                accounts_saved=1, nonpayable=True),
            "extraído",
        )


if __name__ == "__main__":
    unittest.main()
