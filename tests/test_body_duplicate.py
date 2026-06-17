"""
Teste da regra de DUPLICIDADE no caminho de corpo (try_extract_from_body).

Quando o pagável extraído do corpo duplica uma conta já registrada (find_financial_
duplicate retorna a conta), a função retorna BODY_DUPLICATE e referencia o id em
email_rec['duplicate_of'] — o e-mail vira 'duplicidade', não 'falha'. Conta nova →
BODY_CREATED; sem pagável → BODY_NONE.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

BODY_COM_PAGAVEL = (
    "Bom dia!\r\n"
    "Por gentileza fazer o pagamento da NF 1087.\r\n"
    "Fornecedor: EFE DISPLAYS\r\n"
    "CNPJ: 44.009.190/0001-83\r\n"
    "Vencimento: 17/06/2026\r\n"
    "Valor: R$ 34.300,00\r\n"
)


class FakeCtrl:
    """ctrl mínimo para try_extract_from_body — sem rede."""
    def __init__(self, dup=None, registered=True):
        self._dup = dup
        self._registered = registered
        self.registered_payloads = []

    def find_financial_duplicate(self, payload):
        return self._dup

    def unique_invoice_number(self, n):
        return n

    def register_financial(self, payload):
        self.registered_payloads.append(payload)
        return self._registered


def _run(ctrl, body=BODY_COM_PAGAVEL):
    rec = {"subject": "RES: LE BIANCO - PAGAMENTO FORNECEDOR (ADM - EFE DISPLAYS)"}
    outcome = R.try_extract_from_body(
        rec, body, "2026-06-16T11:53:00+00:00", "<msg-test>", ctrl,
        sender_email="estela@lebianco.com.br")
    return outcome, rec


class TryExtractFromBodyTest(unittest.TestCase):
    def test_duplicata_retorna_body_duplicate_com_referencia(self):
        ctrl = FakeCtrl(dup={"id": 93})
        outcome, rec = _run(ctrl)
        self.assertEqual(outcome, R.BODY_DUPLICATE)
        self.assertEqual(rec.get("duplicate_of"), 93)
        self.assertIn("93", rec.get("notes", ""))
        self.assertEqual(ctrl.registered_payloads, [])  # NÃO grava conta nova

    def test_conta_nova_retorna_body_created(self):
        ctrl = FakeCtrl(dup=None, registered=True)
        outcome, _ = _run(ctrl)
        self.assertEqual(outcome, R.BODY_CREATED)
        self.assertEqual(len(ctrl.registered_payloads), 1)

    def test_sem_pagavel_retorna_body_none(self):
        ctrl = FakeCtrl(dup=None)
        outcome, rec = _run(ctrl, body="Obrigada! Segue em anexo o comprovante.")
        self.assertEqual(outcome, R.BODY_NONE)
        self.assertEqual(ctrl.registered_payloads, [])


if __name__ == "__main__":
    unittest.main()
