"""
Testes do exit code do batch diário (run.compute_exit_code / run.main).

Regra (corrige o 0x1 no Agendador quando o run foi OK): erros de DADO do cliente
(email_ausente / email_invalido) NÃO reprovam a tarefa; só erros OPERACIONAIS
(smtp_falha/smtp_bloqueio/supabase_falha/erro_inesperado) fazem o run sair != 0.
"""

import os
import sys
import unittest
from collections import Counter
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "cobranca-vencidos" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import run  # noqa: E402
from send_core import SendResult  # noqa: E402


class ComputeExitCodeTest(unittest.TestCase):
    def test_sem_erros(self):
        self.assertEqual(run.compute_exit_code(Counter()), 0)

    def test_so_erros_de_dado_nao_reprova(self):
        # Caso reportado: 16 clientes sem e-mail -> tarefa deve ficar VERDE (0).
        self.assertEqual(run.compute_exit_code(Counter({"email_ausente": 16})), 0)
        self.assertEqual(
            run.compute_exit_code(Counter({"email_ausente": 16, "email_invalido": 2})), 0
        )

    def test_erro_operacional_reprova(self):
        self.assertEqual(run.compute_exit_code(Counter({"smtp_bloqueio": 1})), 1)
        self.assertEqual(run.compute_exit_code(Counter({"smtp_falha": 1})), 1)
        self.assertEqual(run.compute_exit_code(Counter({"erro_inesperado": 1})), 1)
        self.assertEqual(run.compute_exit_code(Counter({"supabase_falha": 1})), 1)
        # Mistura: dados + 1 operacional -> reprova.
        self.assertEqual(
            run.compute_exit_code(Counter({"email_ausente": 16, "smtp_bloqueio": 1})), 1
        )


class _Titulo:
    def __init__(self, doc, email):
        self.document_id = doc
        self.primary_email = email
        self.cc_email = "rep@x.com"
        self.customer_name = "Cliente " + doc
        self.due_date = "2026-06-16"
        self.bill_amount = 100
        self.email_subject = "COBRANCA"


class _FakeSession:
    def __init__(self, *_a, **_k):
        # Stub de sessão: aceita e ignora os argumentos do construtor real.
        pass

    def send(self, **_k):
        """Não usado quando não há e-mail válido."""

    def close(self):
        """Nada a fechar no dublê."""


class MainExitCodeTest(unittest.TestCase):
    """main() retorna 0 quando só há clientes sem e-mail (cenário reportado)."""

    def setUp(self):
        self._orig_delay = os.environ.get("COBRANCA_SEND_DELAY_SECONDS")
        os.environ["COBRANCA_SEND_DELAY_SECONDS"] = "0"
        os.environ.pop("DEV_MODE", None)
        self._patches = {
            "fetch_titulos_vencidos": lambda: [_Titulo("doc1", ""), _Titulo("doc2", "")],
            "fetch_company_smtp": lambda: {"email": "financeiro@otimotex.com.br"},
            "already_sent": lambda doc_id: False,
            "send_and_log": lambda **kw: SendResult("sent"),
            "fetch_error_document_ids": lambda: set(),
            "delete_erro_rows_by_document_id": lambda doc: None,
            "log_envio_erro": lambda **kw: None,
            "SmtpSession": _FakeSession,
        }
        self._orig = {name: getattr(run, name) for name in self._patches}
        for name, fn in self._patches.items():
            setattr(run, name, fn)

    def tearDown(self):
        for name, fn in self._orig.items():
            setattr(run, name, fn)
        if self._orig_delay is None:
            os.environ.pop("COBRANCA_SEND_DELAY_SECONDS", None)
        else:
            os.environ["COBRANCA_SEND_DELAY_SECONDS"] = self._orig_delay

    def test_so_clientes_sem_email_retorna_zero(self):
        # 2 títulos sem e-mail -> email_ausente (dado), nenhum operacional -> exit 0.
        self.assertEqual(run.main(dry_run=False), 0)


if __name__ == "__main__":
    unittest.main()
