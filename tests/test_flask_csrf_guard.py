"""
Teste da guarda CSRF dos endpoints de DISPARO do Flask (S4 M-1).

Os endpoints POST que leem e-mail / reenviam cobrança não têm sessão na frente (a
barreira é o bind localhost). A guarda exige Content-Type application/json (quebra o
CSRF "simples" do navegador) e, opcionalmente, um token de disparo (X-Trigger-Token).
"""

import sys
import unittest
import uuid
from pathlib import Path

_SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(_SERVER_DIR))

import app as flask_app  # noqa: E402

# Token sintético SÓ para os testes — gerado em runtime (não é literal nem
# credencial real). Evita o achado do SonarCloud "hard-coded secret" (S6418/
# former-hotspot) que uma string fixa como "segredo-de-disparo" dispara.
_FAKE_TRIGGER_TOKEN = "test-" + uuid.uuid4().hex


class FlaskTriggerGuardTest(unittest.TestCase):
    def setUp(self):
        self.client = flask_app.app.test_client()
        self._orig_token = flask_app._TRIGGER_TOKEN

    def tearDown(self):
        flask_app._TRIGGER_TOKEN = self._orig_token

    def test_sem_content_type_json_bloqueia_415(self):
        # POST sem Content-Type application/json (CSRF simples) → 415, antes de qualquer ação.
        r = self.client.post("/api/cobranca/resend/start", data="ids=1",
                             content_type="text/plain")
        self.assertEqual(r.status_code, 415)

    def test_com_json_passa_a_guarda(self):
        # Content-Type correto → a guarda passa (a resposta NÃO é 415/401). Sem SMTP
        # pronto no ambiente de teste, o endpoint responde 503 (reenvio indisponível).
        flask_app._TRIGGER_TOKEN = ""
        r = self.client.post("/api/cobranca/resend/start", json={"ids": [1]})
        self.assertNotIn(r.status_code, (415, 401))

    def test_token_exigido_quando_configurado(self):
        flask_app._TRIGGER_TOKEN = _FAKE_TRIGGER_TOKEN
        # JSON correto mas SEM o header de token → 401.
        r = self.client.post("/api/emails/read", json={})
        self.assertEqual(r.status_code, 401)
        # Com o token correto, a guarda passa (não é 401/415).
        r2 = self.client.post("/api/cobranca/resend/start", json={"ids": [1]},
                              headers={"X-Trigger-Token": _FAKE_TRIGGER_TOKEN})
        self.assertNotIn(r2.status_code, (415, 401))


class BindTokenRequirementTest(unittest.TestCase):
    """S4-2: fora de loopback, FLASK_TRIGGER_TOKEN é obrigatório (falha no boot)."""

    def test_loopback_nao_exige_token(self):
        for host in ("127.0.0.1", "localhost", "::1", "127.0.0.5"):
            flask_app._require_trigger_token_if_exposed(host, token="")  # não levanta

    def test_exposto_sem_token_falha_no_boot(self):
        for host in ("0.0.0.0", "192.168.0.10"):
            with self.assertRaises(RuntimeError):
                flask_app._require_trigger_token_if_exposed(host, token="")

    def test_exposto_com_token_sobe(self):
        flask_app._require_trigger_token_if_exposed("0.0.0.0", token=_FAKE_TRIGGER_TOKEN)  # ok


if __name__ == "__main__":
    unittest.main()
