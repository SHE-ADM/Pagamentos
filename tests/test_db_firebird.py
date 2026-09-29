"""
Testes da leitura de títulos vencidos (db_firebird.fetch_titulos_vencidos).

Executa a função de topo com um driver Firebird FALSO: a query devolve 8 colunas
(a 1ª é FIN_CLI_GP_NO, grupo econômico, descartada na leitura). Um desempacotamento
de 7 posições levantaria ValueError em toda execução — este teste trava isso no
call site executado, não por texto.
"""

import os
import sys
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "cobranca-vencidos" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import db_firebird  # noqa: E402

_ENV = {"FB_HOST": "h", "FB_DATABASE": "d", "FB_USER": "u", "FB_PASSWORD": "p"}


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows
        self.executed = None

    def execute(self, query):
        self.executed = query

    def fetchall(self):
        return list(self._rows)


class _FakeConnection:
    def __init__(self, rows):
        self.cur = _FakeCursor(rows)
        self.closed = False

    def cursor(self):
        return self.cur

    def close(self):
        self.closed = True


class _FakeDriver:
    def __init__(self, rows):
        self.con = _FakeConnection(rows)

    def connect(self, **_kwargs):
        return self.con


class FetchTitulosVencidosTest(unittest.TestCase):
    def _run(self, rows):
        driver = _FakeDriver(rows)
        with mock.patch.dict(os.environ, _ENV), \
             mock.patch.object(db_firebird, "_get_driver", return_value=driver):
            result = db_firebird.fetch_titulos_vencidos()
        return driver, result

    def test_query_seleciona_grupo_como_primeira_coluna(self):
        # Sanidade do contrato: a 1ª coluna do SELECT é o grupo, que o código descarta.
        first_select_col = db_firebird._QUERY.split("SELECT", 1)[1].split(",", 1)[0].strip()
        self.assertEqual(first_select_col, "PK.FIN_CLI_GP_NO")

    def test_linha_de_8_colunas_mapeia_campos_sem_o_grupo(self):
        row = ("LOJAS X", " 241781-E ", date(2026, 9, 25), 150.5, " CLIENTE ",
               " a@b.com ", " rep@x.com ", " COBRANÇA LEBIANCO ")
        driver, result = self._run([row])
        self.assertEqual(driver.con.cur.executed, db_firebird._QUERY)
        self.assertEqual(len(result), 1)
        t = result[0]
        self.assertEqual(t.document_id, "241781-E")
        self.assertEqual(t.due_date, date(2026, 9, 25))
        self.assertEqual(t.bill_amount, Decimal("150.5"))
        self.assertEqual(t.customer_name, "CLIENTE")
        self.assertEqual(t.primary_email, "a@b.com")
        self.assertEqual(t.cc_email, "rep@x.com")
        self.assertEqual(t.email_subject, "COBRANÇA LEBIANCO")
        self.assertTrue(driver.con.closed)

    def test_grupo_nulo_e_campos_vazios_usam_defaults(self):
        row = (None, "T1", date(2026, 9, 25), None, None, None, None, None)
        _driver, result = self._run([row])
        t = result[0]
        self.assertEqual(t.bill_amount, Decimal("0"))
        self.assertEqual(t.customer_name, "")
        self.assertEqual(t.primary_email, "")  # vira email_ausente adiante
        self.assertIsNone(t.cc_email)
        self.assertEqual(t.email_subject, "COBRANÇA")

    def test_linha_sem_titulo_e_descartada(self):
        rows = [("G", "", None, None, None, None, None, None),
                ("G", None, None, None, None, None, None, None)]
        driver, result = self._run(rows)
        self.assertEqual(result, [])
        self.assertTrue(driver.con.closed)

    def test_conexao_fecha_mesmo_com_erro_na_leitura(self):
        # Linha de 7 colunas (formato antigo) quebra o desempacotamento; a conexão fecha.
        row = ("T1", date(2026, 9, 25), 1, "C", "a@b.com", None, "S")
        driver = _FakeDriver([row])
        with mock.patch.dict(os.environ, _ENV), \
             mock.patch.object(db_firebird, "_get_driver", return_value=driver), \
             self.assertRaises(ValueError):
            db_firebird.fetch_titulos_vencidos()
        self.assertTrue(driver.con.closed)


if __name__ == "__main__":
    unittest.main()
