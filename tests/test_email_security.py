"""
Testes de segurança do e-mail de cobrança (S4 A-1/A-2/A-3):
- HTML escape do nome/título vindos do Firebird (template.py).
- Sanitização de CRLF em Subject e descarte de Cc com quebra de linha (email_sender.py).
"""

import sys
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "cobranca-vencidos" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import template  # noqa: E402
import email_sender  # noqa: E402


class TemplateEscapeTest(unittest.TestCase):
    def test_escapa_html_do_nome_e_titulo(self):
        html = template.render_html(
            customer_name='<img src=x onerror=alert(1)>',
            document_id='<script>evil()</script>',
            bill_amount=Decimal("1250.50"),
            due_date=date(2026, 6, 26),
        )
        # As tags hostis não aparecem cruas; entram escapadas.
        self.assertNotIn("<img src=x", html)
        self.assertNotIn("<script>evil", html)
        self.assertIn("&lt;img", html)
        self.assertIn("&lt;script&gt;", html)
        # O valor formatado (server-side) segue presente.
        self.assertIn("1.250,50", html)


class HeaderInjectionTest(unittest.TestCase):
    def test_strip_crlf_no_subject(self):
        out = email_sender._strip_crlf("COBRANCA\r\nBcc: attacker@evil.com")
        # O CRLF é neutralizado (sem \r/\n) → o "Bcc:" injetado vira texto no mesmo header.
        self.assertNotIn("\r", out)
        self.assertNotIn("\n", out)
        self.assertTrue(out.startswith("COBRANCA"))

    def test_cc_com_quebra_de_linha_e_descartado(self):
        self.assertIsNone(email_sender._safe_address("rep@x.com\r\nBcc: evil@e.com"))
        self.assertIsNone(email_sender._safe_address(""))
        # Endereço válido passa intacto.
        self.assertEqual(email_sender._safe_address("rep@x.com"), "rep@x.com")

    def test_from_com_crlf_e_sanitizado(self):
        # from_name/from_addr (env / company do Supabase) com CRLF não podem injetar header
        # no From — S4-4. O header montado não contém \r/\n.
        msg = email_sender._build_message(
            {"from_name": "Otimotex\r\nBcc: evil@e.com", "from_addr": "fin@otimotex.com.br\r\nX: y"},
            subject="COBRANCA",
            html_body="<p>x</p>",
            actual_to="cliente@x.com",
            actual_cc=None,
        )
        from_header = msg["From"]
        self.assertNotIn("\r", from_header)
        self.assertNotIn("\n", from_header)
        self.assertIn("Otimotex", from_header)


class TlsContextTest(unittest.TestCase):
    """O STARTTLS do SMTP usa contexto seguro: valida certificado + hostname e
    rejeita protocolos < TLS 1.2 (S4423 — defesa em profundidade)."""

    def test_contexto_valida_certificado_e_hostname(self):
        import ssl

        ctx = email_sender._secure_tls_context()
        self.assertTrue(ctx.check_hostname)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)

    def test_minimo_tls_1_2(self):
        import ssl

        ctx = email_sender._secure_tls_context()
        self.assertEqual(ctx.minimum_version, ssl.TLSVersion.TLSv1_2)
        # SSLv3/TLS 1.0/1.1 ficam abaixo do mínimo → recusados.
        self.assertGreater(ctx.minimum_version, ssl.TLSVersion.TLSv1_1)


if __name__ == "__main__":
    unittest.main()
