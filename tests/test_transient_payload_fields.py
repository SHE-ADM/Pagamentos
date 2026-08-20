"""Chaves EFÊMERAS do payload (prefixo `_`) — metadados de decisão que NUNCA podem
chegar ao banco.

O pipeline precisa carregar informação ENTRE etapas: hoje, a procedência do fornecedor
(`_supplier_signal`), que decide se `apply_forced_classification` pode fazer write-back no
cadastro. Essa informação não é coluna de `financial_account_control`.

🔴 POR QUE ESTE ARQUIVO EXISTE: `register_financial` serializa o payload **inteiro**
(`json.dumps(payload)`) e o manda ao PostgREST. Qualquer chave que não seja coluna faz o
INSERT ser recusado com **PGRST204** — e o efeito não é uma linha errada, é a conta
**deixar de ser gravada**. A proteção é `strip_transient_fields` na FRONTEIRA de gravação,
em ponto único.

🔴 E POR QUE NÃO BASTA TESTAR A FUNÇÃO PURA: `strip_transient_fields` correta e não
chamada em `register_financial` é exatamente o defeito que derruba a gravação. Os testes
de `RegisterFinancialStripsTransientTest` inspecionam o **corpo realmente enviado** na
requisição, não o retorno da função.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402


class _Resp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _ctrl():
    c = R.SupabaseControl.__new__(R.SupabaseControl)  # sem __init__/env
    c._available = True
    c.base = "https://proj.supabase.co"
    c.headers = {"apikey": "k", "Authorization": "Bearer k", "Content-Type": "application/json"}
    return c


class StripTransientFieldsTest(unittest.TestCase):
    """A função pura."""

    def test_remove_so_as_chaves_prefixadas(self):
        got = R.strip_transient_fields({
            "amount": "51.00", "sk_supplier": 1262,
            R.SUPPLIER_SIGNAL_KEY: R.SUPPLIER_SIGNAL_FORWARDED_EMAIL,
            "_outra_efemera_qualquer": "x",
        })
        self.assertEqual(got, {"amount": "51.00", "sk_supplier": 1262})

    def test_nao_muta_o_dict_recebido(self):
        """🔴 Mutante: trocar a comprehension por `payload.pop(...)` — o chamador perderia
        a marca, e um `register_financial` chamado duas vezes (reprocessamento) mudaria de
        comportamento na segunda."""
        original = {"amount": "1", R.SUPPLIER_SIGNAL_KEY: R.SUPPLIER_SIGNAL_FORWARDED_EMAIL}
        R.strip_transient_fields(original)
        self.assertIn(R.SUPPLIER_SIGNAL_KEY, original)

    def test_payload_sem_efemera_passa_intacto(self):
        p = {"amount": "1", "sk_supplier": 2, "document_type": "dar / dare"}
        self.assertEqual(R.strip_transient_fields(p), p)

    def test_e_generica_por_prefixo_nao_por_lista_de_nomes(self):
        """A chave efêmera do ano que vem tem de ser limpa sem ninguém editar a função —
        o oposto (allowlist de nomes) falharia justamente no caso novo."""
        self.assertEqual(R.strip_transient_fields({"_inventada_agora": 1, "amount": 2}),
                         {"amount": 2})


class RegisterFinancialStripsTransientTest(unittest.TestCase):
    """🔴 O CALL SITE EXECUTADO — inspeciona o JSON que sai na requisição."""

    def _corpo_enviado(self, payload):
        ctrl = _ctrl()
        visto = {}

        def fake_urlopen(req, timeout=None):
            visto["body"] = json.loads(req.data.decode())
            return _Resp([{"id": 7}])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.register_financial(payload)
        self.assertIn("body", visto, "urlopen não foi chamado — o teste não provou nada")
        return visto["body"]

    def test_a_marca_nao_viaja_para_o_postgrest(self):
        """🔴 Mutante: remover `strip_transient_fields` de register_financial — a chave
        `_supplier_signal` entra no JSON e o PostgREST recusa o INSERT (PGRST204),
        derrubando a gravação da conta."""
        body = self._corpo_enviado({
            "gmail_message_id": "<m>", "amount": "51.00", "sk_supplier": 1262,
            R.SUPPLIER_SIGNAL_KEY: R.SUPPLIER_SIGNAL_FORWARDED_EMAIL,
        })
        self.assertNotIn(R.SUPPLIER_SIGNAL_KEY, body)
        # ANTI-VACUIDADE: as colunas de verdade continuaram no corpo.
        self.assertEqual(body["sk_supplier"], 1262)
        self.assertEqual(body["amount"], "51.00")

    def test_nenhuma_chave_efemera_sobrevive(self):
        body = self._corpo_enviado({
            "gmail_message_id": "<m>", "amount": "1",
            "_a": 1, "_b": 2, R.SUPPLIER_SIGNAL_KEY: "x",
        })
        self.assertEqual([k for k in body if k.startswith("_")], [])

    def test_o_dict_do_chamador_nao_e_alterado(self):
        """register_financial copia antes de limpar — o chamador segue com a marca (ele
        pode registrar anexo/erro depois usando o mesmo dict)."""
        payload = {"gmail_message_id": "<m>", "amount": "1",
                   R.SUPPLIER_SIGNAL_KEY: R.SUPPLIER_SIGNAL_FORWARDED_EMAIL}
        self._corpo_enviado(payload)
        self.assertEqual(payload[R.SUPPLIER_SIGNAL_KEY], R.SUPPLIER_SIGNAL_FORWARDED_EMAIL)


class EndToEndForwardedSignalTest(unittest.TestCase):
    """A cadeia inteira: _finalize_supplier marca → apply_forced_classification suprime o
    write-back → register_financial limpa a marca. Cada elo tem teste próprio; este prova
    que eles se conversam."""

    class _Ctrl:
        def __init__(self):
            self.writeback_calls = []
            self.resolve_calls = 0

        def find_supplier_by_email(self, email):
            return 1999 if email == "despachante@externo.com.br" else None

        def resolve_supplier(self, payload):
            self.resolve_calls += 1
            return 12345

        def supplier_defaults(self, sk):
            return (14, 116)

        def classification_for_account_code(self, code):
            return (3, 48)

        def update_supplier_classification(self, sk, cc, ca):
            self.writeback_calls.append((sk, cc, ca))

    def test_guia_encaminhada_nao_reescreve_o_cadastro_do_encaminhador(self):
        ctrl = self._Ctrl()
        payload = {"gmail_message_id": "<m>", "amount": "51.00",
                   "document_type": "gnre", "subject": "GUIA GNRE"}
        corpo = "De: Despachante <despachante@externo.com.br>\n"

        self.assertTrue(R._finalize_supplier(ctrl, payload, corpo))
        self.assertEqual(payload["sk_supplier"], 1999)          # veio do 1b
        self.assertEqual(ctrl.resolve_calls, 0)                 # sem auto-insert

        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], 3)          # a CONTA foi classificada
        self.assertEqual(payload["chart_account_id"], 48)
        self.assertEqual(ctrl.writeback_calls, [],
                         "o cadastro do encaminhador foi reescrito — a curadoria dele "
                         "vale para TODAS as contas futuras")

        # e a marca não vaza para o banco
        visto = {}

        def fake_urlopen(req, timeout=None):
            visto["body"] = json.loads(req.data.decode())
            return _Resp([{"id": 7}])

        sup = _ctrl()
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            sup.register_financial(payload)
        self.assertNotIn(R.SUPPLIER_SIGNAL_KEY, visto["body"])


if __name__ == "__main__":
    unittest.main()
