"""
Testes para classify_smtp_error (send_core.py) -- classificacao de falha de envio
SMTP na cobranca de vencidos. A funcao foi extraida de run.py para send_core, que e
o nucleo compartilhado entre o batch (run.py) e o reenvio manual (resend.py).

Cobre o bug em que um SMTPRecipientsRefused com codigo 4xx (limite TEMPORARIO, ex.:
452 "sending too many mails, slow down" do Hotmail/Gmail) era classificado como
'smtp_bloqueio' (acao humana / "endereco inexistente"), quando o correto e
'smtp_falha' (instabilidade temporaria -> retry). 5xx continua sendo bloqueio.
"""

import smtplib
import sys
import unittest
from pathlib import Path

# Os modulos vivem em skills/cobranca-vencidos/scripts/ (diretorio com hifen --
# nao importavel como pacote). Adiciona o caminho ao sys.path, como run.py faz.
_SCRIPTS_DIR = (
    Path(__file__).resolve().parents[1]
    / "skills" / "cobranca-vencidos" / "scripts"
)
sys.path.insert(0, str(_SCRIPTS_DIR))

from send_core import classify_smtp_error  # noqa: E402


class ClassifySmtpErrorTest(unittest.TestCase):
    def test_recipient_452_throttle_e_falha_temporaria(self):
        # 452 "sending too many mails, slow down" = limite temporario -> retry.
        exc = smtplib.SMTPRecipientsRefused({
            "lucianaluca34@hotmail.com": (
                452, b"4.7.1 Recipient address rejected: you are sending too "
                      b"many mails, slow down...",
            ),
        })
        error_type, motivo = classify_smtp_error(exc)
        self.assertEqual(error_type, "smtp_falha")
        self.assertIn("temporariamente", motivo.lower())

    def test_recipient_550_endereco_invalido_e_bloqueio(self):
        # 550 = recusa definitiva (endereco inexistente) -> acao humana.
        exc = smtplib.SMTPRecipientsRefused({
            "naoexiste@dominio.com": (
                550, b"5.1.1 User unknown",
            ),
        })
        error_type, motivo = classify_smtp_error(exc)
        self.assertEqual(error_type, "smtp_bloqueio")
        self.assertIn("cadastrado do cliente", motivo)

    def test_recipient_mix_4xx_e_5xx_resulta_bloqueio(self):
        # Qualquer destinatario com recusa definitiva (5xx) exige atencao humana.
        exc = smtplib.SMTPRecipientsRefused({
            "ok@dominio.com":        (452, b"4.7.1 slow down"),
            "naoexiste@dominio.com": (550, b"5.1.1 User unknown"),
        })
        error_type, _motivo = classify_smtp_error(exc)
        self.assertEqual(error_type, "smtp_bloqueio")

    def test_recipient_sem_codigo_cai_no_default_bloqueio(self):
        # Sem codigo inteiro extraivel -> default seguro (bloqueio).
        exc = smtplib.SMTPRecipientsRefused({})
        error_type, _motivo = classify_smtp_error(exc)
        self.assertEqual(error_type, "smtp_bloqueio")

    def test_auth_error_e_bloqueio(self):
        exc = smtplib.SMTPAuthenticationError(535, b"5.7.8 Authentication failed")
        error_type, _motivo = classify_smtp_error(exc)
        self.assertEqual(error_type, "smtp_bloqueio")

    def test_data_error_451_queue_e_falha_temporaria(self):
        # 451 "queue file write error" = instabilidade temporaria -> retry.
        exc = smtplib.SMTPDataError(451, b"4.3.0 Error: queue file write error")
        error_type, _motivo = classify_smtp_error(exc)
        self.assertEqual(error_type, "smtp_falha")

    def test_5xx_generico_e_bloqueio(self):
        exc = smtplib.SMTPSenderRefused(
            550, b"5.7.1 Blocked", "financeiro@otimotex.com.br",
        )
        error_type, _motivo = classify_smtp_error(exc)
        self.assertEqual(error_type, "smtp_bloqueio")


if __name__ == "__main__":
    unittest.main()
