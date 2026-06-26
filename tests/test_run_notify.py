"""
Testes da notificação ao representante (CC) no batch diário (run.main).

Verifica: só falhas DEFINITIVAS entram; resumo por CC (1 e-mail por representante com
todos os seus títulos); falha transitória (smtp_falha) e falha sem CC não notificam.
Tudo com dublês — não toca em Firebird, SMTP nem Supabase.
"""

import os
import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = (
    Path(__file__).resolve().parents[1]
    / "skills" / "cobranca-vencidos" / "scripts"
)
sys.path.insert(0, str(_SCRIPTS_DIR))

import run  # noqa: E402
from send_core import SendResult  # noqa: E402


class _Titulo:
    def __init__(self, doc: str, email: str, cc):
        self.document_id = doc
        self.primary_email = email
        self.cc_email = cc
        self.customer_name = "Cliente " + doc
        self.due_date = "2026-06-16"
        self.bill_amount = 100
        self.email_subject = "COBRANÇA"


class _CapturingSession:
    instances: list["_CapturingSession"] = []

    def __init__(self, *_a, **_k):
        self.sent: list[dict] = []
        _CapturingSession.instances.append(self)

    def send(self, *, to_email, cc_email, subject, html_body):
        self.sent.append({"to": to_email, "subject": subject, "html": html_body})

    def close(self):
        """Nada a fechar no dublê."""


class RunNotifyTest(unittest.TestCase):
    def setUp(self):
        self._orig_delay = os.environ.get("COBRANCA_SEND_DELAY_SECONDS")
        os.environ["COBRANCA_SEND_DELAY_SECONDS"] = "0"
        os.environ.pop("DEV_MODE", None)
        _CapturingSession.instances = []

        # doc1/doc3: email_ausente, mesmo CC (rep1) -> resumo único com 2 itens.
        # doc2: e-mail válido mas smtp_falha (transitória) -> NÃO notifica.
        # doc4: email_ausente sem CC -> não há quem notificar.
        self._titulos = [
            _Titulo("doc1", "", "rep1@x.com"),
            _Titulo("doc2", "c2@x.com", "rep1@x.com"),
            _Titulo("doc3", "", "rep1@x.com"),
            _Titulo("doc4", "", ""),
        ]

        self._patches = {
            "fetch_titulos_vencidos": lambda: list(self._titulos),
            "fetch_company_smtp": lambda: {"email": "financeiro@otimotex.com.br"},
            "already_sent": lambda doc_id: False,
            "send_and_log": lambda **kw: SendResult("error", "smtp_falha", "instável"),
            "fetch_error_document_ids": lambda: set(),
            "delete_erro_rows_by_document_id": lambda doc: None,
            "log_envio_erro": lambda **kw: None,
            "SmtpSession": _CapturingSession,
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

    def test_resumo_por_cc_so_definitivas_com_cc(self):
        # doc2 = smtp_falha (operacional) -> main() retorna exit code 1; as notificações
        # ocorrem no fim do lote.
        rc = run.main(dry_run=False)
        self.assertEqual(rc, 1)

        session = _CapturingSession.instances[0]
        # Exatamente 1 notificação: para rep1 (doc1 + doc3). doc2 (transitória) e doc4 (sem CC) fora.
        self.assertEqual(len(session.sent), 1)
        msg = session.sent[0]
        self.assertEqual(msg["to"], "rep1@x.com")
        self.assertIn("Cliente doc1", msg["html"])
        self.assertIn("Cliente doc3", msg["html"])
        self.assertNotIn("Cliente doc2", msg["html"])
        self.assertNotIn("Cliente doc4", msg["html"])

    def test_dry_run_nao_notifica(self):
        # Em dry-run os erros são todos de DADO (email_ausente) -> exit code 0.
        rc = run.main(dry_run=True)
        self.assertEqual(rc, 0)
        # Em dry-run não abre sessão nem envia notificação.
        self.assertEqual(_CapturingSession.instances, [])


if __name__ == "__main__":
    unittest.main()
