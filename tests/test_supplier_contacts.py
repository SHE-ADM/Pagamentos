"""
test_supplier_contacts.py — parser de contato do fornecedor (chave PIX / telefone /
WhatsApp) e a logica de 2 slots do write-back (read_emails). Testa funcoes PURAS com
literais (sem rede) + os guards de update_supplier_contact.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))
import read_emails as R  # noqa: E402


class ParsePixTest(unittest.TestCase):
    def test_pix_email_labeled(self):
        c = R.parse_supplier_contacts("Segue o pagamento. Chave PIX: financeiro@acme.com.br")
        self.assertEqual(c["pix"], "financeiro@acme.com.br")

    def test_pix_cpf_labeled(self):
        self.assertEqual(R.parse_supplier_contacts("PIX 123.456.789-00")["pix"], "12345678900")

    def test_pix_cnpj_labeled(self):
        self.assertEqual(
            R.parse_supplier_contacts("chave pix 12.345.678/0001-99")["pix"], "12345678000199")

    def test_pix_uuid_labeled(self):
        c = R.parse_supplier_contacts("Chave PIX aleatoria: e1b2c3d4-e5f6-7788-9900-aabbccddeeff")
        self.assertEqual(c["pix"], "e1b2c3d4-e5f6-7788-9900-aabbccddeeff")

    def test_pix_requires_label(self):
        # E-mail em assinatura, sem rotulo 'pix' → NAO vira chave PIX.
        self.assertIsNone(R.parse_supplier_contacts("Contato: joao@acme.com.br")["pix"])

    def test_pix_ignores_date_like_digits(self):
        self.assertIsNone(R.parse_supplier_contacts("PIX vence 10/06/2026")["pix"])

    def test_pix_excludes_payer_cnpj(self):
        # CNPJ do pagador (OTIMOTEX) perto de "pix" NAO deve virar chave do fornecedor.
        own = "47273917000123"
        self.assertIsNone(
            R.parse_supplier_contacts("PIX pagador 47.273.917/0001-23", exclude_pix={own})["pix"])

    def test_pix_excluded_then_real_key_after(self):
        # Pula o CNPJ excluido e captura a chave real que vem depois, na mesma janela.
        c = R.parse_supplier_contacts(
            "PIX 47.273.917/0001-23 chave real 12.345.678/0001-99", exclude_pix={"47273917000123"})
        self.assertEqual(c["pix"], "12345678000199")


class ParsePhoneTest(unittest.TestCase):
    def test_phone_paren_mobile(self):
        self.assertEqual(
            R.parse_supplier_contacts("Fone: (11) 99999-9999")["phone"], ("11", "999999999"))

    def test_phone_paren_landline(self):
        self.assertEqual(
            R.parse_supplier_contacts("Ligar (21) 3232-1010")["phone"], ("21", "32321010"))

    def test_phone_labeled_without_ddd_defaults_11(self):
        # Sem DDD visivel → default 11 (requisito).
        self.assertEqual(R.parse_supplier_contacts("tel 3232-1010")["phone"], ("11", "32321010"))

    def test_phone_none_when_absent(self):
        self.assertIsNone(R.parse_supplier_contacts("Sem contato aqui.")["phone"])


class ParseWhatsappTest(unittest.TestCase):
    def test_whatsapp_labeled(self):
        c = R.parse_supplier_contacts("WhatsApp (11) 98888-7777")
        self.assertEqual(c["whatsapp"], "11988887777")

    def test_whatsapp_wins_over_phone_slot(self):
        # Numero rotulado como WhatsApp NAO deve cair tambem no slot de telefone.
        c = R.parse_supplier_contacts("Zap 11 98888-7777")
        self.assertEqual(c["whatsapp"], "11988887777")
        self.assertIsNone(c["phone"])

    def test_distinct_phone_and_whatsapp(self):
        c = R.parse_supplier_contacts("Tel (11) 3232-1010 / WhatsApp (11) 98888-7777")
        self.assertEqual(c["phone"], ("11", "32321010"))
        self.assertEqual(c["whatsapp"], "11988887777")


class SlotLogicTest(unittest.TestCase):
    def test_scalar_slot1_empty(self):
        self.assertEqual(
            R._contact_slot_update(None, None, "pix_key1", "pix_key2", "abc"), {"pix_key1": "abc"})

    def test_scalar_slot1_equal_noop(self):
        self.assertEqual(R._contact_slot_update("abc", None, "pix_key1", "pix_key2", "abc"), {})

    def test_scalar_slot2_when_slot1_differs(self):
        self.assertEqual(
            R._contact_slot_update("abc", None, "pix_key1", "pix_key2", "xyz"), {"pix_key2": "xyz"})

    def test_scalar_both_full_and_different_noop(self):
        self.assertEqual(R._contact_slot_update("abc", "xyz", "pix_key1", "pix_key2", "www"), {})

    def test_phone_pair_slot1_empty(self):
        self.assertEqual(
            R._phone_slot_update({}, "11", "999999999"),
            {"phone_ddd1": "11", "phone1": "999999999"})

    def test_phone_pair_already_present_noop(self):
        row = {"phone_ddd1": "11", "phone1": "999999999"}
        self.assertEqual(R._phone_slot_update(row, "11", "999999999"), {})

    def test_phone_pair_slot2_when_slot1_differs(self):
        row = {"phone_ddd1": "11", "phone1": "999999999"}
        self.assertEqual(
            R._phone_slot_update(row, "21", "32321010"),
            {"phone_ddd2": "21", "phone2": "32321010"})


class WritebackGuardTest(unittest.TestCase):
    def _ctrl(self, available=True):
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)  # sem __init__ (sem env/rede)
        ctrl._available = available
        ctrl.base = "https://x"
        ctrl.key = "k"
        ctrl.headers = {}
        return ctrl

    def test_skips_when_unavailable(self):
        self.assertFalse(self._ctrl(available=False).update_supplier_contact(5, pix="abc"))

    def test_skips_otimotex(self):
        # sk=1 (OTIMOTEX) retorna antes de qualquer chamada de rede.
        self.assertFalse(self._ctrl().update_supplier_contact(R.OTIMOTEX_SK_SUPPLIER, pix="abc"))

    def test_skips_when_nothing_detected(self):
        self.assertFalse(self._ctrl().update_supplier_contact(5))


if __name__ == "__main__":
    unittest.main()
