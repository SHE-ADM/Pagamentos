"""
Dedup de conteúdo por sk_supplier (migrations 040/041/042).

Desde que financial_account_control deixou de guardar nome/CNPJ do fornecedor
(só a FK sk_supplier, surrogate key snowflake), a resolução do fornecedor acontece
ANTES da dedup (_finalize_supplier → RPC resolve_supplier_for_account, que devolve o
sk_supplier) e find_financial_duplicate casa por sk_supplier. Sem sk_supplier
resolvido, não deduplica.
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


class FindDuplicateBySkSupplierTest(unittest.TestCase):
    def test_casa_por_sk_supplier_na_tabela(self):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.find_financial_duplicate({
                "sk_supplier": 154, "amount": 34300.0,
                "due_date": "2026-06-17", "document_type": "fatura", "invoice_number": "1087",
            })

        # Consulta a tabela filtrando por sk_supplier, sem nenhuma RPC.
        self.assertTrue(any("/rest/v1/financial_account_control" in u for u in urls))
        self.assertTrue(any("sk_supplier=eq.154" in u for u in urls))
        self.assertFalse(any("/rpc/" in u for u in urls))

    def test_sem_sk_supplier_nao_deduplica(self):
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
        # Sem barcode e sem sk_supplier → nenhuma consulta de fornecedor.
        self.assertFalse(any("sk_supplier=eq" in u for u in urls))

    def test_barcode_tem_precedencia(self):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([{"id": 9, "due_date": "2026-06-17", "barcode": "X"}])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate({
                "barcode": "00190000090123", "sk_supplier": 154, "amount": 10.0,
            })

        self.assertEqual(dup["id"], 9)
        self.assertIn("barcode=eq.", urls[0])


class FinalizeSupplierTest(unittest.TestCase):
    def test_resolve_seta_sk_supplier_e_remove_colunas(self):
        ctrl = _ctrl()

        def fake_urlopen(req, timeout=None):
            # RPC resolve_supplier_for_account → bigint escalar (sk_supplier)
            return _Resp(154)

        payload = {
            "supplier_name": "CIPATEX", "supplier_cnpj": "47254461002289",
            "supplier_cpf": None, "sender_email": "fin@cipatex.com.br", "amount": 10.0,
        }
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ok = R._finalize_supplier(ctrl, payload)

        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], 154)
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
        self.assertNotIn("sk_supplier", payload)
        self.assertNotIn("supplier_name", payload)

    def test_injeta_classificacao_default_do_fornecedor(self):
        """Migration 052: a nova conta herda cost_center_id/chart_account_id do
        fornecedor resolvido quando > 0."""
        ctrl = _ctrl()

        def fake(req, timeout=None):
            url = req.full_url
            if "/rpc/resolve_supplier_for_account" in url:
                return _Resp(154)  # RPC → sk_supplier
            if "/rest/v1/supplier?" in url:
                return _Resp([{"cost_center_id": 5, "chart_account_id": 10}])
            return _Resp([])

        payload = {"supplier_name": "X", "supplier_cnpj": None, "supplier_cpf": None, "amount": 10.0}
        with mock.patch.object(R.urllib.request, "urlopen", fake):
            ok = R._finalize_supplier(ctrl, payload)

        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], 154)
        self.assertEqual(payload["cost_center_id"], 5)
        self.assertEqual(payload["chart_account_id"], 10)

    def test_classificacao_zero_nao_injeta(self):
        """Sentinela 0 (não informado) não entra no payload — o NOT NULL DEFAULT 0
        do banco assume; nunca enviamos None (violaria o NOT NULL)."""
        ctrl = _ctrl()

        def fake(req, timeout=None):
            url = req.full_url
            if "/rpc/resolve_supplier_for_account" in url:
                return _Resp(200)
            if "/rest/v1/supplier?" in url:
                return _Resp([{"cost_center_id": 0, "chart_account_id": 0}])
            return _Resp([])

        payload = {"supplier_name": "Y", "supplier_cnpj": None, "supplier_cpf": None}
        with mock.patch.object(R.urllib.request, "urlopen", fake):
            ok = R._finalize_supplier(ctrl, payload)

        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], 200)
        self.assertNotIn("cost_center_id", payload)
        self.assertNotIn("chart_account_id", payload)


if __name__ == "__main__":
    unittest.main()
