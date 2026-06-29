"""
Testes da descriptografia de boletos protegidos por senha (extract_pdf.py) e da
geração de senhas candidatas (read_emails.pdf_password_candidates).

Regra de negócio: boletos de cobrança costumam pedir os N primeiros dígitos do CNPJ
do pagador (company_id=1). O pipeline tenta CNPJ[:4] → [:5] → [:6]; em sucesso,
descriptografa para um arquivo temporário e segue a extração. Sem senha que abra →
None (o caller cai no fallback do corpo).
"""

import sys
import tempfile
import unittest
from pathlib import Path

import pypdf

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import extract_pdf  # noqa: E402
import read_emails  # noqa: E402


def _make_encrypted_pdf(password: str) -> Path:
    """Cria um PDF de 1 página cifrado com a senha de usuário informada."""
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.encrypt(user_password=password)
    fd, tmp = tempfile.mkstemp(suffix=".pdf")
    import os
    with os.fdopen(fd, "wb") as fh:
        writer.write(fh)
    return Path(tmp)


def _make_plain_pdf() -> Path:
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=200, height=200)
    fd, tmp = tempfile.mkstemp(suffix=".pdf")
    import os
    with os.fdopen(fd, "wb") as fh:
        writer.write(fh)
    return Path(tmp)


class TestPasswordCandidates(unittest.TestCase):
    def test_cnpj_gera_prefixos_4_5_6(self):
        self.assertEqual(
            read_emails.pdf_password_candidates("47273917000123"),
            ["4727", "47273", "472739"],
        )

    def test_aceita_cnpj_mascarado(self):
        self.assertEqual(
            read_emails.pdf_password_candidates("47.273.917/0001-23"),
            ["4727", "47273", "472739"],
        )

    def test_cnpj_curto_ou_vazio_retorna_vazio(self):
        self.assertEqual(read_emails.pdf_password_candidates("123"), [])
        self.assertEqual(read_emails.pdf_password_candidates(None), [])


class TestDecryptPdf(unittest.TestCase):
    def test_detecta_cifrado_e_descriptografa_com_candidato(self):
        enc = _make_encrypted_pdf("472739")  # senha = 6 primeiros dígitos do CNPJ
        try:
            self.assertTrue(extract_pdf._pdf_is_encrypted(enc))
            dec = extract_pdf._decrypt_pdf(enc, ["4727", "47273", "472739"])
            self.assertIsNotNone(dec)
            # O arquivo gerado abre SEM senha.
            self.assertFalse(pypdf.PdfReader(str(dec)).is_encrypted)
            dec.unlink()
        finally:
            enc.unlink()

    def test_senhas_erradas_retornam_none(self):
        enc = _make_encrypted_pdf("999999")
        try:
            dec = extract_pdf._decrypt_pdf(enc, ["4727", "47273", "472739"])
            self.assertIsNone(dec)
        finally:
            enc.unlink()

    def test_pdf_simples_nao_e_cifrado(self):
        plain = _make_plain_pdf()
        try:
            self.assertFalse(extract_pdf._pdf_is_encrypted(plain))
        finally:
            plain.unlink()


if __name__ == "__main__":
    unittest.main()
