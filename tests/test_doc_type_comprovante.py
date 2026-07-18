"""
Testes do document_type 'comprovante' (migration 087) — comprovante/recibo como
DOCUMENTO da conta a pagar.

Design (NÃO regredir): 'comprovante' é tipo SELECIONÁVEL no cadastro manual (ContaForm)
e no filtro de /consulta, e é emitido pela extração APENAS quando o rótulo explícito
"comprovante" casa em `_DOC_TYPE_NORM`. NÃO há auto-classificação de document_type pela
palavra "comprovante" no assunto/corpo — a regra subject_is_payment_confirmation já IGNORA
e-mail de "comprovante de pagamento" (recibo de pagamento já feito, não conta a pagar),
então classificar por ela geraria conflito.
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


class NormalizeComprovanteDocTypeTest(unittest.TestCase):
    def test_rotulo_explicito_normaliza(self):
        # case/accent-insensitive, sempre minúsculo (espelha o CHECK lower()).
        for raw in ("comprovante", "Comprovante", "COMPROVANTE", "  comprovante  "):
            self.assertEqual(extract_pdf._normalize_doc_type(raw), "comprovante", raw)

    def test_desconhecido_nao_vira_comprovante(self):
        # Só o rótulo explícito produz 'comprovante'; frase/variação cai no fallback 'outro'.
        for raw in ("comprovante de pagamento", "comprovantes", "", "boletox"):
            self.assertNotEqual(extract_pdf._normalize_doc_type(raw), "comprovante", raw)


class NoAutoClassificationTest(unittest.TestCase):
    """A palavra 'comprovante' não pode virar document_type por auto-classificação de texto."""

    def test_comprovante_nao_e_document_type_em_nenhum_classificador_de_texto(self):
        for structure_name in (
            "_BODY_DOC_KEYWORDS",
            "_UTILITY_DOC_KEYWORDS",
            "_SUBJECT_TAX_DOC_KEYWORDS",
        ):
            doc_types = {dt for dt, _ in getattr(read_emails, structure_name)}
            self.assertNotIn("comprovante", doc_types, structure_name)


if __name__ == "__main__":
    unittest.main()
