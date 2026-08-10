"""
Teste de robustez das chamadas a Claude API (extract_pdf).

Cobre a falha em que um request a Claude sem timeout explicito (default do SDK
~10 min) podia congelar o run sincrono que processa muitos PDFs — mesma classe
de travamento ja resolvida no IMAP. Toda instancia do client Anthropic deve
receber timeout=CLAUDE_API_TIMEOUT_SECONDS.

extract_pdf faz `import anthropic` DENTRO das funcoes, entao o mock atua sobre
o modulo real instalado (anthropic.Anthropic), nao sobre um atributo do modulo.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

# extract_pdf vive na skill (diretorio com hifen — nao importavel como pacote).
_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import extract_pdf as e  # noqa: E402


class ClaudeApiTimeoutTest(unittest.TestCase):
    def test_timeout_padrao_positivo(self):
        self.assertIsInstance(e.CLAUDE_API_TIMEOUT_SECONDS, int)
        self.assertGreater(e.CLAUDE_API_TIMEOUT_SECONDS, 0)

    def test_extract_fields_with_claude_passa_timeout(self):
        """A extracao por texto cria o client com timeout explicito."""
        fake_resp = mock.MagicMock()
        fake_resp.stop_reason = "end_turn"
        fake_resp.content = [mock.MagicMock(type="text", text='{"amount": 10}')]

        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as Anthropic:
            Anthropic.return_value.messages.create.return_value = fake_resp
            e.extract_fields_with_claude("texto do documento")

        _, kwargs = Anthropic.call_args
        self.assertEqual(kwargs.get("timeout"), e.CLAUDE_API_TIMEOUT_SECONDS)

    def test_extract_with_vision_passa_timeout(self):
        """A extracao por visao (PDF base64) cria o client com timeout explicito."""
        fake_resp = mock.MagicMock()
        fake_resp.stop_reason = "end_turn"
        fake_resp.content = [mock.MagicMock(type="text", text="texto extraido")]

        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as Anthropic, \
                mock.patch.object(Path, "read_bytes", return_value=b"%PDF-1.4"):
            Anthropic.return_value.messages.create.return_value = fake_resp
            _, source = e.extract_with_vision(Path("fake.pdf"))

        _, kwargs = Anthropic.call_args
        self.assertEqual(kwargs.get("timeout"), e.CLAUDE_API_TIMEOUT_SECONDS)
        self.assertEqual(source, "pdf_vision")


if __name__ == "__main__":
    unittest.main()
