"""
Autoria da conta (Etapa 1 — visibilidade por dono, migration 076).

`SupabaseControl.resolve_user(sender_email)` resolve o UUID do usuário dono via RPC
`resolve_user_for_account` (que já devolve o sentinela quando o e-mail não casa).
`register_financial` injeta `created_by` no payload (só quando ainda não há), a partir
do `sender_email`, no choke point de gravação.
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


UUID = "11111111-1111-1111-1111-111111111111"


class ResolveUserTest(unittest.TestCase):
    def test_chama_rpc_com_p_email_e_devolve_uuid(self):
        ctrl = _ctrl()
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen["url"] = req.full_url
            seen["body"] = json.loads(req.data.decode())
            return _Resp(UUID)

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            got = ctrl.resolve_user("ester@otimotex.com.br")

        self.assertEqual(got, UUID)
        self.assertIn("/rpc/resolve_user_for_account", seen["url"])
        self.assertEqual(seen["body"], {"p_email": "ester@otimotex.com.br"})

    def test_sem_email_nao_toca_a_rede(self):
        ctrl = _ctrl()

        def boom(req, timeout=None):
            raise AssertionError("não deveria chamar a rede sem e-mail")

        with mock.patch.object(R.urllib.request, "urlopen", boom):
            self.assertIsNone(ctrl.resolve_user(None))
            self.assertIsNone(ctrl.resolve_user(""))

    def test_falha_da_rpc_retorna_none(self):
        ctrl = _ctrl()

        def boom(req, timeout=None):
            raise RuntimeError("rpc down")

        with mock.patch.object(R.urllib.request, "urlopen", boom):
            self.assertIsNone(ctrl.resolve_user("x@y.com"))


class RegisterFinancialCreatedByTest(unittest.TestCase):
    def test_injeta_created_by_do_sender_email(self):
        ctrl = _ctrl()
        posted = {}

        def fake_urlopen(req, timeout=None):
            if "/rpc/resolve_user_for_account" in req.full_url:
                return _Resp(UUID)
            posted["body"] = json.loads(req.data.decode())  # INSERT em financial_account_control
            return _Resp([{"id": 42}])  # return=representation → lista com a linha gravada

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            account_id = ctrl.register_financial({
                "gmail_message_id": "<m1>", "sk_supplier": 1, "amount": 100,
                "sender_email": "ester@otimotex.com.br", "due_date": "2026-07-10",
                "status": "pendente",
            })

        self.assertEqual(account_id, 42)
        self.assertEqual(posted["body"]["created_by"], UUID)

    def test_respeita_created_by_ja_presente(self):
        ctrl = _ctrl()
        posted = {}

        def fake_urlopen(req, timeout=None):
            if "/rpc/" in req.full_url:
                raise AssertionError("não deve resolver usuário quando created_by já veio")
            posted["body"] = json.loads(req.data.decode())
            return _Resp([{"id": 43}])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            account_id = ctrl.register_financial({
                "gmail_message_id": "<m2>", "sk_supplier": 1, "amount": 100,
                "sender_email": "ester@otimotex.com.br", "created_by": UUID,
                "due_date": "2026-07-10", "status": "pendente",
            })

        self.assertEqual(account_id, 43)
        self.assertEqual(posted["body"]["created_by"], UUID)


if __name__ == "__main__":
    unittest.main()
