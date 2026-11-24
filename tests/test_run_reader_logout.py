"""
Teste do fechamento do IMAP em caminho de erro — read_emails.run_reader.

O `try/finally` do laço garante `mail.logout()` mesmo quando algo escapa dele. Desde
2026-11-24 uma exceção COMUM no tratamento de um e-mail não escapa mais: ela é isolada naquele
e-mail (`_on_uid_crash`) e o run segue — antes ela propagava, o run morria naquele UID e todos
os e-mails seguintes ficavam sem leitura, em todo run. Só `BaseException` (Ctrl+C, encerramento
do processo) ainda propaga, e é com ela que a garantia original do logout continua provada.

Os dois caminhos forçam a exceção fora do `try` do fetch do header (em `is_ignored_sender`).
Os demais casos do isolamento por e-mail vivem em `tests/test_run_reader_uid_crash.py`.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Header IMAP mínimo e parseável; _rfc822_from_fetch tolera a tupla intercalada.
_HEADER_FETCH = (
    "OK",
    [
        (b"1 (INTERNALDATE \"01-Jan-2026 10:00:00 +0000\" BODY[HEADER])",
         b"Subject: Teste\r\nMessage-ID: <novo-id>\r\nFrom: alguem@exemplo.com\r\n"
         b"Date: Thu, 01 Jan 2026 10:00:00 +0000\r\n\r\n"),
    ],
)


class RunReaderLogoutOnErrorTest(unittest.TestCase):
    def setUp(self):
        self.mail = mock.MagicMock()
        self.mail.uid.return_value = _HEADER_FETCH

    def _run(self, erro):
        ctrl = mock.MagicMock()
        ctrl._available = False
        # known_ids não-vazio e SEM o msg_id atual → não cai como duplicado,
        # alcançando is_ignored_sender (que vamos forçar a levantar).
        ctrl.load_known_ids.return_value = {"<outro-id>"}

        with mock.patch.object(read_emails, "_connect_and_search",
                               return_value=(self.mail, [b"1"])), \
                mock.patch.object(read_emails, "SupabaseControl", return_value=ctrl), \
                mock.patch.object(read_emails, "is_ignored_sender", side_effect=erro) as filtro:
            try:
                return read_emails.run_reader(all_=True, dry_run=True)
            finally:
                # Anti-vacuidade: o ponto de falha FOI alcançado — sem isto, um header que
                # deixasse de casar faria os dois testes passarem sem exercitar nada.
                filtro.assert_called_once()

    def test_excecao_comum_nao_propaga_e_o_logout_roda(self):
        summary = self._run(RuntimeError("falha inesperada"))
        self.assertEqual(summary["crashed"], 1)
        self.mail.logout.assert_called_once()

    def test_interrupcao_propaga_e_o_logout_roda(self):
        # A garantia original do `finally`: o que escapa do laço não deixa a conexão aberta.
        interrupcao = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self._run(interrupcao)
        self.mail.logout.assert_called_once()


if __name__ == "__main__":
    unittest.main()
