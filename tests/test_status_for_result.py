"""
Testes para status_for_result (read_emails.py) — derivacao de email_control.status.

Cobre o bug em que um e-mail COM anexo cuja conta foi criada pelo corpo
(body_created=True, csv_generated=False) era marcado 'pendente', divergindo do
/consulta (onde a conta aparecia). O esperado e 'recebido'.
"""

import sys
import unittest
from pathlib import Path

# O modulo vive em skills/email-reader/scripts/ (diretorio com hifen — nao
# importavel como pacote). Adiciona o caminho ao sys.path, como server/app.py faz.
_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class StatusForResultTest(unittest.TestCase):
    def test_csv_do_pdf_resulta_extraido(self):
        # PDF extraido com CSV — independe do corpo/anexo.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=False),
            "extraído",
        )

    def test_conta_do_corpo_com_anexo_resulta_recebido(self):
        # Regressao: anexo presente, PDF nao gerou CSV, conta veio do corpo.
        # Antes virava 'pendente'; agora deve ser 'recebido'.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=False,
                                          body_created=True),
            "recebido",
        )

    def test_conta_do_corpo_sem_anexo_resulta_recebido(self):
        self.assertEqual(
            read_emails.status_for_result(has_attachment=False, csv_generated=False,
                                          body_created=True),
            "recebido",
        )

    def test_anexo_sem_conta_resulta_pendente(self):
        # PDF salvo, mas nem PDF nem corpo geraram conta — aguarda reprocessamento.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=False,
                                          body_created=False),
            "pendente",
        )

    def test_sem_anexo_e_sem_conta_resulta_falha(self):
        self.assertEqual(
            read_emails.status_for_result(has_attachment=False, csv_generated=False,
                                          body_created=False),
            "falha",
        )

    def test_csv_tem_precedencia_sobre_corpo(self):
        # Se o PDF gerou CSV, 'extraído' prevalece mesmo com body_created.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=True),
            "extraído",
        )


if __name__ == "__main__":
    unittest.main()
