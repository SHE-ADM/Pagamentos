"""Testes de save_attachments (read_emails.py): salva PDF e anexo de IMAGEM;
ignora imagem inline (logo/assinatura embutida)."""

import sys
import tempfile
import unittest
from email.message import EmailMessage
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class SaveAttachmentsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_inbox = read_emails.PDF_INBOX
        read_emails.PDF_INBOX = Path(self._tmp.name)

    def tearDown(self):
        read_emails.PDF_INBOX = self._orig_inbox
        self._tmp.cleanup()

    def _build_msg(self):
        msg = EmailMessage()
        msg["Subject"] = "Reembolso postagem"
        msg.set_content("corpo")
        msg.add_attachment(b"%PDF-1.4 fake", maintype="application",
                           subtype="pdf", filename="boleto.pdf")
        msg.add_attachment(b"\x89PNG fake", maintype="image",
                           subtype="png", filename="recibo.png")
        # Imagem INLINE (logo/assinatura) — NÃO deve ser salva.
        msg.add_attachment(b"logo bytes", maintype="image", subtype="png",
                           filename="logo.png", disposition="inline")
        return msg

    def test_salva_pdf_e_imagem_anexa_ignora_inline(self):
        saved = read_emails.save_attachments(
            self._build_msg(), "rose@otimotex.com.br",
            "Reembolso postagem", "2026-06-19T14:38:01+00:00")
        names = sorted(p.name for p in saved)
        # 2 anexos salvos: o PDF e a imagem anexada (a inline foi ignorada).
        self.assertEqual(len(saved), 2, names)
        exts = sorted(p.suffix.lower() for p in saved)
        self.assertEqual(exts, [".pdf", ".png"])
        self.assertTrue(all(p.exists() for p in saved))
        self.assertFalse(any("logo" in p.name for p in saved))


class SaveInlineImagesTest(unittest.TestCase):
    """Fallback de imagem INLINE: salva só a MAIOR acima do limiar (recibo colado),
    ignorando logos pequenos e imagens inline menores."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_inbox = read_emails.PDF_INBOX
        read_emails.PDF_INBOX = Path(self._tmp.name)

    def tearDown(self):
        read_emails.PDF_INBOX = self._orig_inbox
        self._tmp.cleanup()

    def _inline_png(self, msg, cid, size):
        # add_related → parte inline (Content-ID), sem 'attachment'.
        msg.add_related(b"x" * size, maintype="image", subtype="png", cid=cid)

    def test_pega_apenas_a_maior_inline_acima_do_limiar(self):
        msg = EmailMessage()
        msg["Subject"] = "Reembolso"
        msg.set_content("corpo")
        big = read_emails._IMAGE_INLINE_MIN_BYTES + 200_000   # recibo (maior)
        mid = read_emails._IMAGE_INLINE_MIN_BYTES + 5_000     # 2ª imagem inline
        self._inline_png(msg, "<recibo>", big)
        self._inline_png(msg, "<foto2>", mid)
        self._inline_png(msg, "<logo>", 4_000)                # logo abaixo do limiar
        saved = read_emails.save_inline_images(
            msg, "rose@otimotex.com.br", "Reembolso", "2026-06-19T14:38:01+00:00")
        self.assertEqual(len(saved), 1)
        self.assertTrue(saved[0].exists())
        self.assertEqual(saved[0].stat().st_size, big)  # a MAIOR

    def test_sem_inline_acima_do_limiar_retorna_vazio(self):
        msg = EmailMessage()
        msg["Subject"] = "Só logo"
        msg.set_content("corpo")
        self._inline_png(msg, "<logo>", 3_000)
        saved = read_emails.save_inline_images(
            msg, "x@y.com", "Só logo", "2026-06-19T14:38:01+00:00")
        self.assertEqual(saved, [])


if __name__ == "__main__":
    unittest.main()
