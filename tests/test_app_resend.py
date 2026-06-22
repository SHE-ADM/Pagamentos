"""
Testes das rotas de reenvio de cobranca (server/app.py):
  GET  /api/cobranca/resend/health    -> prontidao (habilita/desabilita o botao)
  POST /api/cobranca/resend/start     -> dispara o job em thread
  GET  /api/cobranca/resend/progress  -> poll

resend.resend_ready / resend.resend_erros sao mockados — nao toca SMTP/Supabase.
"""

import sys
import time
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(_SERVER_DIR))

import app as flask_app  # noqa: E402  (insere skills/ no path e importa resend)
import resend            # noqa: E402  (disponivel pelo path inserido em app.py)


def _wait_done(client, timeout=3.0):
    deadline = time.time() + timeout
    prog = None
    while time.time() < deadline:
        prog = client.get("/api/cobranca/resend/progress").get_json()["progress"]
        if not prog["running"]:
            return prog
        time.sleep(0.02)
    return prog


class ResendHealthTest(unittest.TestCase):
    def setUp(self):
        self.client = flask_app.app.test_client()

    def test_health_pronto(self):
        with mock.patch.object(resend, "resend_ready", return_value=(True, None)):
            r = self.client.get("/api/cobranca/resend/health").get_json()
        self.assertTrue(r["ready"])
        self.assertIsNone(r["reason"])

    def test_health_nao_pronto_traz_motivo(self):
        with mock.patch.object(resend, "resend_ready", return_value=(False, "SMTP não configurado.")):
            r = self.client.get("/api/cobranca/resend/health").get_json()
        self.assertFalse(r["ready"])
        self.assertIn("SMTP", r["reason"])


class ResendStartTest(unittest.TestCase):
    def setUp(self):
        self.client = flask_app.app.test_client()
        with flask_app._resend_lock:
            flask_app._resend["running"] = False

    def test_start_sem_backend_pronto_503(self):
        with mock.patch.object(resend, "resend_ready", return_value=(False, "offline")):
            r = self.client.post("/api/cobranca/resend/start", json={"ids": [1]})
        self.assertEqual(r.status_code, 503)
        self.assertFalse(r.get_json()["ok"])

    def test_start_ids_invalidos_422(self):
        with mock.patch.object(resend, "resend_ready", return_value=(True, None)):
            for body in ({"ids": []}, {"ids": "abc"}, {"ids": [1, "x"]}, {}):
                r = self.client.post("/api/cobranca/resend/start", json=body)
                self.assertEqual(r.status_code, 422, body)

    def test_start_processa_e_conclui(self):
        def fake_resend(ids, on_progress=None):
            if on_progress:
                on_progress({"phase": "enviando", "total": len(ids), "done": len(ids),
                             "sent": len(ids), "skipped": 0, "no_email": 0, "error": 0})
            return {"total": len(ids), "sent": len(ids), "skipped": 0, "no_email": 0,
                    "error": 0, "results": [{"id": i, "document_id": str(i),
                                             "status": "sent", "message": "Enviado."} for i in ids]}

        with mock.patch.object(resend, "resend_ready", return_value=(True, None)), \
             mock.patch.object(resend, "resend_erros", side_effect=fake_resend):
            r = self.client.post("/api/cobranca/resend/start", json={"ids": [1, 2]})
            self.assertTrue(r.get_json()["started"])
            prog = _wait_done(self.client)

        self.assertFalse(prog["running"])
        self.assertEqual(prog["phase"], "concluído")
        self.assertEqual(prog["sent"], 2)
        self.assertEqual(len(prog["results"]), 2)

    def test_guarda_de_concorrencia(self):
        import threading
        gate = threading.Event()

        def slow(ids, on_progress=None):
            gate.wait(2)
            return {"total": 0, "sent": 0, "skipped": 0, "no_email": 0, "error": 0, "results": []}

        try:
            with mock.patch.object(resend, "resend_ready", return_value=(True, None)), \
                 mock.patch.object(resend, "resend_erros", side_effect=slow):
                r1 = self.client.post("/api/cobranca/resend/start", json={"ids": [1]})
                self.assertTrue(r1.get_json()["started"])
                r2 = self.client.post("/api/cobranca/resend/start", json={"ids": [2]}).get_json()
                self.assertFalse(r2["started"])
                self.assertTrue(r2["already_running"])
        finally:
            gate.set()
        self.assertIsNotNone(_wait_done(self.client))


if __name__ == "__main__":
    unittest.main()
