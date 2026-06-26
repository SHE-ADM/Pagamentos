"""
Testes do guard anti-SSRF e da contenção de path do download por link (S4 C-1/C-2/M-2).

Conteúdo de remetente desconhecido controla a URL do boleto; sem guarda, o servidor
poderia ser forçado a requisitar alvos internos (metadata cloud, localhost, LAN). O
guard bloqueia scheme não-http, porta interna e host que resolve para IP interno; o
salvamento é contido em PDF_INBOX.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class SafeDownloadUrlTest(unittest.TestCase):
    def test_bloqueia_metadata_e_loopback(self):
        for url in (
            "http://169.254.169.254/latest/meta-data/",  # metadata cloud
            "http://127.0.0.1:8000/x",                   # loopback + porta interna
            "http://localhost/x",                        # loopback por nome
            "http://0.0.0.0/x",                          # unspecified
            "http://10.0.0.5/x",                         # IP privado
            "http://192.168.1.1/x",                      # IP privado
        ):
            self.assertFalse(read_emails._is_safe_download_url(url), url)

    def test_bloqueia_scheme_e_porta(self):
        self.assertFalse(read_emails._is_safe_download_url("file:///etc/passwd"))
        self.assertFalse(read_emails._is_safe_download_url("ftp://host/x"))
        self.assertFalse(read_emails._is_safe_download_url("http://example.com:22/x"))
        self.assertFalse(read_emails._is_safe_download_url("notaurl"))

    def test_permite_host_publico(self):
        # Host público com .pdf (caminho legítimo BRASPRESS/portais).
        self.assertTrue(read_emails._is_safe_download_url("https://www.braspress.com.br/fatura.pdf"))
        self.assertTrue(read_emails._is_safe_download_url("https://example.com:443/boleto"))

    def test_redirect_handler_revalida_destino(self):
        h = read_emails._SafeRedirectHandler()
        # Um redirect para alvo interno deve levantar (barrar o bypass via 302).
        with self.assertRaises(read_emails.urllib.error.HTTPError):
            h.redirect_request(req=None, fp=None, code=302, msg="Found", headers={},
                               newurl="http://169.254.169.254/")


class InboxContainmentTest(unittest.TestCase):
    def test_dentro_da_inbox_passa_fora_falha(self):
        inbox = read_emails.PDF_INBOX
        self.assertTrue(read_emails._is_within_inbox(inbox / "ok.pdf"))
        # Tentativa de escapar a pasta resolve para fora → barrado.
        self.assertFalse(read_emails._is_within_inbox(inbox / ".." / ".." / "evil.pdf"))


if __name__ == "__main__":
    unittest.main()
