"""
Testes do reenvio manual de cobrancas (resend.py).

resend_erros reconstroi o e-mail a partir das linhas de cobranca_erros_log e
reenvia pelo nucleo compartilhado (send_core.send_and_log), com dedup
(already_sent), validacao de e-mail e throttle. Aqui o envio/Supabase sao
mockados — nada toca a rede. O throttle e zerado por env para o teste ser rapido.
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = (
    Path(__file__).resolve().parents[1]
    / "skills" / "cobranca-vencidos" / "scripts"
)
sys.path.insert(0, str(_SCRIPTS_DIR))

import resend  # noqa: E402


def _row(_id, *, doc, email="cliente@x.com", name="CLIENTE X"):
    return {
        "id": _id, "document_id": doc, "customer_name": name,
        "primary_email": email, "cc_email": None,
        "due_date": "2026-06-15", "bill_amount": 100.5,
        "email_subject": "COBRANÇA REP", "error_type": "smtp_falha",
    }


class ResendErrosTest(unittest.TestCase):
    def setUp(self):
        # Zera o throttle p/ o teste não dormir.
        self._env = mock.patch.dict(os.environ, {"COBRANCA_SEND_DELAY_SECONDS": "0", "DEV_MODE": "false"})
        self._env.start()
        self.addCleanup(self._env.stop)
        # company_row é irrelevante (envio é mockado).
        self._company = mock.patch.object(resend, "fetch_company_smtp", return_value={})
        self._company.start()
        self.addCleanup(self._company.stop)

    def test_lista_vazia_retorna_zerado(self):
        out = resend.resend_erros([])
        self.assertEqual(out["total"], 0)
        self.assertEqual(out["sent"], 0)
        self.assertEqual(out["results"], [])

    def test_envio_com_sucesso(self):
        with mock.patch.object(resend, "fetch_erro_rows", return_value=[_row(1, doc="245107-A")]), \
             mock.patch.object(resend, "already_sent", return_value=False), \
             mock.patch.object(resend, "send_and_log", return_value="sent") as send:
            out = resend.resend_erros([1])
        send.assert_called_once()
        self.assertEqual(out["sent"], 1)
        self.assertEqual(out["results"][0]["status"], "sent")

    def test_dedup_pula_ja_enviado(self):
        with mock.patch.object(resend, "fetch_erro_rows", return_value=[_row(2, doc="245113-A")]), \
             mock.patch.object(resend, "already_sent", return_value=True), \
             mock.patch.object(resend, "send_and_log") as send:
            out = resend.resend_erros([2])
        send.assert_not_called()
        self.assertEqual(out["skipped"], 1)
        self.assertEqual(out["results"][0]["status"], "skipped")

    def test_sem_email_vira_no_email_e_registra_erro(self):
        with mock.patch.object(resend, "fetch_erro_rows", return_value=[_row(3, doc="245147-A", email="")]), \
             mock.patch.object(resend, "already_sent", return_value=False), \
             mock.patch.object(resend, "send_and_log") as send, \
             mock.patch.object(resend, "log_envio_erro") as log_err:
            out = resend.resend_erros([3])
        send.assert_not_called()
        log_err.assert_called_once()
        self.assertEqual(log_err.call_args.kwargs["error_type"], "email_ausente")
        self.assertEqual(out["no_email"], 1)
        self.assertEqual(out["results"][0]["status"], "no_email")

    def test_falha_smtp_conta_como_error(self):
        with mock.patch.object(resend, "fetch_erro_rows", return_value=[_row(4, doc="999")]), \
             mock.patch.object(resend, "already_sent", return_value=False), \
             mock.patch.object(resend, "send_and_log", return_value="error"):
            out = resend.resend_erros([4])
        self.assertEqual(out["error"], 1)
        self.assertEqual(out["results"][0]["status"], "error")

    def test_ordem_preservada_e_progresso_emitido(self):
        rows = [_row(10, doc="A"), _row(20, doc="B", email=""), _row(30, doc="C")]
        events = []
        with mock.patch.object(resend, "fetch_erro_rows", return_value=rows), \
             mock.patch.object(resend, "already_sent", return_value=False), \
             mock.patch.object(resend, "send_and_log", return_value="sent"), \
             mock.patch.object(resend, "log_envio_erro"):
            out = resend.resend_erros([10, 20, 30], on_progress=events.append)
        self.assertEqual([r["document_id"] for r in out["results"]], ["A", "B", "C"])
        self.assertEqual(out["sent"], 2)
        self.assertEqual(out["no_email"], 1)
        # Progresso emitido (iniciando + por item + concluído) e termina completo.
        self.assertTrue(events)
        self.assertEqual(events[-1]["phase"], "concluído")
        self.assertEqual(events[-1]["done"], 3)


class ResendReadyTest(unittest.TestCase):
    def test_ok_com_credenciais(self):
        env = {"SUPABASE_URL": "u", "SUPABASE_SERVICE_KEY": "k",
               "IMAP_HOST": "email-ssl.com.br", "IMAP_PASS": "x", "DEV_MODE": "false"}
        with mock.patch.dict(os.environ, env, clear=True):
            ready, reason = resend.resend_ready()
        self.assertTrue(ready)
        self.assertIsNone(reason)

    def test_sem_supabase_nao_pronto(self):
        with mock.patch.dict(os.environ, {"IMAP_HOST": "h", "IMAP_PASS": "x"}, clear=True):
            ready, reason = resend.resend_ready()
        self.assertFalse(ready)
        self.assertIn("Supabase", reason)

    def test_sem_smtp_nao_pronto(self):
        with mock.patch.dict(os.environ, {"SUPABASE_URL": "u", "SUPABASE_SERVICE_KEY": "k"}, clear=True):
            ready, reason = resend.resend_ready()
        self.assertFalse(ready)
        self.assertIn("e-mail", reason.lower())

    def test_dev_mode_sem_override_nao_pronto(self):
        env = {"SUPABASE_URL": "u", "SUPABASE_SERVICE_KEY": "k",
               "IMAP_HOST": "h", "IMAP_PASS": "x", "DEV_MODE": "true"}
        with mock.patch.dict(os.environ, env, clear=True):
            ready, reason = resend.resend_ready()
        self.assertFalse(ready)
        self.assertIn("DEV_MODE", reason)


if __name__ == "__main__":
    unittest.main()
