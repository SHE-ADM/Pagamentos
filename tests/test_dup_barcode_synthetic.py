"""
Robustez da dedup de conteudo: boletos DISTINTOS nao podem ser fundidos so por
compartilharem valor/vencimento e um numero de documento SINTETICO.

Caso real (HYOSUNG 181063-1/2/3): 3 boletos com codigos de barras proprios, mas
sem N do documento e sem vencimento no PDF -> N sintetico identico ('boleto_300626')
e vencimento defaultado p/ a data da extracao. A dedup antiga fundia -1 e -2
(mesmo valor) via impressao 2 (numero sintetico) e impressao 3 (valor+vencimento),
PERDENDO o boleto -2. Agora:
  - impressao 2 IGNORA numero sintetico;
  - impressao 3 so casa candidatos SEM barcode quando o novo TEM barcode.
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


class SyntheticInvoiceDetectTest(unittest.TestCase):
    def test_detecta_sinteticos(self):
        self.assertTrue(R._is_synthetic_invoice_number("boleto_300626"))
        self.assertTrue(R._is_synthetic_invoice_number("boleto_300626(2)"))
        self.assertTrue(R._is_synthetic_invoice_number("PIX_R$ 10.999,99"))
        self.assertTrue(R._is_synthetic_invoice_number("outro_130726"))

    def test_numero_real_nao_e_sintetico(self):
        self.assertFalse(R._is_synthetic_invoice_number("109/09116045"))
        self.assertFalse(R._is_synthetic_invoice_number("1087"))
        self.assertFalse(R._is_synthetic_invoice_number("3918439"))


class DedupBarcodeSyntheticTest(unittest.TestCase):
    def test_boleto_com_barcode_proprio_nao_funde_via_sintetico(self):
        """Novo boleto com barcode + N sintetico: impressao 2 e PULADA (sintetico)
        e impressao 3 exige candidato sem barcode -> sem falso-positivo."""
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([])  # nenhuma linha casa

        payload = {
            "sk_supplier": 1080, "amount": 9320.61, "due_date": "2026-06-30",
            "document_type": "boleto", "invoice_number": "boleto_300626",
            "barcode": "00191150600009320610000003643213000000323617",
        }
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate(payload)

        self.assertIsNone(dup)
        # impressao 1 (barcode exato) foi consultada
        self.assertTrue(any("barcode=eq." in u for u in urls))
        # impressao 2 (numero sintetico) NAO foi consultada
        self.assertFalse(any("invoice_number=eq." in u for u in urls))
        # impressao 3 restringe a candidatos sem barcode
        self.assertTrue(any("barcode=is.null" in u for u in urls))

    def test_numero_real_ainda_deduplica_reemissao(self):
        """Reemissao com numero PROPRIO: impressao 2 continua casando (atualiza)."""
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            # casa na impressao 2 (numero real)
            if "invoice_number=eq." in req.full_url:
                return _Resp([{"id": 42, "due_date": "2026-05-01", "barcode": "OLD"}])
            return _Resp([])

        payload = {
            "sk_supplier": 154, "amount": 34300.0, "due_date": "2026-06-17",
            "document_type": "fatura", "invoice_number": "1087654",
            "barcode": "NEWBARCODE123",
        }
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate(payload)

        self.assertEqual(dup["id"], 42)
        self.assertTrue(any("invoice_number=eq." in u for u in urls))

    def test_sem_barcode_mantem_impressao3(self):
        """Documento do CORPO (sem barcode): impressao 3 segue casando por
        valor+vencimento+tipo (nao adiciona barcode=is.null)."""
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([])

        payload = {
            "sk_supplier": 154, "amount": 100.0, "due_date": "2026-06-17",
            "document_type": "boleto", "invoice_number": "boleto_170626",
        }
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.find_financial_duplicate(payload)

        self.assertFalse(any("barcode=is.null" in u for u in urls))


if __name__ == "__main__":
    unittest.main()
