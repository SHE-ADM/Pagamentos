"""
Testes da regra FATURA + BOLETO (multi-anexo):

  - E-mail com 2 anexos (fatura/relatorio + boleto) → so o BOLETO vira conta a
    pagar; a fatura descreve o MESMO debito e seria conta duplicada.
  - E-mail so com fatura (sem boleto) → a fatura e extraida normalmente.
  - O sinal e o CODIGO DE BARRAS (_is_boleto_barcode), nao o document_type — o
    extrator rotula tanto o boleto quanto o relatorio como 'boleto'.

Cobre o helper _email_has_real_boleto e o fluxo de extract_and_store_accounts
(com run_extraction/read_extracted_rows mockados), inclusive independencia da
ORDEM dos anexos (o pre-scan do passo 1 decide antes de gravar).
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Codigos de barras reais do caso padariabelga (id 388 boleto / id 387 relatorio).
BOLETO_REAL = "23797150300020100800165090000000182600836500"   # linha digitavel (Bradesco)
RELATORIO   = "35260660429792000146650050000059541448378262"   # 44 dig, NAO e boleto (pos.4='6')
CHAVE_44    = "1234" + "0" * 40                                 # chave de acesso -> nao-boleto


class FakeControl:
    """Stub de SupabaseControl — registra gravacoes/erros sem tocar o banco."""

    def __init__(self):
        self.financial_calls = []
        self.error_calls = []

    def upload_attachment(self, pdf_path):
        return True

    def company_cnpj(self):
        return None

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

    def resolve_supplier(self, payload):
        return 1

    def supplier_defaults(self, sk_supplier):
        return (0, 0)

    def update_financial(self, *args, **kwargs):
        return True


def _row(name, barcode, doc_type="boleto", amount="20100.80"):
    """Linha de CSV minima (as chaves ausentes viram None em build_financial_payload)."""
    return {
        "source_file": name,
        "document_type": doc_type,
        "barcode": barcode,
        "amount": amount,
        "supplier_name": "PADARIA BELGA",
        "invoice_number": "",
        "due_date": "2026-07-10",
        "extraction_source": "pdf_text",
    }


REC = {
    "received_at": "2026-07-03T12:00:00+00:00",
    "subject": "Boleto e relatorio de consumo",
    "sender_email": "padariabelga@gmail.com",
}


class EmailHasRealBoletoTest(unittest.TestCase):
    def test_com_boleto_real(self):
        rows = [_row("relatorio.pdf", RELATORIO), _row("boleto.pdf", BOLETO_REAL)]
        self.assertTrue(read_emails._email_has_real_boleto(rows))

    def test_so_fatura_sem_boleto(self):
        rows = [_row("fatura.pdf", CHAVE_44, doc_type="fatura")]
        self.assertFalse(read_emails._email_has_real_boleto(rows))

    def test_vazio(self):
        self.assertFalse(read_emails._email_has_real_boleto([]))

    def test_barcode_real_e_relatorio_no_caso_real(self):
        # Trava o sinal no dado real: boleto=digitavel valida, relatorio=nao.
        self.assertTrue(read_emails._is_boleto_barcode(BOLETO_REAL))
        self.assertFalse(read_emails._is_boleto_barcode(RELATORIO))


class ExtractAndStoreFaturaBoletoTest(unittest.TestCase):
    """Fluxo completo com run_extraction/read_extracted_rows mockados."""

    def _run(self, saved_names, rows_by_name):
        ctrl = FakeControl()
        saved = [Path(n) for n in saved_names]

        def fake_run_extraction(pdf_path, pdf_passwords=None):
            return (pdf_path.name, None)  # csv_path = nome do arquivo

        def fake_read_rows(csv_path):
            return [rows_by_name[Path(csv_path).name]]

        with patch.object(read_emails, "run_extraction", fake_run_extraction), \
             patch.object(read_emails, "read_extracted_rows", fake_read_rows):
            csvs_ok, saved_count, nonpayable_only, _att_account = read_emails.extract_and_store_accounts(
                saved, "<MID>", ctrl, email_rec=dict(REC))
        return ctrl, saved_count, nonpayable_only

    def test_fatura_mais_boleto_grava_so_boleto(self):
        rows = {
            "relatorio.pdf": _row("relatorio.pdf", RELATORIO),
            "boleto.pdf":    _row("boleto.pdf", BOLETO_REAL),
        }
        ctrl, saved, nonpayable = self._run(["relatorio.pdf", "boleto.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(len(ctrl.financial_calls), 1)
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)
        self.assertEqual(ctrl.error_calls, [])         # fatura ignorada, nao e erro
        self.assertFalse(nonpayable)                    # houve pagavel (o boleto)

    def test_ordem_inversa_boleto_primeiro(self):
        # Independencia de ordem: boleto vindo ANTES da fatura tambem grava so o boleto.
        rows = {
            "boleto.pdf":    _row("boleto.pdf", BOLETO_REAL),
            "relatorio.pdf": _row("relatorio.pdf", RELATORIO),
        }
        ctrl, saved, _ = self._run(["boleto.pdf", "relatorio.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)

    def test_fatura_sozinha_e_extraida(self):
        # Sem boleto no e-mail → a fatura vira conta a pagar (regra: fatura sem boleto).
        rows = {"fatura.pdf": _row("fatura.pdf", CHAVE_44, doc_type="fatura")}
        ctrl, saved, _ = self._run(["fatura.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(len(ctrl.financial_calls), 1)

    def test_dois_boletos_reais_gravam_ambos(self):
        # Carne / 2 boletos reais → nenhum e descartado (ambos tem linha digitavel).
        b2 = "23797150300020100800165090000000182600999999"
        rows = {
            "boleto1.pdf": _row("boleto1.pdf", BOLETO_REAL),
            "boleto2.pdf": _row("boleto2.pdf", b2),
        }
        ctrl, saved, _ = self._run(["boleto1.pdf", "boleto2.pdf"], rows)
        self.assertEqual(saved, 2)


if __name__ == "__main__":
    unittest.main()
