"""
Testes para SmtpSession (email_sender.py) -- conexão SMTP persistente reaproveitada
entre vários envios do mesmo lote (cobrança de vencidos).

Cobre o ganho central do reuso de conexão e suas garantias:
  - reuso: N envios usam UMA conexão (login único), não uma por e-mail;
  - reconexão: se a conexão cair no meio do lote, reconecta e reenvia o principal UMA vez;
  - Cc resiliente: falha só no Cc não derruba o principal nem reenvia o To (sem duplicar);
  - DEV_MODE: To/Cc são redirecionados para as caixas de teste.
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

import email_sender  # noqa: E402
from email_sender import SmtpSession  # noqa: E402

_COMPANY = {"email": "financeiro@otimotex.com.br", "trade_name": "Otimotex"}


class _FakeSMTP:
    """Dublê de smtplib.SMTP. Registra conexões/logins/envios e permite roteirizar
    o comportamento de cada chamada de sendmail (sucesso vs. exceção)."""

    instances: list["_FakeSMTP"] = []
    # Fila de comportamentos por chamada de sendmail: None = sucesso; Exception = raise.
    sendmail_script: list[object] = []

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.logged_in = False
        self.starttls_called = 0
        self.quit_called = 0
        self.sent: list[tuple[str, tuple[str, ...]]] = []
        _FakeSMTP.instances.append(self)

    def ehlo(self, *_a):
        return (250, b"ok")

    def starttls(self, context=None):
        self.starttls_called += 1

    def login(self, user, password):
        self.logged_in = True

    def sendmail(self, from_addr, to_list, raw):
        if _FakeSMTP.sendmail_script:
            behavior = _FakeSMTP.sendmail_script.pop(0)
            if isinstance(behavior, Exception):
                raise behavior
        self.sent.append((from_addr, tuple(to_list)))

    def quit(self):
        self.quit_called += 1

    def close(self):
        pass


class SmtpSessionTest(unittest.TestCase):
    def setUp(self):
        _FakeSMTP.instances = []
        _FakeSMTP.sendmail_script = []
        self._orig_smtp = email_sender.smtplib.SMTP
        email_sender.smtplib.SMTP = _FakeSMTP

    def tearDown(self):
        email_sender.smtplib.SMTP = self._orig_smtp

    def test_reusa_uma_conexao_para_varios_envios(self):
        with SmtpSession(_COMPANY) as session:
            session.send(to_email="a@cliente.com", cc_email=None, subject="s", html_body="<p>1</p>")
            session.send(to_email="b@cliente.com", cc_email=None, subject="s", html_body="<p>2</p>")
        # Uma única conexão (um login) para os dois envios — não uma por e-mail.
        self.assertEqual(len(_FakeSMTP.instances), 1)
        conn = _FakeSMTP.instances[0]
        self.assertTrue(conn.logged_in)
        self.assertEqual(conn.starttls_called, 1)
        self.assertEqual(len(conn.sent), 2)
        # Sai do context manager -> conexão encerrada.
        self.assertEqual(conn.quit_called, 1)

    def test_conexao_lazy_sem_envio_nao_conecta(self):
        with SmtpSession(_COMPANY):
            pass  # nenhum send()
        self.assertEqual(len(_FakeSMTP.instances), 0)

    def test_reconecta_e_reenvia_ao_cair_a_conexao(self):
        # 1ª tentativa do principal cai (conexão obsoleta) -> reconecta e reenvia.
        _FakeSMTP.sendmail_script = [smtplib.SMTPServerDisconnected("conexão caiu")]
        with SmtpSession(_COMPANY) as session:
            session.send(to_email="a@cliente.com", cc_email=None, subject="s", html_body="<p>x</p>")
        self.assertEqual(len(_FakeSMTP.instances), 2)         # reconectou
        self.assertEqual(len(_FakeSMTP.instances[0].sent), 0)  # 1ª conexão não entregou
        self.assertEqual(len(_FakeSMTP.instances[1].sent), 1)  # 2ª entregou o principal

    def test_falha_no_cc_nao_reenvia_principal(self):
        # To OK; Cc falha (até com OSError) -> principal NÃO é reenviado (sem duplicar)
        # e nenhuma reconexão é disparada.
        _FakeSMTP.sendmail_script = [None, OSError("cc caiu")]
        with SmtpSession(_COMPANY) as session:
            session.send(to_email="a@cliente.com", cc_email="cc@cliente.com",
                         subject="s", html_body="<p>x</p>")
        self.assertEqual(len(_FakeSMTP.instances), 1)          # sem reconexão
        # Só o principal foi registrado (o Cc levantou exceção antes de registrar).
        self.assertEqual(_FakeSMTP.instances[0].sent, [("financeiro@otimotex.com.br", ("a@cliente.com",))])

    def test_recusa_definitiva_propaga(self):
        # 451 "queue file write error" NÃO é tratado como queda de conexão: propaga
        # para o caller (send_and_log) classificar.
        _FakeSMTP.sendmail_script = [smtplib.SMTPDataError(451, b"4.3.0 queue file write error")]
        with SmtpSession(_COMPANY) as session:
            with self.assertRaises(smtplib.SMTPDataError):
                session.send(to_email="a@cliente.com", cc_email=None, subject="s", html_body="<p>x</p>")
        self.assertEqual(len(_FakeSMTP.instances), 1)  # não reconectou

    def test_dev_mode_redireciona_to(self):
        with SmtpSession(_COMPANY, dev_mode=True, dev_override="teste@sheild.app.br") as session:
            session.send(to_email="cliente@real.com", cc_email=None, subject="s", html_body="<p>x</p>")
        from_addr, to_tuple = _FakeSMTP.instances[0].sent[0]
        self.assertEqual(from_addr, "financeiro@otimotex.com.br")
        self.assertEqual(to_tuple, ("teste@sheild.app.br",))  # redirecionado


if __name__ == "__main__":
    unittest.main()
