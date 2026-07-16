"""
Dedup por NOSSO NÚMERO (impressao 1b de find_financial_duplicate).

Caso real ids 323/560 (fatura SIEG): a 2a via / aviso de vencimento REEMITE o mesmo
titulo com JUROS (valor muda: 435,18 -> 444,01) e VENCIMENTO +1 dia — combinacao que
as impressoes 1/2/3 deixam passar (barcode difere pelo fator/valor; 2/3 exigem valor/
vencimento iguais). O NOSSO NUMERO (000000091070-8) e estavel entre reemissoes e casa.
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
    c = R.SupabaseControl.__new__(R.SupabaseControl)
    c._available = True
    c.base = "https://proj.supabase.co"
    c.headers = {"apikey": "k", "Authorization": "Bearer k", "Content-Type": "application/json"}
    return c


class IsRealNossoNumeroTest(unittest.TestCase):
    def test_reais(self):
        self.assertTrue(R._is_real_nosso_numero("000000091070-8"))
        self.assertTrue(R._is_real_nosso_numero("24880967-8"))

    def test_invalidos(self):
        self.assertFalse(R._is_real_nosso_numero(""))
        self.assertFalse(R._is_real_nosso_numero(None))
        self.assertFalse(R._is_real_nosso_numero("1234567"))       # 7 dígitos
        self.assertFalse(R._is_real_nosso_numero("00000000"))      # só zeros
        self.assertFalse(R._is_real_nosso_numero("000-000"))       # 6 dígitos


class DedupNossoNumeroTest(unittest.TestCase):
    def _payload_reemissao(self):
        # id 560: reemissao com juros (444,01) e venc +1 dia; MESMO nosso numero do 323.
        return {
            "sk_supplier": 1124, "amount": 444.01, "due_date": "2026-07-16",
            "document_type": "boleto", "invoice_number": "000000091070-8",
            "nosso_numero": "000000091070-8",
            "barcode": "03394150900000444019078692200000009107080101",
        }

    def test_reemissao_casa_por_nosso_numero(self):
        ctrl = _ctrl()
        existing = {"id": 323, "due_date": "2026-07-15",
                    "barcode": "03397150800000435189078692200000009107080101"}
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            # Só a consulta por nosso_numero casa; barcode (fator/valor diferentes) não.
            return _Resp([existing]) if "nosso_numero=eq." in req.full_url else _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate(self._payload_reemissao())

        self.assertIsNotNone(dup)
        self.assertEqual(dup["id"], 323)
        # A impressao 1 (barcode) foi tentada antes e NAO casou (barcode difere).
        self.assertTrue(any("barcode=eq." in u for u in urls))
        self.assertTrue(any("nosso_numero=eq." in u for u in urls))

    def test_nosso_numero_curto_nao_consulta(self):
        # Nosso numero invalido → impressao 1b PULADA (nao consulta por nosso_numero).
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([])

        payload = self._payload_reemissao()
        payload["nosso_numero"] = "12"  # curto → invalido
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate(payload)

        self.assertIsNone(dup)
        self.assertFalse(any("nosso_numero=eq." in u for u in urls))

    def test_sem_match_retorna_none(self):
        # Nosso numero valido mas nenhuma conta casa (titulo distinto) → None.
        ctrl = _ctrl()
        with mock.patch.object(R.urllib.request, "urlopen", lambda req, timeout=None: _Resp([])):
            dup = ctrl.find_financial_duplicate(self._payload_reemissao())
        self.assertIsNone(dup)


if __name__ == "__main__":
    unittest.main()
