"""
Testes do job assíncrono de leitura + progresso (server/app.py).

Cobre o modelo POST /api/emails/read/start (dispara em background, responde na
hora) + GET /api/emails/progress (poll), incluindo a guarda de concorrência
(um job por vez) e a validação de parâmetros. run_reader é mockado — não toca
IMAP/Supabase.
"""

import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(_SERVER_DIR))

import app as flask_app  # noqa: E402  (server/app.py — insere skills/ no path e importa read_emails)
import read_emails       # noqa: E402  (disponível pelo path inserido em app.py)

SUMMARY = {
    "imap_user": "x@y.com", "supabase_ok": True, "found": 3, "processed": 2,
    "skipped_keyword": 1, "skipped_dup": 0, "new_subjects": [], "dry_run": False,
    "api_aborted": False,
}


def _wait_done(client, timeout=3.0):
    """Faz poll de /progress até running=False (ou estoura o timeout)."""
    deadline = time.time() + timeout
    prog = None
    while time.time() < deadline:
        prog = client.get("/api/emails/progress").get_json()["progress"]
        if not prog["running"]:
            return prog
        time.sleep(0.02)
    return prog


class ParseParamsTest(unittest.TestCase):
    def test_clampa_days(self):
        self.assertEqual(flask_app._parse_read_params({"days": 9999})["days"], flask_app.MAX_DAYS)
        self.assertEqual(flask_app._parse_read_params({"days": -5})["days"], 0)

    def test_days_invalido_lanca(self):
        with self.assertRaises(ValueError):
            flask_app._parse_read_params({"days": "abc"})


class AsyncFlowTest(unittest.TestCase):
    def setUp(self):
        self.client = flask_app.app.test_client()
        with flask_app._progress_lock:
            flask_app._progress["running"] = False

    def test_start_processa_e_progresso_conclui(self):
        def fake_run(on_progress=None, **kw):
            if on_progress:
                on_progress({"phase": "lendo", "total": 3, "done": 0,
                             "processed": 0, "skipped_keyword": 0, "skipped_dup": 0})
                on_progress({"phase": "lendo", "total": 3, "done": 3,
                             "processed": 2, "skipped_keyword": 1, "skipped_dup": 0})
            return dict(SUMMARY)

        with mock.patch.object(read_emails, "run_reader", side_effect=fake_run):
            r = self.client.post("/api/emails/read/start", json={"days": 7})
            self.assertTrue(r.get_json()["started"])
            prog = _wait_done(self.client)

        self.assertFalse(prog["running"])
        self.assertEqual(prog["phase"], "concluído")
        self.assertEqual(prog["summary"]["processed"], 2)
        self.assertEqual(prog["total"], 3)
        self.assertGreaterEqual(prog["elapsed"], 0)

    def test_guarda_de_concorrencia(self):
        gate = threading.Event()

        def slow_run(on_progress=None, **kw):
            gate.wait(2)
            return dict(SUMMARY)

        try:
            with mock.patch.object(read_emails, "run_reader", side_effect=slow_run):
                r1 = self.client.post("/api/emails/read/start", json={})
                self.assertTrue(r1.get_json()["started"])
                # Segundo disparo enquanto o primeiro roda → recusado.
                r2 = self.client.post("/api/emails/read/start", json={}).get_json()
                self.assertFalse(r2["started"])
                self.assertTrue(r2["already_running"])
        finally:
            gate.set()
        self.assertIsNotNone(_wait_done(self.client))

    def test_erro_no_job_vira_phase_erro(self):
        def boom_run(on_progress=None, **kw):
            raise RuntimeError("IMAP caiu")

        with mock.patch.object(read_emails, "run_reader", side_effect=boom_run):
            self.client.post("/api/emails/read/start", json={})
            prog = _wait_done(self.client)

        self.assertEqual(prog["phase"], "erro")
        self.assertIn("IMAP caiu", prog["error"])

    def test_start_days_invalido_400(self):
        r = self.client.post("/api/emails/read/start", json={"days": "abc"})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(r.get_json()["ok"])


if __name__ == "__main__":
    unittest.main()
