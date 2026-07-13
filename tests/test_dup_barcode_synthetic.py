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

    def test_sem_barcode_impressao3_por_valor_venc_fornecedor(self):
        """Documento do CORPO (sem barcode): impressao 3 casa por fornecedor+valor+
        vencimento, SEM barcode=is.null e SEM document_type — o tipo varia entre os
        documentos da mesma divida ('boleto' no PDF x 'fatura' no corpo)."""
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

        # impressao 3 sem barcode: não adiciona barcode=is.null nem document_type.
        self.assertFalse(any("barcode=is.null" in u for u in urls))
        self.assertFalse(any("document_type=eq" in u for u in urls))
        # casa por fornecedor+valor+vencimento
        self.assertTrue(any("amount=eq" in u and "due_date=eq" in u and "sk_supplier=eq" in u
                            for u in urls))

    def test_corpo_casa_boleto_existente_qualquer_ordem(self):
        """NOVO documento do CORPO (sem barcode, tipo 'fatura') casa um BOLETO já
        gravado (com barcode, tipo 'boleto') da mesma dívida — cobre a ordem inversa
        (corpo chega depois do boleto), caso real id 511/512 (Smart Web R$ 49,90)."""
        ctrl = _ctrl()

        def fake_urlopen(req, timeout=None):
            # impressao 3 (sem barcode=is.null) casa o boleto existente, mesmo ele
            # tendo barcode e tipo diferente.
            if "amount=eq" in req.full_url and "due_date=eq" in req.full_url:
                return _Resp([{"id": 511, "due_date": "2026-07-19", "barcode": "07794..."}])
            return _Resp([])

        payload = {
            "sk_supplier": 1213, "amount": 49.90, "due_date": "2026-07-19",
            "document_type": "fatura", "invoice_number": "fatura_190726",
        }
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate(payload)

        self.assertIsNotNone(dup)
        self.assertEqual(dup["id"], 511)


class DedupCrossTypeBodyTest(unittest.TestCase):
    """Robustez cross-e-mail (ids 7/176, 217/218): um BOLETO (com barcode) que chega
    depois casa a conta do CORPO da MESMA divida (mesmo fornecedor+valor+vencimento)
    mesmo com document_type diferente ('outro' x 'boleto'). Antes a impressao 3 exigia
    tipo igual e deixava a duplicata passar."""

    def test_boleto_casa_conta_do_corpo_ignorando_tipo(self):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            # impressao 1 (barcode exato) nao casa; impressao 3 (barcode=is.null) casa
            # a conta do corpo (id 7, sem barcode, tipo 'outro').
            if "barcode=is.null" in req.full_url:
                return _Resp([{"id": 7, "due_date": "2026-06-22", "barcode": None}])
            return _Resp([])

        payload = {
            "sk_supplier": 1182, "amount": 304.0, "due_date": "2026-06-22",
            "document_type": "boleto", "invoice_number": "571854",
            "barcode": "34191234500000304000001112057941590755787812",
        }
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate(payload)

        self.assertIsNotNone(dup)
        self.assertEqual(dup["id"], 7)
        # A consulta da impressao 3 (barcode=is.null) NAO restringe por document_type
        # e casa por fornecedor+valor+vencimento.
        imp3 = next(u for u in urls if "barcode=is.null" in u)
        self.assertNotIn("document_type=eq", imp3)
        self.assertIn("due_date=eq", imp3)
        self.assertIn("amount=eq", imp3)
        self.assertIn("sk_supplier=eq", imp3)


class DedupQueryRetryTest(unittest.TestCase):
    """Robustez: um hiccup de rede na consulta de duplicidade NAO pode virar
    'sem duplicata' (que criaria conta duplicada). A consulta e re-tentada em
    falha transitoria antes de desistir."""

    def test_retry_em_falha_transitoria_acha_duplicata(self):
        ctrl = _ctrl()
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise TimeoutError("hiccup de rede")
            return _Resp([{"id": 99, "due_date": "2026-07-19", "barcode": None}])

        payload = {
            "sk_supplier": 1213, "amount": 49.90, "due_date": "2026-07-19",
            "document_type": "fatura", "invoice_number": "fatura_190726",
        }
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen), \
             mock.patch.object(R.time, "sleep", lambda *a, **k: None):
            dup = ctrl.find_financial_duplicate(payload)

        self.assertIsNotNone(dup)
        self.assertEqual(dup["id"], 99)
        self.assertGreaterEqual(calls["n"], 2)  # re-tentou apos a 1a falha

    def test_desiste_apos_esgotar_tentativas(self):
        ctrl = _ctrl()

        def fake_urlopen(req, timeout=None):
            raise TimeoutError("supabase indisponivel")

        payload = {
            "sk_supplier": 1213, "amount": 49.90, "due_date": "2026-07-19",
            "document_type": "fatura", "invoice_number": "fatura_190726",
        }
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen), \
             mock.patch.object(R.time, "sleep", lambda *a, **k: None):
            dup = ctrl.find_financial_duplicate(payload)

        # Esgotou as tentativas → None (nao bloqueia a insercao), mas tentou N vezes.
        self.assertIsNone(dup)


if __name__ == "__main__":
    unittest.main()
