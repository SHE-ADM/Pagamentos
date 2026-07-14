"""
Testes da guarda determinística CEDENTE-SSW (fatura de transporte):

  - Em fatura SSW (sswsistemas.com.br), o extrator pode gravar o EMITENTE do CT-e
    agregado (transportadora SUBCONTRATADA) como fornecedor. O CEDENTE do boleto
    (quem EMITE a fatura e recebe) é nomeado no CORPO de forma determinística e
    SOBREPÕE o fornecedor extraído — só quando a linha é um BOLETO real.

Cobre o helper puro _ssw_cedente_from_body e o override dentro de
extract_and_store_accounts (com run_extraction/read_extracted_rows mockados).
Caso de origem: conta id 528 (fatura Campinense Nº 0324348) gravada sob a
transportadora subcontratada TRANSPORTADORA J.D.F.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Linha digitável real do boleto Campinense (id 528) — Bradesco (237), moeda '9'.
BOLETO_CAMPINENSE = "23792152400000502400289090000010602503122940"
OTIMOTEX_CNPJ     = "47273917000123"   # empresa pagadora — excluída do cedente
CAMPINENSE_CNPJ   = "08706145000203"   # cedente correto (rodapé da fatura)

SSW_BODY = (
    "Fatura\r\n"
    "Prezado Cliente,\r\n"
    "TEXTIL E CONFECCOES OTIMOTEX L\r\n"
    "Segue fatura no 0324348 referente aos servicos de transporte realizados "
    "por Campinense Transporte De Carga. Para imprimir clique AQUI.\r\n"
    "Fatura: 0324348\r\n"
    "Valor (R$): 502,40\r\n"
    "Vencimento: 31/07/26\r\n"
    "Atenciosamente,\r\n"
    "CAMPINENSE TRANSPORTE DE CARGAS LTDA\r\n"
    "CNPJ: 08.706.145/0002-03\r\n"
    "Fone: (81) 3974-5454\r\n"
)


class SswCedenteHelperTest(unittest.TestCase):
    def test_extrai_nome_e_cnpj_do_corpo(self):
        name, cnpj = read_emails._ssw_cedente_from_body(
            "no-reply@sswsistemas.com.br", SSW_BODY, OTIMOTEX_CNPJ)
        self.assertEqual(name, "Campinense Transporte De Carga")
        self.assertEqual(cnpj, CAMPINENSE_CNPJ)

    def test_remetente_nao_ssw_nao_dispara(self):
        self.assertEqual(
            read_emails._ssw_cedente_from_body("boleto@fornecedor.com", SSW_BODY, OTIMOTEX_CNPJ),
            (None, None),
        )

    def test_corpo_vazio_degrada(self):
        self.assertEqual(
            read_emails._ssw_cedente_from_body("no-reply@sswsistemas.com.br", "", OTIMOTEX_CNPJ),
            (None, None),
        )

    def test_exclui_cnpj_da_propria_empresa(self):
        # Se o único CNPJ do corpo for o da própria empresa, não vira cedente (só o nome fica).
        name, cnpj = read_emails._ssw_cedente_from_body(
            "no-reply@sswsistemas.com.br", SSW_BODY, CAMPINENSE_CNPJ)
        self.assertEqual(name, "Campinense Transporte De Carga")
        self.assertIsNone(cnpj)

    def test_barcode_real_e_boleto(self):
        self.assertTrue(read_emails._is_boleto_barcode(BOLETO_CAMPINENSE))


class FakeControl:
    """Stub de SupabaseControl — captura o payload no momento da resolução."""

    def __init__(self):
        self.financial_calls = []
        self.error_calls = []
        self.resolved_with = []   # (supplier_name, supplier_cnpj) vistos por resolve_supplier

    def upload_attachment(self, pdf_path):
        return True

    def company_cnpj(self):
        return OTIMOTEX_CNPJ

    def resolve_supplier(self, payload):
        # _finalize_supplier remove supplier_name/cnpj DEPOIS desta chamada — captura aqui.
        self.resolved_with.append((payload.get("supplier_name"), payload.get("supplier_cnpj")))
        return 1278

    def supplier_defaults(self, sk_supplier):
        return (0, 0)

    def register_financial(self, payload):
        self.financial_calls.append(payload)
        return True

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

    def unique_invoice_number(self, base):
        return base

    def find_financial_duplicate(self, payload):
        return None

    def update_financial(self, *args, **kwargs):
        return True


def _transport_row():
    """Linha extraída de um boleto de transporte cujo fornecedor saiu ERRADO (o
    emitente do CT-e agregado = transportadora subcontratada J.D.F.)."""
    return {
        "source_file": "fatura_ssw_link.pdf",
        "document_type": "boleto",
        "barcode": BOLETO_CAMPINENSE,
        "amount": "502.40",
        "supplier_name": "TRANSPORTADORA J.D.F.",
        "supplier_cnpj": "07241838000205",
        "invoice_number": "0324348",
        "due_date": "2026-07-31",
        "extraction_source": "pdf_text",
    }


def _rec(sender="no-reply@sswsistemas.com.br"):
    return {
        "received_at": "2026-07-14T12:00:00+00:00",
        "subject": "Sua fatura No324348 esta disponivel.",
        "sender_email": sender,
    }


class ExtractAndStoreCedenteOverrideTest(unittest.TestCase):
    def _run(self, rec, body_text):
        ctrl = FakeControl()

        def fake_run_extraction(pdf_path, pdf_passwords=None):
            return (pdf_path.name, None)

        def fake_read_rows(csv_path):
            return [_transport_row()]

        with patch.object(read_emails, "run_extraction", fake_run_extraction), \
             patch.object(read_emails, "read_extracted_rows", fake_read_rows), \
             patch.object(read_emails, "apply_forced_classification", lambda *a, **k: None):
            read_emails.extract_and_store_accounts(
                [Path("fatura_ssw_link.pdf")], "<MID>", ctrl,
                email_rec=dict(rec), body_text=body_text)
        return ctrl

    def test_override_grava_conta_sob_o_cedente(self):
        ctrl = self._run(_rec(), SSW_BODY)
        self.assertEqual(len(ctrl.financial_calls), 1)
        self.assertEqual(ctrl.error_calls, [])
        # O fornecedor resolvido foi o CEDENTE do corpo, não o emitente do CT-e.
        name, cnpj = ctrl.resolved_with[-1]
        self.assertEqual(cnpj, CAMPINENSE_CNPJ)
        self.assertEqual(name, "Campinense Transporte De Carga")

    def test_sem_corpo_mantem_fornecedor_extraido(self):
        # Degrada com segurança: sem corpo, nenhum override — segue o extraído.
        ctrl = self._run(_rec(), "")
        name, cnpj = ctrl.resolved_with[-1]
        self.assertEqual(cnpj, "07241838000205")
        self.assertEqual(name, "TRANSPORTADORA J.D.F.")

    def test_remetente_nao_ssw_mantem_fornecedor_extraido(self):
        ctrl = self._run(_rec(sender="boleto@outro.com.br"), SSW_BODY)
        name, cnpj = ctrl.resolved_with[-1]
        self.assertEqual(cnpj, "07241838000205")
        self.assertEqual(name, "TRANSPORTADORA J.D.F.")


if __name__ == "__main__":
    unittest.main()
