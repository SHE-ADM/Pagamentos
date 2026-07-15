"""
Registro do anexo do pipeline em financial_account_attachment (migration 079).

O upload no Storage roda no Passo 1 (antes da conta existir); o VÍNCULO só pode ser feito
depois, no Passo 2, quando `register_financial` devolve o id. Por isso ele passou a retornar
`int | None` em vez de bool — os call sites `if ctrl.register_financial(...)` seguem válidos
(id é sempre truthy; None é falsy).
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


class RegisterFinancialReturnsIdTest(unittest.TestCase):
    """O contrato novo: devolve o id da conta (para vincular o anexo)."""

    def test_devolve_o_id_da_linha_gravada(self):
        ctrl = _ctrl()
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen["url"] = req.full_url
            seen["prefer"] = req.headers.get("Prefer")
            return _Resp([{"id": 512}])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            got = ctrl.register_financial({"gmail_message_id": "<m>", "sk_supplier": 1,
                                           "amount": 10, "created_by": UUID})

        self.assertEqual(got, 512)
        # representation + select=id é o que faz o id voltar; no upsert devolve a linha MESCLADA.
        self.assertIn("select=id", seen["url"])
        self.assertIn("return=representation", seen["prefer"])
        self.assertIn("resolution=merge-duplicates", seen["prefer"])

    def test_resposta_vazia_devolve_none(self):
        ctrl = _ctrl()
        with mock.patch.object(R.urllib.request, "urlopen", lambda req, timeout=None: _Resp([])):
            self.assertIsNone(ctrl.register_financial({"gmail_message_id": "<m>", "created_by": UUID}))

    def test_erro_http_devolve_none_e_nao_levanta(self):
        ctrl = _ctrl()

        def boom(req, timeout=None):
            raise R.urllib.error.HTTPError(req.full_url, 400, "bad", {}, None)

        with mock.patch.object(R.urllib.request, "urlopen", boom):
            # O call site é `if ctrl.register_financial(...)`: None (falsy) mantém o
            # comportamento antigo de False — registra db_erro em vez de contar a conta.
            self.assertIsNone(ctrl.register_financial({"gmail_message_id": "<m>", "created_by": UUID}))


class RegisterAttachmentTest(unittest.TestCase):
    def test_payload_do_anexo_do_pipeline(self):
        ctrl = _ctrl()
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen["url"] = req.full_url
            seen["prefer"] = req.headers.get("Prefer")
            seen["body"] = json.loads(req.data.decode())
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ok = ctrl.register_attachment(512, "ester_RES_HYOSUNG_20260708.pdf",
                                          size_bytes=2048, uploaded_by=UUID)

        self.assertTrue(ok)
        self.assertEqual(seen["body"], {
            "account_id": 512,
            # Chave do pipeline = nome FLAT (sem pasta) — o anexo manual usa `manual/{id}/…`.
            "storage_key": "ester_RES_HYOSUNG_20260708.pdf",
            "file_name": "ester_RES_HYOSUNG_20260708.pdf",
            "mime_type": "application/pdf",
            "size_bytes": 2048,
            "origin": "pipeline",
            "uploaded_by": UUID,
        })
        # Idempotência: reprocessar o mesmo e-mail não duplica o anexo.
        self.assertIn("on_conflict=account_id,storage_key", seen["url"])
        self.assertIn("resolution=ignore-duplicates", seen["prefer"])

    def test_mime_por_extensao_para_imagem(self):
        ctrl = _ctrl()
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen["body"] = json.loads(req.data.decode())
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.register_attachment(1, "recibo_correios.JPG")

        self.assertEqual(seen["body"]["mime_type"], "image/jpeg")  # extensão é case-insensitive

    def test_extensao_desconhecida_cai_no_octet_stream(self):
        ctrl = _ctrl()
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen["body"] = json.loads(req.data.decode())
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.register_attachment(1, "arquivo.xyz")

        self.assertEqual(seen["body"]["mime_type"], "application/octet-stream")

    def test_sem_uploaded_by_omite_a_coluna(self):
        ctrl = _ctrl()
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen["body"] = json.loads(req.data.decode())
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.register_attachment(1, "x.pdf")

        # Sem o autor, o DEFAULT da coluna (sentinela) assume — não enviar NULL.
        self.assertNotIn("uploaded_by", seen["body"])

    def test_erro_http_e_nao_fatal(self):
        ctrl = _ctrl()

        def boom(req, timeout=None):
            raise R.urllib.error.HTTPError(req.full_url, 409, "conflict", {}, None)

        with mock.patch.object(R.urllib.request, "urlopen", boom):
            # A conta já está gravada e é o artefato primário: falhar aqui não pode derrubar
            # o processamento (o anexo cai no fallback legacySourceFile da UI).
            self.assertFalse(ctrl.register_attachment(1, "x.pdf"))

    def test_erro_generico_e_nao_fatal(self):
        ctrl = _ctrl()

        def boom(req, timeout=None):
            raise OSError("rede caiu")

        with mock.patch.object(R.urllib.request, "urlopen", boom):
            self.assertFalse(ctrl.register_attachment(1, "x.pdf"))

    def test_sem_supabase_disponivel_nao_faz_request(self):
        ctrl = _ctrl()
        ctrl._available = False

        def nunca(req, timeout=None):
            raise AssertionError("não deve chamar a rede quando o Supabase está indisponível")

        with mock.patch.object(R.urllib.request, "urlopen", nunca):
            self.assertFalse(ctrl.register_attachment(1, "x.pdf"))


class ResolveUserCacheTest(unittest.TestCase):
    """O anexo do pipeline herda o DONO da conta (igual ao backfill da 079).

    O call site NÃO pode usar `payload.get("created_by")`: register_financial resolve o dono
    numa CÓPIA local do payload, então o dict do chamador nunca o recebe e o anexo cairia
    sempre no sentinela — divergindo do histórico. Ele chama resolve_user, que é cacheado
    para a chamada extra não custar uma RPC.
    """

    def test_resolve_user_cacheia_por_email(self):
        ctrl = _ctrl()
        chamadas = []

        def fake_urlopen(req, timeout=None):
            chamadas.append(json.loads(req.data.decode())["p_email"])
            return _Resp(UUID)

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            a = ctrl.resolve_user("ester@otimotex.com.br")
            b = ctrl.resolve_user("ester@otimotex.com.br")
            c = ctrl.resolve_user("ESTER@Otimotex.com.br ")  # mesma chave (case/espaço)

        self.assertEqual([a, b, c], [UUID, UUID, UUID])
        self.assertEqual(len(chamadas), 1, "a mesma caixa repete o remetente — 1 RPC basta")

    def test_emails_diferentes_nao_compartilham_cache(self):
        ctrl = _ctrl()
        chamadas = []

        def fake_urlopen(req, timeout=None):
            chamadas.append(json.loads(req.data.decode())["p_email"])
            return _Resp(UUID)

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.resolve_user("a@x.com")
            ctrl.resolve_user("b@x.com")

        self.assertEqual(chamadas, ["a@x.com", "b@x.com"])

    def test_falha_nao_e_cacheada(self):
        ctrl = _ctrl()
        tentativas = []

        def boom(req, timeout=None):
            tentativas.append(1)
            raise OSError("rede caiu")

        with mock.patch.object(R.urllib.request, "urlopen", boom):
            self.assertIsNone(ctrl.resolve_user("a@x.com"))
            self.assertIsNone(ctrl.resolve_user("a@x.com"))

        # Cachear a falha condenaria o resto do run ao sentinela por um blip de rede.
        self.assertEqual(len(tentativas), 2)


if __name__ == "__main__":
    unittest.main()
