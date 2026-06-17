"""
Teste de retry/backoff do IMAP (F1) — read_emails._connect_and_search.

Sem retry, um hiccup transitório (timeout de socket, conexão abortada) no
connect/select/search derrubava o run inteiro. Agora a sequência é refeita até
IMAP_MAX_ATTEMPTS com backoff. Erro de protocolo/login (IMAP4.error) NÃO repete.
"""

import imaplib
import socket
import sys
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class ConnectAndSearchRetryTest(unittest.TestCase):
    def test_consts_padrao(self):
        self.assertGreaterEqual(read_emails.IMAP_MAX_ATTEMPTS, 1)
        self.assertGreater(read_emails.IMAP_RETRY_BACKOFF, 0)

    def test_sucesso_apos_falha_transitoria(self):
        ok_mail = mock.MagicMock()
        ok_mail.uid.return_value = ("OK", [b"1 2 3"])

        # 1ª tentativa: timeout no connect. 2ª: conecta e busca com sucesso.
        connect = mock.Mock(side_effect=[socket.timeout("estancou"), ok_mail])
        with mock.patch.object(read_emails, "_connect_imap", connect), \
                mock.patch.object(read_emails.time, "sleep") as sleep:
            mail, uids = read_emails._connect_and_search("ALL")

        self.assertIs(mail, ok_mail)
        self.assertEqual(uids, [b"1", b"2", b"3"])
        self.assertEqual(connect.call_count, 2)
        sleep.assert_called_once()  # houve backoff entre as tentativas

    def test_esgota_tentativas_levanta_runtimeerror(self):
        connect = mock.Mock(side_effect=imaplib.IMAP4.abort("conexão caiu"))
        with mock.patch.object(read_emails, "_connect_imap", connect), \
                mock.patch.object(read_emails.time, "sleep"):
            with self.assertRaises(RuntimeError):
                read_emails._connect_and_search("ALL")
        self.assertEqual(connect.call_count, read_emails.IMAP_MAX_ATTEMPTS)

    def test_erro_de_login_nao_repete(self):
        # IMAP4.error puro (credenciais/mailbox) não é transitório: falha na hora.
        connect = mock.Mock(side_effect=imaplib.IMAP4.error("auth falhou"))
        with mock.patch.object(read_emails, "_connect_imap", connect), \
                mock.patch.object(read_emails.time, "sleep"):
            with self.assertRaises(RuntimeError):
                read_emails._connect_and_search("ALL")
        self.assertEqual(connect.call_count, 1)


if __name__ == "__main__":
    unittest.main()
