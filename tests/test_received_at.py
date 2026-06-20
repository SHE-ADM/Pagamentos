"""
Testes para _received_at_from (read_emails.py).

received_at canonico: INTERNALDATE (chegada na caixa) tem prioridade sobre o
header Date do remetente; sem INTERNALDATE, cai no Date (se nao for futuro);
nunca grava data futura. Garante que /emails fique na mesma ordem do webmail.
"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Meta de FETCH com INTERNALDATE (mesmo formato do teste de _rfc822_from_fetch).
_META = b'85 (UID 14777 INTERNALDATE "03-Jun-2026 16:07:13 -0300" RFC822 {12}'
_META_SEM_INTERNALDATE = b'1 (RFC822 {12}'


class ReceivedAtFromTest(unittest.TestCase):
    def test_internaldate_tem_prioridade_sobre_header_date(self):
        # Header Date diferente (e ate "errado") — o INTERNALDATE deve vencer.
        result = read_emails._received_at_from(_META, "Mon, 01 Jan 2020 00:00:00 -0300")
        expected = datetime(2026, 6, 3, 19, 7, 13, tzinfo=timezone.utc)  # 16:07:13 -0300 -> UTC
        self.assertEqual(datetime.fromisoformat(result), expected)

    def test_fallback_para_header_date_sem_internaldate(self):
        result = read_emails._received_at_from(_META_SEM_INTERNALDATE,
                                               "Tue, 02 Jun 2026 10:00:00 -0300")
        expected = datetime(2026, 6, 2, 13, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(datetime.fromisoformat(result), expected)

    def test_nunca_grava_data_futura(self):
        # Sem INTERNALDATE e com Date no futuro -> nunca aceita data futura (usa agora).
        result = read_emails._received_at_from(None, "Fri, 01 Jan 2099 00:00:00 +0000")
        self.assertLessEqual(datetime.fromisoformat(result), datetime.now(timezone.utc))

    def test_sem_dado_usa_agora(self):
        # meta None e Date invalido -> agora (string ISO valida, nao futura).
        result = read_emails._received_at_from(None, "lixo")
        self.assertLessEqual(datetime.fromisoformat(result), datetime.now(timezone.utc))


if __name__ == "__main__":
    unittest.main()
