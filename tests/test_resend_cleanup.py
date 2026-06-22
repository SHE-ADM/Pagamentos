"""
Testes para resend_erros (resend.py) -- remoção do log de erros após reenvio.

Garante a regra: todo título reenviado com SUCESSO ('sent') ou que já constava
enviado ('skipped') é REMOVIDO de cobranca_erros_log; falha de novo ('error') ou
sem e-mail ('no_email') permanece. Tudo com dublês — não toca em SMTP nem Supabase.
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

import resend  # noqa: E402
from send_core import SendResult  # noqa: E402


class ResendCleanupTest(unittest.TestCase):
    def setUp(self):
        # Sem throttle no teste.
        self._orig_delay = os.environ.get("COBRANCA_SEND_DELAY_SECONDS")
        os.environ["COBRANCA_SEND_DELAY_SECONDS"] = "0"

        # 4 linhas de erro: doc1 envia OK, doc2 já enviado (skipped), doc3 falha de novo,
        # doc4 sem e-mail (no_email).
        self._rows = [
            {"id": 1, "document_id": "doc1", "customer_name": "C1", "primary_email": "c1@x.com",
             "cc_email": None, "due_date": "2026-06-01", "bill_amount": 10, "email_subject": "COBRANÇA"},
            {"id": 2, "document_id": "doc2", "customer_name": "C2", "primary_email": "c2@x.com",
             "cc_email": None, "due_date": "2026-06-01", "bill_amount": 20, "email_subject": "COBRANÇA"},
            {"id": 3, "document_id": "doc3", "customer_name": "C3", "primary_email": "c3@x.com",
             "cc_email": None, "due_date": "2026-06-01", "bill_amount": 30, "email_subject": "COBRANÇA"},
            {"id": 4, "document_id": "doc4", "customer_name": "C4", "primary_email": "",
             "cc_email": None, "due_date": "2026-06-01", "bill_amount": 40, "email_subject": "COBRANÇA"},
        ]
        self.deleted: list[int] = []

        # Dublês das dependências que resend.py importou no próprio namespace.
        self._patches = {
            "fetch_erro_rows": lambda ids: [r for r in self._rows if r["id"] in ids],
            "fetch_company_smtp": lambda: {"email": "financeiro@otimotex.com.br"},
            "already_sent": lambda doc_id: doc_id == "doc2",  # doc2 já enviado -> skipped
            "send_and_log": self._fake_send_and_log,
            "delete_erro_rows": self._fake_delete,
            "log_envio_erro": lambda **kw: None,
            "SmtpSession": self._FakeSession,
        }
        self._orig = {name: getattr(resend, name) for name in self._patches}
        for name, fn in self._patches.items():
            setattr(resend, name, fn)

    def tearDown(self):
        for name, fn in self._orig.items():
            setattr(resend, name, fn)
        if self._orig_delay is None:
            os.environ.pop("COBRANCA_SEND_DELAY_SECONDS", None)
        else:
            os.environ["COBRANCA_SEND_DELAY_SECONDS"] = self._orig_delay

    class _FakeSession:
        """Dublê de SmtpSession (não envia nada)."""

        def __init__(self, *a, **k):
            """Sem estado a inicializar."""

        def close(self):
            """Nada a fechar."""

    @staticmethod
    def _fake_send_and_log(*, document_id, **_kw) -> SendResult:
        # doc1 -> sent ; doc3 -> error (doc2 nem chega aqui: short-circuit no already_sent)
        return SendResult("error", "smtp_falha", "x") if document_id == "doc3" else SendResult("sent")

    def _fake_delete(self, ids):
        self.deleted.extend(ids)

    def test_remove_apenas_sent_e_skipped(self):
        result = resend.resend_erros([1, 2, 3, 4])
        # Resolvidos (sent=doc1, skipped=doc2) removidos; doc3(error)/doc4(no_email) ficam.
        self.assertCountEqual(self.deleted, [1, 2])
        self.assertEqual(result["sent"], 1)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(result["error"], 1)
        self.assertEqual(result["no_email"], 1)

    def test_sem_resolvidos_nao_chama_delete(self):
        # Só o doc3 (falha) -> nada a remover.
        resend.resend_erros([3])
        self.assertEqual(self.deleted, [])


if __name__ == "__main__":
    unittest.main()
