"""
conftest.py — rede de segurança da suíte do pipeline Python.

🔴 NENHUM teste pode enviar e-mail de alerta de verdade. O alerta ativo do leitor
(`skills/email-reader/scripts/reader_alert.py`) é ligado pela variável `READER_ALERT_TO`, e o
`read_emails.py` carrega o `.env` da raiz ao ser importado. Se um dia alguém puser essa variável
no `.env` do ambiente de desenvolvimento, todo teste que executa `run_reader` com e-mail adiado
passaria a falar SMTP com o servidor real.

O fixture abaixo remove a variável durante CADA teste (vale também para `unittest.TestCase`).
O teste que precisa do alerta ligado define a variável por conta própria, com `mock.patch.dict`.
"""

import pytest


@pytest.fixture(autouse=True)
def _reader_alert_disabled(monkeypatch):
    monkeypatch.delenv("READER_ALERT_TO", raising=False)
