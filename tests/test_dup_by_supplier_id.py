"""
Dedup de conteúdo por supplier_id (migrations 040/041).

Desde que financial_account_control deixou de guardar nome/CNPJ do fornecedor
(só a FK supplier_id), a resolução do fornecedor acontece ANTES da dedup
(_finalize_supplier → RPC resolve_supplier_for_account) e find_financial_duplicate
casa por supplier_id. Sem supplier_id resolvido, não deduplica.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402


class _Resp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()
    def read(self):
        return self._b
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def _ctrl():
    c = R.SupabaseControl.__new__(R.SupabaseControl)  # sem __init__/env
    c._available = True
    c.base = "https://proj.supabase.co"
    c.headers = {"apikey": "k", "Authorization": "Bearer k", "Content-Type": "application/json"}
    return c


class FindDuplicateBySupplierIdTest(unittest.TestCase):
    def test_casa_por_supplier_id_na_tabela(self):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.find_financial_duplicate({
                "supplier_id": 154, "amount": 34300.0,
                "due_date": "2026-06-17", "document_type": "fatura", "invoice_number": "1087",
            })

        # Consulta a tabela filtrando por supplier_id, sem nenhuma RPC.
        self.assertTrue(any("/rest/v1/financial_account_control" in u for u in urls))
        self.assertTrue(any("supplier_id=eq.154" in u for u in urls))
        self.assertFalse(any("/rpc/" in u for u in urls))

    def test_sem_supplier_id_nao_deduplica(self):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate({
                "amount": 34300.0, "due_date": "2026-06-17", "document_type": "fatura",
            })

        self.assertIsNone(dup)
        # Sem barcode e sem supplier_id → nenhuma consulta de fornecedor.
        self.assertFalse(any("supplier_id=eq" in u for u in urls))

    def test_barcode_tem_precedencia(self):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([{"id": 9, "due_date": "2026-06-17", "barcode": "X"}])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate({
                "barcode": "00190000090123", "supplier_id": 154, "amount": 10.0,
            })

        self.assertEqual(dup["id"], 9)
        self.assertIn("barcode=eq.", urls[0])


class FinalizeSupplierTest(unittest.TestCase):
    def test_resolve_seta_supplier_id_e_remove_colunas(self):
        ctrl = _ctrl()

        def fake_urlopen(req, timeout=None):
            # RPC resolve_supplier_for_account → bigint escalar
            return _Resp(154)

        payload = {
            "supplier_name": "CIPATEX", "supplier_cnpj": "47254461002289",
            "supplier_cpf": None, "sender_email": "fin@cipatex.com.br", "amount": 10.0,
        }
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ok = R._finalize_supplier(ctrl, payload)

        self.assertTrue(ok)
        self.assertEqual(payload["supplier_id"], 154)
        # As 3 colunas denormalizadas saem do payload.
        for col in ("supplier_name", "supplier_cnpj", "supplier_cpf"):
            self.assertNotIn(col, payload)

    def test_falha_de_resolucao_retorna_false_e_remove_colunas(self):
        ctrl = _ctrl()

        def boom(req, timeout=None):
            raise OSError("rede caiu")

        payload = {"supplier_name": "X", "supplier_cnpj": None, "supplier_cpf": None}
        with mock.patch.object(R.urllib.request, "urlopen", boom):
            ok = R._finalize_supplier(ctrl, payload)

        self.assertFalse(ok)
        self.assertNotIn("supplier_id", payload)
        self.assertNotIn("supplier_name", payload)


if __name__ == "__main__":
    unittest.main()
