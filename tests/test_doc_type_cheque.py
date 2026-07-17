"""
Testes do document_type 'cheque' (migration 086) — o cheque como DOCUMENTO da conta,
distinto do payment_method 'cheque' (a forma de pagamento).

Design (NÃO regredir): 'cheque' é tipo SELECIONÁVEL no cadastro manual (ContaForm) e no
filtro de /consulta, e é emitido pela extração APENAS quando o rótulo explícito "cheque"
casa em `_DOC_TYPE_NORM`. NÃO há auto-classificação de document_type pela palavra "cheque"
no assunto/corpo — ela já é payment_method e classificar por ela geraria falso positivo.
"""

import sys
import unittest
from pathlib import Path

_PDF_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
_MAIL_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_PDF_DIR))
sys.path.insert(0, str(_MAIL_DIR))

import extract_pdf  # noqa: E402
import read_emails  # noqa: E402


class NormalizeChequeDocTypeTest(unittest.TestCase):
    def test_rotulo_explicito_normaliza(self):
        # case/accent-insensitive, sempre minúsculo (espelha o CHECK lower()).
        for raw in ("cheque", "Cheque", "CHEQUE", "  cheque  "):
            self.assertEqual(extract_pdf._normalize_doc_type(raw), "cheque", raw)

    def test_desconhecido_nao_vira_cheque(self):
        # Só o rótulo explícito produz 'cheque'; frase/variação cai no fallback 'outro'.
        for raw in ("pagamento em cheque especial", "chequinho", "", "boletox"):
            self.assertNotEqual(extract_pdf._normalize_doc_type(raw), "cheque", raw)


class NoAutoClassificationTest(unittest.TestCase):
    """A palavra 'cheque' só pode classificar payment_method — nunca document_type."""

    def test_cheque_e_payment_method(self):
        pay_values = {v for v, _ in read_emails._BODY_PAYMENT_METHOD_KEYWORDS}
        self.assertIn("cheque", pay_values)

    def test_cheque_nao_e_document_type_em_nenhum_classificador_de_texto(self):
        for structure_name in (
            "_BODY_DOC_KEYWORDS",
            "_UTILITY_DOC_KEYWORDS",
            "_SUBJECT_TAX_DOC_KEYWORDS",
        ):
            doc_types = {dt for dt, _ in getattr(read_emails, structure_name)}
            self.assertNotIn("cheque", doc_types, structure_name)


if __name__ == "__main__":
    unittest.main()
