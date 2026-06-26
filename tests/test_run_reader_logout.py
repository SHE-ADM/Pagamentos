"""
Teste do fechamento do IMAP em caminho de erro — read_emails.run_reader.

Sem o try/finally, uma exceção inesperada que escapasse do loop principal
deixaria a conexão IMAP aberta (logout pulado). Este teste força uma exceção
fora do try interno (is_ignored_sender) e prova que mail.logout() ainda roda e
que a exceção original é propagada.
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
    def test_logout_chamado_mesmo_com_excecao_no_loop(self):
        mail = mock.MagicMock()
        mail.uid.return_value = _HEADER_FETCH

        ctrl = mock.MagicMock()
        ctrl._available = False
        # known_ids não-vazio e SEM o msg_id atual → não cai como duplicado,
        # alcançando is_ignored_sender (que vamos forçar a levantar).
        ctrl.load_known_ids.return_value = {"<outro-id>"}

        with mock.patch.object(read_emails, "_connect_and_search",
                               return_value=(mail, [b"1"])), \
                mock.patch.object(read_emails, "SupabaseControl", return_value=ctrl), \
                mock.patch.object(read_emails, "is_ignored_sender",
                                  side_effect=RuntimeError("falha inesperada")):
            with self.assertRaises(RuntimeError):
                read_emails.run_reader(all_=True, dry_run=True)

        mail.logout.assert_called_once()


if __name__ == "__main__":
    unittest.main()
