"""
Teste da guarda CSRF dos endpoints de DISPARO do Flask (S4 M-1).

Os endpoints POST que leem e-mail / reenviam cobrança não têm sessão na frente (a
barreira é o bind localhost). A guarda exige Content-Type application/json (quebra o
CSRF "simples" do navegador) e, opcionalmente, um token de disparo (X-Trigger-Token).
"""

import sys
import unittest
from pathlib import Path

_SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(_SERVER_DIR))

import app as flask_app  # noqa: E402


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
        flask_app._TRIGGER_TOKEN = "segredo-de-disparo"
        # JSON correto mas SEM o header de token → 401.
        r = self.client.post("/api/emails/read", json={})
        self.assertEqual(r.status_code, 401)
        # Com o token correto, a guarda passa (não é 401/415).
        r2 = self.client.post("/api/cobranca/resend/start", json={"ids": [1]},
                              headers={"X-Trigger-Token": "segredo-de-disparo"})
        self.assertNotIn(r2.status_code, (415, 401))


if __name__ == "__main__":
    unittest.main()
