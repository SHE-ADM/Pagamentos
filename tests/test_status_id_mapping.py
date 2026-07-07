"""
Testes da traducao situacao TEXTO -> status_id (fonte unica) na gravacao.

FASE 2 da remocao do `status` texto de financial_account_control: o pipeline rotula
internamente por texto ('pendente'/'falha'), mas register_financial grava por status_id.
_apply_status_id traduz e remove o texto: 'pendente' (ou vazio) NAO seta status_id (o
banco aplica o DEFAULT 3 = 'a vencer' e a trigger recalcula por vencimento); os demais
estados viram o id da dimensao `status`.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402


class ApplyStatusIdTest(unittest.TestCase):
    def test_pendente_nao_seta_status_id(self):
        # 'pendente' -> omite status_id (cai no DEFAULT 3 do banco + trigger por vencimento).
        payload = {"amount": "10.00", "status": "pendente"}
        R._apply_status_id(payload)
        self.assertNotIn("status", payload)
        self.assertNotIn("status_id", payload)

    def test_vazio_ou_ausente_nao_seta(self):
        for p in ({"status": ""}, {"status": None}, {}):
            payload = dict(p)
            R._apply_status_id(payload)
            self.assertNotIn("status", payload)
            self.assertNotIn("status_id", payload)

    def test_falha_vira_10(self):
        payload = {"status": "falha"}
        R._apply_status_id(payload)
        self.assertEqual(payload.get("status_id"), 10)
        self.assertNotIn("status", payload)

    def test_demais_estados_mapeiam_o_id(self):
        casos = {
            "vencido": 2, "a vencer": 3, "prorrogado": 4, "baixado": 5,
            "protestado": 6, "cartório": 7, "pago": 8, "cancelado": 9,
        }
        for txt, esperado in casos.items():
            payload = {"status": txt}
            R._apply_status_id(payload)
            self.assertEqual(payload.get("status_id"), esperado, txt)

    def test_case_insensitive_e_trim(self):
        payload = {"status": "  FALHA "}
        R._apply_status_id(payload)
        self.assertEqual(payload.get("status_id"), 10)

    def test_constantes(self):
        self.assertEqual(R.STATUS_ID_A_VENCER, 3)
        self.assertEqual(R._STATUS_NAME_TO_ID["falha"], 10)


if __name__ == "__main__":
    unittest.main()
