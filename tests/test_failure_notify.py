"""
Testes para failure_notify -- agrupamento por CC, render do resumo e escape de HTML.
"""

import sys
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

_SCRIPTS_DIR = (
    Path(__file__).resolve().parents[1]
    / "skills" / "cobranca-vencidos" / "scripts"
)
sys.path.insert(0, str(_SCRIPTS_DIR))

from failure_notify import (  # noqa: E402
    DEFINITIVE_ERROR_TYPES,
    build_subject,
    group_by_cc,
    render_failure_digest,
)


class FailureNotifyTest(unittest.TestCase):
    def test_definitivas_sao_as_que_exigem_acao_humana(self):
        self.assertEqual(
            DEFINITIVE_ERROR_TYPES,
            frozenset({"email_ausente", "email_invalido", "smtp_bloqueio"}),
        )
        # transitória NÃO entra
        self.assertNotIn("smtp_falha", DEFINITIVE_ERROR_TYPES)

    def test_group_by_cc_agrupa_e_ignora_sem_cc(self):
        falhas = [
            {"cc_email": "rep1@x.com", "document_id": "d1"},
            {"cc_email": "rep1@x.com", "document_id": "d2"},
            {"cc_email": "rep2@x.com", "document_id": "d3"},
            {"cc_email": "", "document_id": "d4"},        # sem CC -> ignorado
            {"cc_email": None, "document_id": "d5"},       # sem CC -> ignorado
        ]
        by_cc = group_by_cc(falhas)
        self.assertEqual(set(by_cc), {"rep1@x.com", "rep2@x.com"})
        self.assertEqual(len(by_cc["rep1@x.com"]), 2)
        self.assertEqual(len(by_cc["rep2@x.com"]), 1)

    def test_render_contem_campos_formatados(self):
        html = render_failure_digest([{
            "customer_name": "ARMARINHOS YESHUA",
            "document_id": "245051-B",
            "due_date": date(2026, 6, 16),
            "bill_amount": Decimal("1234.50"),
            "motivo": "Cliente sem e-mail cadastrado.",
        }])
        self.assertIn("ARMARINHOS YESHUA", html)
        self.assertIn("245051-B", html)
        self.assertIn("16/06/2026", html)          # data BR
        self.assertIn("R$ 1.234,50", html)         # valor BR
        self.assertIn("Cliente sem e-mail cadastrado.", html)

    def test_render_escapa_html(self):
        html = render_failure_digest([{
            "customer_name": "A & B <Cia>",
            "document_id": "1",
            "due_date": "—",
            "bill_amount": 10,
            "motivo": "x",
        }])
        self.assertIn("A &amp; B &lt;Cia&gt;", html)   # escapado
        self.assertNotIn("<Cia>", html)

    def test_build_subject_singular_plural(self):
        self.assertIn("(1 título)", build_subject(1))
        self.assertIn("(3 títulos)", build_subject(3))


if __name__ == "__main__":
    unittest.main()
