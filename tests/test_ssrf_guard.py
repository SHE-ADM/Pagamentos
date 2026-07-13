"""
Testes do guard anti-SSRF e da contenção de path do download por link (S4 C-1/C-2/M-2).

Conteúdo de remetente desconhecido controla a URL do boleto; sem guarda, o servidor
poderia ser forçado a requisitar alvos internos (metadata cloud, localhost, LAN). O
guard bloqueia scheme não-http, porta interna e host que resolve para IP interno; o
salvamento é contido em PDF_INBOX.
"""

import socket
import sys
import unittest
from unittest import mock
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


def _gai(*ips):
    """Fabrica um retorno de socket.getaddrinfo (family, type, proto, canonname, sockaddr)."""
    out = []
    for ip in ips:
        sockaddr = (ip, 0, 0, 0) if ":" in ip else (ip, 0)
        fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
        out.append((fam, socket.SOCK_STREAM, 6, "", sockaddr))
    return out


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


class IpPinningTest(unittest.TestCase):
    """S4-1/S4-3: pin do IP validado (fecha o DNS rebinding) + IPv6 IPv4-mapeado."""

    def test_pin_retorna_ip_externo(self):
        with mock.patch.object(read_emails.socket, "getaddrinfo", return_value=_gai("93.184.216.34")):
            self.assertEqual(read_emails._pin_ip_for_host("example.com"), "93.184.216.34")

    def test_pin_bloqueia_host_interno(self):
        with mock.patch.object(read_emails.socket, "getaddrinfo", return_value=_gai("127.0.0.1")):
            self.assertIsNone(read_emails._pin_ip_for_host("rebind.evil"))

    def test_ipv4_mapeado_interno_bloqueado(self):
        # ::ffff:169.254.169.254 (metadata cloud via IPv6 mapeado) deve ser barrado (S4-3).
        with mock.patch.object(read_emails.socket, "getaddrinfo",
                               return_value=_gai("::ffff:169.254.169.254")):
            self.assertFalse(read_emails._host_is_safe("mapped.evil"))
            self.assertIsNone(read_emails._pin_ip_for_host("mapped.evil"))

    def test_conexao_usa_ip_fixado_sem_reresolver(self):
        # A conexão conecta ao IP FIXADO (validado), não ao hostname — um rebinding (2ª
        # resolução para IP interno) não é usado, pois o socket não re-resolve o nome.
        conn = read_emails._PinnedHTTPConnection("example.com", pinned_ip="93.184.216.34")
        with mock.patch.object(conn, "_create_connection", return_value=mock.MagicMock()) as cc:
            conn.connect()
        self.assertEqual(cc.call_args.args[0], ("93.184.216.34", conn.port))

    def test_factory_bloqueia_quando_resolve_interno(self):
        # Se o host resolve para IP interno no momento do pin, a fábrica levanta (bloqueia)
        # ANTES de qualquer connect — cobre o download e cada redirect.
        with mock.patch.object(read_emails.socket, "getaddrinfo", return_value=_gai("10.0.0.9")):
            with self.assertRaises(read_emails.urllib.error.URLError):
                read_emails._pinned_conn_factory(
                    read_emails._PinnedHTTPConnection, "http://rebind.evil/boleto.pdf")

    def test_opener_seguro_instala_handlers_de_pin(self):
        # O opener de download instala os handlers de pin (substituem os HTTP/HTTPS default)
        # — garante que o pin de IP está no caminho real, não só nas funções soltas.
        opener = read_emails._build_safe_opener()
        classes = {type(h) for h in opener.handlers}
        self.assertIn(read_emails._PinnedHTTPHandler, classes)
        self.assertIn(read_emails._PinnedHTTPSHandler, classes)
        # Entradas de dispatch do urllib (chamadas por reflexão via <scheme>_open).
        self.assertTrue(callable(read_emails._PinnedHTTPHandler.http_open))
        self.assertTrue(callable(read_emails._PinnedHTTPSHandler.https_open))


class InboxContainmentTest(unittest.TestCase):
    def test_dentro_da_inbox_passa_fora_falha(self):
        inbox = read_emails.PDF_INBOX
        self.assertTrue(read_emails._is_within_inbox(inbox / "ok.pdf"))
        # Tentativa de escapar a pasta resolve para fora → barrado.
        self.assertFalse(read_emails._is_within_inbox(inbox / ".." / ".." / "evil.pdf"))


class PinnedHttpsHandlerPy312PlusTest(unittest.TestCase):
    """Regressão Python 3.12+/3.14: HTTPSHandler NAO tem mais `_check_hostname`
    (absorvido pelo `context`). Referenciá-lo direto levantava AttributeError e
    quebrava TODO download de link HTTPS (BRASPRESS e qualquer portal). O handler
    deve passar `context` e omitir `check_hostname` quando o atributo nao existe."""

    def test_https_open_sem_check_hostname_nao_quebra(self):
        h = read_emails._PinnedHTTPSHandler()
        # Simula Python 3.12+ (atributo ausente).
        if hasattr(h, "_check_hostname"):
            del h._check_hostname

        captured = {}

        def fake_do_open(conn_factory, req, **kwargs):
            captured.update(kwargs)
            return "resp"

        h.do_open = fake_do_open  # evita abrir socket real

        class _Req:
            full_url = "https://example.com/x"

        # Sem a correção, isto levantava AttributeError('_check_hostname').
        with mock.patch.object(read_emails, "_pin_ip_for_host", return_value="93.184.216.34"):
            out = h.https_open(_Req())

        self.assertEqual(out, "resp")
        self.assertIn("context", captured)             # context sempre passado (preserva TLS)
        self.assertNotIn("check_hostname", captured)   # omitido em 3.12+


if __name__ == "__main__":
    unittest.main()
