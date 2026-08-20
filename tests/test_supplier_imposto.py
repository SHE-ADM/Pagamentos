"""
Testes da regra de IMPOSTO em _finalize_supplier: guia de tributo (darf/das/gnre/...)
SEM favorecido real e lancada sob a OTIMOTEX (sk=1), em vez de criar um "fornecedor"
generico do assunto ("IMPOSTOS", "GNRE -PAGAMENTO", "DARE - REF").

Caso real: id 374 (document_type=darf, assunto "PAGAMENTO IMPOSTOS", pagador OTIMOTEX)
gravava o fornecedor ficticio "IMPOSTOS". Favorecido REAL extraido do documento
(ex.: "PREFEITURA DE SAO PAULO") NAO dispara a regra e e preservado.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402


class _FakeCtrl:
    """SupabaseControl minimo: resolve por nome/CNPJ/CPF (sk ficticio) e defaults 0.
    Conta as chamadas a resolve_supplier para provar o curto-circuito da regra.

    `find_supplier_by_email` esta presente e devolve None DE PROPOSITO: sem o metodo, o
    `getattr` de _finalize_supplier faz o fallback 1b sair ANTES de consultar, e o teste
    de anti-regressao abaixo mediria "ctrl legado sem o metodo" em vez de "remetente nao
    cadastrado" — duas coisas diferentes. `lookup_calls` prova que a consulta ocorreu."""

    def __init__(self):
        self.last_payload = None
        self.resolve_calls = 0
        self.lookup_calls = []

    def find_supplier_by_email(self, email):
        self.lookup_calls.append(email)
        return None   # ninguem cadastrado com esse endereco

    def resolve_supplier(self, payload):
        self.resolve_calls += 1
        self.last_payload = dict(payload)
        name = (payload.get("supplier_name") or "").strip()
        cnpj = (payload.get("supplier_cnpj") or "").strip()
        cpf = (payload.get("supplier_cpf") or "").strip()
        return 12345 if (name or cnpj or cpf) else None

    def supplier_defaults(self, sk_supplier):
        return (0, 0)


class IsTaxDocumentTest(unittest.TestCase):
    def test_tipos_de_imposto(self):
        for t in ("darf", "DAS", "gru", "dae", "dare", "gnre", "GARE", "ipva",
                  "iptu", "dam", "duam", "iss", "itbi", "tributo", "Darf"):
            self.assertTrue(R._is_tax_document(t), t)

    def test_nao_imposto(self):
        # 'gps' (INSS) e 'multa' ficam de fora por decisao do usuario.
        for t in ("boleto", "pix", "nfe", "cte", "fatura", "recibo",
                  "honorarios", "gps", "multa", None, ""):
            self.assertFalse(R._is_tax_document(t), t)


class TaxSupplierRuleTest(unittest.TestCase):
    def test_imposto_sem_favorecido_grava_otimotex(self):
        # caso real id 374: darf, assunto "PAGAMENTO IMPOSTOS", pagador OTIMOTEX.
        ctrl = _FakeCtrl()
        payload = {
            "amount": "4736.54", "document_type": "darf",
            "subject": "PAGAMENTO IMPOSTOS",
            "payer_name": "TEXTIL E CONFECCOES OTIMOTEX LTDA",
            "payer_cnpj": "47273917000123",
        }
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        # NAO derivou "IMPOSTOS" do assunto — a RPC de resolucao nem foi chamada.
        self.assertEqual(ctrl.resolve_calls, 0)
        self.assertNotIn("supplier_name", payload)

    def test_imposto_sem_pagador_nem_assunto_ainda_grava_otimotex(self):
        ctrl = _FakeCtrl()
        payload = {"amount": "100.00", "document_type": "gnre"}
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.resolve_calls, 0)

    def test_imposto_com_favorecido_real_preserva(self):
        # ISS com "PREFEITURA DE SAO PAULO" extraida do documento — nao vira OTIMOTEX.
        ctrl = _FakeCtrl()
        payload = {
            "amount": "100.00", "document_type": "iss",
            "supplier_name": "PREFEITURA DO MUNICIPIO DE SAO PAULO",
            "subject": "PAGAMENTO ISS",
        }
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], 12345)  # resolvido pelo nome real
        self.assertEqual(ctrl.last_payload["supplier_name"],
                         "PREFEITURA DO MUNICIPIO DE SAO PAULO")

    def test_imposto_com_cnpj_extraido_preserva(self):
        ctrl = _FakeCtrl()
        payload = {"amount": "50.00", "document_type": "gare",
                   "supplier_cnpj": "12345678000199"}
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], 12345)

    def test_imposto_com_encaminhador_nao_cadastrado_ainda_grava_otimotex(self):
        """Anti-regressão do fallback 1b (migration 134): um bloco ENCAMINHADO no corpo
        não afrouxa a regra de imposto quando o remetente original NÃO está cadastrado.

        🔴 Mutante: fazer o fallback 1b atribuir o fornecedor mesmo com o lookup
        devolvendo None — a família do id 374 passaria a criar fornecedor a partir de
        quem encaminhou o e-mail."""
        ctrl = _FakeCtrl()   # o lookup existe e devolve None → nada cadastrado
        payload = {
            "amount": "4736.54", "document_type": "darf",
            "subject": "PAGAMENTO IMPOSTOS",
            "payer_name": "TEXTIL E CONFECCOES OTIMOTEX LTDA",
            "payer_cnpj": "47273917000123",
        }
        corpo = "De: Fulano de Tal <fulano@desconhecido.com.br>\nAssunto: guia\n"
        ok = R._finalize_supplier(ctrl, payload, corpo)
        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.resolve_calls, 0)
        self.assertNotIn("supplier_name", payload)
        # 🔴 ANTI-VACUIDADE: o bloco 1b RODOU e recusou. Sem esta asserção o teste
        # passaria também com o fallback saindo antes de consultar — que era o caso
        # real quando o fake não tinha o método (achado do review de 2026-08-19).
        self.assertEqual(ctrl.lookup_calls, ["fulano@desconhecido.com.br"])

    def test_nao_imposto_sem_favorecido_segue_falhando(self):
        # boleto sem favorecido real e sem pagador → db_erro (comportamento antigo).
        ctrl = _FakeCtrl()
        payload = {"amount": "100.00", "document_type": "boleto",
                   "subject": "PAGAMENTO 12345"}
        ok = R._finalize_supplier(ctrl, payload)
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
