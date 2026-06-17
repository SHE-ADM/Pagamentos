"""
Dedup por NOME do fornecedor usa a RPC normalize_search (migration 032).

Quando o documento não traz CNPJ/CPF, find_financial_duplicate compara o nome do
fornecedor de forma case/acento-insensitive via RPC financial_dup_by_name
(normalize_search nos dois lados). Com CNPJ/CPF, mantém o match exato na tabela.
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


class FindDuplicateRoutingTest(unittest.TestCase):
    def test_fornecedor_por_nome_usa_rpc_normalizada(self):
        ctrl = _ctrl()
        cap = {}

        def fake_urlopen(req, timeout=None):
            cap["url"], cap["method"], cap["body"] = req.full_url, req.get_method(), req.data
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.find_financial_duplicate({
                "supplier_name": "EFE DISPLAYS", "amount": 34300.0,
                "due_date": "2026-06-17", "document_type": "fatura", "invoice_number": "1087",
            })

        self.assertIn("/rpc/financial_dup_by_name", cap["url"])
        self.assertEqual(cap["method"], "POST")
        self.assertIn(b"EFE DISPLAYS", cap["body"])

    def test_fornecedor_por_cnpj_usa_match_exato_na_tabela(self):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.find_financial_duplicate({
                "supplier_cnpj": "44009190000183", "amount": 34300.0,
                "due_date": "2026-06-17", "document_type": "fatura", "invoice_number": "1087",
            })

        self.assertTrue(any("/rest/v1/financial_account_control" in u for u in urls))
        self.assertFalse(any("/rpc/" in u for u in urls))


if __name__ == "__main__":
    unittest.main()
