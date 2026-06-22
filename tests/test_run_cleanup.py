"""
Testes para a limpeza de erros resolvidos no batch diário (run.main).

Regra: quando a TASK envia um título com sucesso (ou ele já constava enviado) e esse
título JÁ tinha erro registrado, suas linhas antigas saem de cobranca_erros_log. Títulos
que falham de novo ('error') ou que nunca tiveram erro NÃO disparam limpeza. Tudo com
dublês — não toca em Firebird, SMTP nem Supabase.
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


class _Titulo:
    def __init__(self, doc: str, email: str):
        self.document_id = doc
        self.primary_email = email
        self.cc_email = None
        self.customer_name = "Cliente " + doc
        self.due_date = "2026-06-16"
        self.bill_amount = 100
        self.email_subject = "COBRANÇA"


class _FakeSession:
    def __init__(self, *a, **k): pass
    def close(self): pass


class RunCleanupTest(unittest.TestCase):
    def setUp(self):
        self._orig_delay = os.environ.get("COBRANCA_SEND_DELAY_SECONDS")
        os.environ["COBRANCA_SEND_DELAY_SECONDS"] = "0"  # sem sleeps no teste
        os.environ.pop("DEV_MODE", None)                 # produção (sem redirecionamento)

        # doc1 envia OK; doc2 já enviado (skipped); doc3 falha; doc4 envia OK sem erro prévio.
        self._titulos = [
            _Titulo("doc1", "c1@x.com"),
            _Titulo("doc2", "c2@x.com"),
            _Titulo("doc3", "c3@x.com"),
            _Titulo("doc4", "c4@x.com"),
        ]
        self.deleted: list[str] = []

        # Títulos com erro registrado ANTES do run (doc4 nunca falhou).
        error_ids = {"doc1", "doc2", "doc3"}

        self._patches = {
            "fetch_titulos_vencidos": lambda: list(self._titulos),
            "fetch_company_smtp": lambda: {"email": "financeiro@otimotex.com.br"},
            "already_sent": lambda doc_id: doc_id == "doc2",
            "send_and_log": self._fake_send_and_log,
            "fetch_error_document_ids": lambda: set(error_ids),
            "delete_erro_rows_by_document_id": self._fake_delete,
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

    @staticmethod
    def _fake_send_and_log(*, document_id, **_kw) -> str:
        return "error" if document_id == "doc3" else "sent"

    def _fake_delete(self, document_id):
        self.deleted.append(document_id)

    def test_limpa_so_resolvidos_que_tinham_erro(self):
        # doc3 falha -> main() sai com SystemExit(1); a limpeza ocorre antes do exit.
        with self.assertRaises(SystemExit):
            run.main(dry_run=False)
        # Limpa doc1 (sent, tinha erro) e doc2 (skipped, tinha erro).
        # NÃO limpa doc3 (error) nem doc4 (sent, mas nunca teve erro).
        self.assertCountEqual(self.deleted, ["doc1", "doc2"])

    def test_dry_run_nao_limpa(self):
        # Sem doc3 com erro, não há SystemExit; em dry-run nada é limpo.
        self._titulos = [_Titulo("doc1", "c1@x.com")]
        run.main(dry_run=True)
        self.assertEqual(self.deleted, [])


if __name__ == "__main__":
    unittest.main()
