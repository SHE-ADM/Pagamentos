"""
Testes de robustez do run_extraction (read_emails.py).

Cobre o comportamento exposto na busca geral em que ~134 PDFs falharam de forma
transitoria e o motivo nao ficava observavel: agora ha retry com backoff em falha
transitoria, sem retry em falha definitiva, e o motivo e propagado ao chamador
(que o grava em email_processing_errors).
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

# O modulo vive em skills/email-reader/scripts/ (diretorio com hifen — nao
# importavel como pacote). Adiciona o caminho ao sys.path, como server/app.py faz.
_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class RunExtractionRetryTest(unittest.TestCase):
    """Loop de retry — patch em _run_extraction_once para isolar a logica."""

    def setUp(self):
        # time.sleep nao deve atrasar os testes
        self._sleep = mock.patch.object(read_emails.time, "sleep").start()
        self.addCleanup(mock.patch.stopall)

    def test_sucesso_na_primeira_tentativa(self):
        with mock.patch.object(read_emails, "_run_extraction_once",
                               return_value=("out.csv", None, False)) as once:
            csv, reason = read_emails.run_extraction(Path("x.pdf"))
        self.assertEqual(csv, "out.csv")
        self.assertIsNone(reason)
        self.assertEqual(once.call_count, 1)
        self._sleep.assert_not_called()

    def test_transitorio_depois_sucesso_repete(self):
        seq = [(None, "rc=1: boom", True), ("out.csv", None, False)]
        with mock.patch.object(read_emails, "_run_extraction_once",
                               side_effect=seq) as once:
            csv, reason = read_emails.run_extraction(Path("x.pdf"))
        self.assertEqual(csv, "out.csv")
        self.assertIsNone(reason)
        self.assertEqual(once.call_count, 2)        # repetiu uma vez
        self.assertEqual(self._sleep.call_count, 1)

    def test_transitorio_persistente_esgota_tentativas(self):
        with mock.patch.object(read_emails, "_run_extraction_once",
                               return_value=(None, "timeout (>180s) na extração", True)) as once:
            csv, reason = read_emails.run_extraction(Path("x.pdf"))
        self.assertIsNone(csv)
        self.assertIn("timeout", reason)
        self.assertEqual(once.call_count, read_emails.EXTRACTION_MAX_ATTEMPTS)

    def test_falha_definitiva_nao_repete(self):
        # rc=0 sem CSV = nada a extrair: repetir nao muda nada -> 1 tentativa so
        with mock.patch.object(read_emails, "_run_extraction_once",
                               return_value=(None, "rc=0 sem CSV: ...", False)) as once:
            csv, reason = read_emails.run_extraction(Path("x.pdf"))
        self.assertIsNone(csv)
        self.assertIn("sem CSV", reason)
        self.assertEqual(once.call_count, 1)
        self._sleep.assert_not_called()


class RunExtractionOnceClassificationTest(unittest.TestCase):
    """Classificacao transitorio/definitivo — patch em subprocess.run."""

    def _fake_proc(self, returncode, stderr="", stdout=""):
        m = mock.Mock()
        m.returncode = returncode
        m.stderr = stderr
        m.stdout = stdout
        return m

    def test_rc_diferente_de_zero_e_transitorio(self):
        with mock.patch.object(read_emails.subprocess, "run",
                               return_value=self._fake_proc(1, stderr="ImportError: x")):
            csv, reason, transient = read_emails._run_extraction_once(Path("x.pdf"))
        self.assertIsNone(csv)
        self.assertTrue(transient)
        self.assertIn("rc=1", reason)
        self.assertIn("ImportError", reason)

    def test_rc_zero_sem_csv_e_definitivo(self):
        # tmp_out real fica vazio -> glob nao acha CSV -> definitivo
        with mock.patch.object(read_emails.subprocess, "run",
                               return_value=self._fake_proc(0, stdout="nada extraido")):
            csv, reason, transient = read_emails._run_extraction_once(Path("x.pdf"))
        self.assertIsNone(csv)
        self.assertFalse(transient)
        self.assertIn("sem CSV", reason)

    def test_timeout_e_transitorio(self):
        import subprocess as sp
        with mock.patch.object(read_emails.subprocess, "run",
                               side_effect=sp.TimeoutExpired(cmd="x", timeout=180)):
            csv, reason, transient = read_emails._run_extraction_once(Path("x.pdf"))
        self.assertIsNone(csv)
        self.assertTrue(transient)
        self.assertIn("timeout", reason)


if __name__ == "__main__":
    unittest.main()
