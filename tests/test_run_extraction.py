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


class RunExtractionOnceInProcessTest(unittest.TestCase):
    """Classificacao transitorio/definitivo do _run_extraction_once IN-PROCESS.

    A extracao roda no MESMO processo (sem subprocesso) — correcao do rc=0xC0000142
    (STATUS_DLL_INIT_FAILED) que derrubava 100% das extracoes quando o spawn partia
    do Flask. Aqui o patch e em extract_pdf.extract_to_csv (via sys.modules), nao mais
    em subprocess.run.
    """

    def _patch_extract(self, fn):
        fake = mock.Mock()
        fake.extract_to_csv = fn
        return mock.patch.dict(sys.modules, {"extract_pdf": fake})

    def test_sucesso_move_csv_para_output(self):
        def fake(pdf_path, out_dir, *, pdf_passwords=None):
            p = Path(out_dir) / "20260101_000000_extracted.csv"
            p.write_text("col\nval\n", encoding="utf-8")
            return p
        with self._patch_extract(fake):
            csv, reason, transient = read_emails._run_extraction_once(Path("x.pdf"))
        self.assertIsNotNone(csv)
        self.addCleanup(lambda: Path(csv).unlink(missing_ok=True))
        self.assertTrue(csv.endswith("_extracted.csv"))
        self.assertTrue(Path(csv).exists())          # movido para o dir definitivo
        self.assertIsNone(reason)
        self.assertFalse(transient)

    def test_sem_registros_e_definitivo(self):
        # extract_to_csv devolve None (PDF sem registros extraiveis) -> nao repete
        with self._patch_extract(lambda pdf, out, *, pdf_passwords=None: None):
            csv, reason, transient = read_emails._run_extraction_once(Path("x.pdf"))
        self.assertIsNone(csv)
        self.assertFalse(transient)
        self.assertIn("registros", reason)

    def test_excecao_e_transitorio(self):
        def boom(pdf, out, *, pdf_passwords=None):
            raise RuntimeError("lib nativa caiu")
        with self._patch_extract(boom):
            csv, reason, transient = read_emails._run_extraction_once(Path("x.pdf"))
        self.assertIsNone(csv)
        self.assertTrue(transient)
        self.assertIn("in-process", reason)


if __name__ == "__main__":
    unittest.main()
