"""
Teste de robustez da conexão IMAP (read_emails._connect_imap).

Cobre o travamento em que um fetch IMAP sem timeout de socket congelava o run
inteiro (e-mail grande de 3 faturas + XMLs). A conexão deve sempre ser criada
com timeout.
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


class ConnectImapTimeoutTest(unittest.TestCase):
    def test_timeout_padrao_positivo(self):
        self.assertIsInstance(read_emails.IMAP_TIMEOUT_SECONDS, int)
        self.assertGreater(read_emails.IMAP_TIMEOUT_SECONDS, 0)

    def test_connect_imap_passa_timeout(self):
        with mock.patch.object(read_emails.imaplib, "IMAP4_SSL") as M:
            inst = M.return_value
            mail = read_emails._connect_imap()

        # timeout foi passado ao construtor (evita hang infinito num fetch)
        _, kwargs = M.call_args
        self.assertEqual(kwargs.get("timeout"), read_emails.IMAP_TIMEOUT_SECONDS)
        # fluxo de conexao completo
        inst.login.assert_called_once()
        inst.select.assert_called_once()
        self.assertIs(mail, inst)


if __name__ == "__main__":
    unittest.main()
