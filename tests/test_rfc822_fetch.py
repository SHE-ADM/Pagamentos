"""
Testes para _rfc822_from_fetch (read_emails.py).

Regressao: quando o imaplib INTERCALA respostas (ex.: um FLAGS/UID isolado como
item `bytes`) no resultado do FETCH, `data[0]` deixa de ser a tupla (meta, raw)
e `data[0][1]` passa a indexar um `bytes`, devolvendo um INT — quebrando
email.message_from_bytes com "'int' object has no attribute 'decode'".
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

_META = b'85 (UID 14777 INTERNALDATE "03-Jun-2026 16:07:13 -0300" RFC822 {12}'
_RAW = b"From: a@b\r\n\r\n"


class Rfc822FromFetchTest(unittest.TestCase):
    def test_resposta_normal(self):
        data = [(_META, _RAW), b")"]
        meta, raw = read_emails._rfc822_from_fetch(data)
        self.assertEqual(meta, _META)
        self.assertEqual(raw, _RAW)

    def test_resposta_intercalada_pega_a_tupla_certa(self):
        # FLAGS/UID isolado ANTES do conteudo — a versao antiga pegava data[0][1]
        # (um int) e quebrava. O helper deve achar a tupla com os bytes RFC822.
        data = [b"86 (FLAGS (\\Seen) UID 14778)", (_META, _RAW), b")"]
        _, raw = read_emails._rfc822_from_fetch(data)
        self.assertEqual(raw, _RAW)
        # E o resultado alimenta message_from_bytes sem erro de int.decode.
        import email
        msg = email.message_from_bytes(raw)
        self.assertEqual(msg.get("From"), "a@b")

    def test_sem_conteudo_levanta(self):
        with self.assertRaises(ValueError):
            read_emails._rfc822_from_fetch([b"85 (FLAGS (\\Seen))", b")"])

    def test_data_vazia_levanta(self):
        with self.assertRaises(ValueError):
            read_emails._rfc822_from_fetch([])


if __name__ == "__main__":
    unittest.main()
