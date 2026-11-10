"""Cadeia de reembolso (Dr. Ricardo): fornecedor = quem encaminha, vencimento = dia do recebimento.

Medido: das 165 contas encaminhadas por ele, 125 foram corrigidas a mao de "Tribunal de Justica"
para o sk 1262. O risco esta nas redes que falam DEPOIS da regra: o fator do barcode revertia a
data, e o fornecedor unico + o mesmo dia faziam processos distintos colidirem na dedup.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))

import read_emails as R  # noqa: E402

SK = 1262
EMAIL = "ricardo.advogado@yahoo.com.br"
CORPO = (f"De: JOSE RICARDO PRUDENTE <{EMAIL}> \r\n"
         "Enviada em: terça-feira, 3 de novembro de 2026 07:19\r\n"
         "Para: Bárbara <barbara@otimotex.com.br>\r\nAssunto: 4003656 31 2026 8 26 0568\r\n")
RECEBIDO = "2026-11-03T13:00:00+00:00"


class _Ctrl:
    def __init__(self, cadastrados=None):
        self.cadastrados = {EMAIL: SK} if cadastrados is None else cadastrados
        self.resolve_calls, self.write_backs, self.lookup_calls = 0, [], []

    def find_supplier_by_email(self, email):
        self.lookup_calls.append(email)
        return self.cadastrados.get(email)

    def resolve_supplier(self, payload):
        self.resolve_calls += 1
        return 1297

    def supplier_defaults(self, sk):
        return (14, 116)

    def company_cnpj(self):
        return "47273917000123"

    def update_supplier_classification(self, *a):
        self.write_backs.append(a)


def _payload(**over):
    payload = {"supplier_name": "Tribunal de Justiça Estado de São Paulo",
               "supplier_cnpj": "51174001000193", "document_type": "boleto",
               "sender_email": "barbara@otimotex.com.br", "subject": "boleto: 4003656",
               "due_date": "2026-11-06", "amount": 38.42,
               "processing_notes": "Vencimento ausente — usando data da extração | outra nota",
               R.RECEIVED_AT_KEY: RECEBIDO}
    payload.update(over)
    return payload


class OverrideTest(unittest.TestCase):
    def test_tribunal_no_pdf_vira_o_remetente_com_data_de_recebimento(self):
        ctrl, payload = _Ctrl(), _payload()
        self.assertTrue(R._finalize_supplier(ctrl, payload, CORPO))
        self.assertEqual(payload["sk_supplier"], SK)
        self.assertEqual(payload["due_date"], "2026-11-03")
        self.assertNotIn("supplier_name", payload)
        self.assertEqual((payload["cost_center_id"], payload["chart_account_id"]), (14, 116))
        self.assertEqual(ctrl.resolve_calls, 0)
        self.assertNotIn("Vencimento ausente", payload["processing_notes"])
        self.assertIn("outra nota", payload["processing_notes"])
        self.assertIn(R.FIXED_CHAIN_DUE_NOTE, payload["processing_notes"])

    def test_madrugada_utc_cai_no_dia_anterior_de_brasilia(self):
        payload = _payload(**{R.RECEIVED_AT_KEY: "2026-11-04T01:30:00+00:00"})
        R._finalize_supplier(_Ctrl(), payload, CORPO)
        self.assertEqual(payload["due_date"], "2026-11-03")

    def test_elo_intermediario_da_cadeia_tambem_conta(self):
        # O elo mais profundo e o tribunal; _forwarded_sender_email devolveria ele.
        corpo = CORPO + "\r\nDe: Tribunal <naoresponda@tjsp.jus.br>\r\nAssunto: guia\r\n"
        payload = _payload()
        R._finalize_supplier(_Ctrl(), payload, corpo)
        self.assertEqual(payload["sk_supplier"], SK)

    def test_endereco_quebrado_em_duas_linhas(self):
        corpo = f"De: JOSE RICARDO PRUDENTE\r\n<{EMAIL}>\r\nAssunto: guia\r\n"
        self.assertEqual(R._fixed_chain_sender("barbara@otimotex.com.br", corpo), EMAIL)

    def test_remetente_imediato_conta(self):
        self.assertEqual(R._fixed_chain_sender(EMAIL.upper(), ""), EMAIL)

    def test_citado_fora_do_de_nao_dispara(self):
        corpo = f"Para: <{EMAIL}>\r\nCc: {EMAIL}\r\nFavor enviar a {EMAIL}\r\n"
        self.assertIsNone(R._fixed_chain_sender("barbara@otimotex.com.br", corpo))

    def test_sem_cadastro_segue_a_resolucao_normal_e_nunca_cria(self):
        ctrl, payload = _Ctrl(cadastrados={}), _payload()
        R._finalize_supplier(ctrl, payload, CORPO)
        self.assertEqual(payload["sk_supplier"], 1297)
        self.assertEqual(payload["due_date"], "2026-11-06")
        self.assertNotIn(R.DUE_DATE_FIXED_KEY, payload)

    def test_sem_data_de_recebimento_muda_so_o_fornecedor(self):
        payload = _payload()
        del payload[R.RECEIVED_AT_KEY]
        R._finalize_supplier(_Ctrl(), payload, CORPO)
        self.assertEqual(payload["sk_supplier"], SK)
        self.assertEqual(payload["due_date"], "2026-11-06")
        self.assertNotIn(R.DUE_DATE_FIXED_KEY, payload)

    def test_paridade_do_prefixo_da_nota_de_vencimento_ausente(self):
        import extract_pdf
        self.assertTrue(extract_pdf.DUE_DATE_ABSENT_NOTE.startswith(R._DUE_DATE_ABSENT_PREFIX))

    def test_classificacao_e_contato_nao_escrevem_no_cadastro(self):
        ctrl, payload = _Ctrl(), _payload(document_type="cte", subject="frete transporte")
        R._finalize_supplier(ctrl, payload, CORPO)
        with mock.patch.object(R, "parse_supplier_contacts") as contatos:
            R.apply_forced_classification(ctrl, payload)
            R.apply_contact_writeback(ctrl, payload, extra_text="pix 11999998888")
        contatos.assert_not_called()
        self.assertEqual(ctrl.write_backs, [])
        self.assertEqual(payload["chart_account_id"], 116)


class RedeDoBarcodeTest(unittest.TestCase):
    """🔴 Executa register_financial: a reversao so aparece na ultima camada antes do POST."""

    def _grava(self, payload):
        corpos = []

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return json.dumps([{"id": 1}]).encode()

        def urlopen(req, timeout=None):
            corpos.append(json.loads(req.data))
            return Resp()

        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl._available, ctrl.base, ctrl.headers = True, "http://x", {}
        chamada = mock.MagicMock()
        with mock.patch("urllib.request.urlopen", urlopen), \
             mock.patch.object(R, "_apply_barcode_due_date", chamada), \
             mock.patch.object(R.SupabaseControl, "resolve_user", lambda s, e: None):
            ctrl.register_financial(payload)
        return corpos[-1], chamada

    def test_data_fixada_nao_passa_pela_rede_e_chaves_efemeras_nao_vao_ao_banco(self):
        payload = _payload()
        R._finalize_supplier(_Ctrl(), payload, CORPO)
        corpo, rede = self._grava(payload)
        rede.assert_not_called()
        self.assertEqual(corpo["due_date"], "2026-11-03")
        self.assertFalse([k for k in corpo if k.startswith("_")], "PGRST204 derrubaria a gravacao")

    def test_conta_comum_continua_passando_pela_rede(self):
        _, rede = self._grava({"due_date": "2026-11-06", "barcode": "1", R.RECEIVED_AT_KEY: RECEBIDO})
        rede.assert_called_once()


class DedupTest(unittest.TestCase):
    def _dedup(self, payload, respostas):
        """Devolve o resultado e as consultas feitas; `respostas` casa por trecho da URL."""
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl._available, ctrl.base, ctrl.headers = True, "http://x", {}
        urls = []

        class Resp:
            def __init__(self, rows):
                self.rows = rows

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return json.dumps(self.rows).encode()

        def urlopen(req, timeout=None):
            urls.append(req.full_url)
            rows = next((r for trecho, r in respostas.items() if trecho in req.full_url), [])
            return Resp(rows)

        with mock.patch("urllib.request.urlopen", urlopen):
            return ctrl.find_financial_duplicate(payload), urls

    def test_processos_distintos_de_mesmo_valor_e_dia_nao_se_fundem(self):
        # 2031/2032: R$ 153,23, sem barcode. A impressao 3 casaria e a 2a conta sumiria.
        base = {"sk_supplier": SK, "amount": 153.23, "due_date": "2026-10-16"}
        fixado, urls = self._dedup({**base, R.DUE_DATE_FIXED_KEY: True},
                                   {"amount=eq.153.23": [{"id": 2031}]})
        self.assertIsNone(fixado)
        self.assertFalse(any("due_date=eq" in u for u in urls))
        # Anti-vacuidade: sem a flag, a mesma resposta casa.
        comum, _ = self._dedup(base, {"amount=eq.153.23": [{"id": 2031}]})
        self.assertEqual(comum["id"], 2031)

    def test_mesmo_barcode_continua_casando(self):
        achado, _ = self._dedup({"sk_supplier": SK, "barcode": "123", "amount": 1,
                                 "due_date": "2026-10-16", R.DUE_DATE_FIXED_KEY: True},
                                {"barcode=eq.123": [{"id": 9, "barcode": "123"}]})
        self.assertEqual(achado["id"], 9)


class ReencaminhamentoTest(unittest.TestCase):
    """Executa extract_and_store_accounts: a reemissao moveria a data ate de conta paga."""

    def _roda(self, barcode_novo, barcode_da_conta):
        linha = {"source_file": "b.pdf", "document_type": "boleto", "payment_method": "boleto",
                 "amount": "38.42", "due_date": "2026-11-20", "barcode": barcode_novo,
                 "supplier_name": "Tribunal"}
        conta = {"id": 77, "due_date": "2026-10-30", "barcode": barcode_da_conta, "status_id": 8}
        ctrl = mock.MagicMock()
        ctrl.company_cnpj.return_value = "47273917000123"
        ctrl.find_supplier_by_email.side_effect = lambda e: SK if e == EMAIL else None
        ctrl.supplier_defaults.return_value = (14, 116)
        ctrl.find_financial_duplicate.return_value = conta
        ctrl.resolve_user.return_value = None
        rec = {"sender_email": "barbara@otimotex.com.br", "subject": "boleto: 1",
               "received_at": RECEBIDO}
        with mock.patch.object(R, "_attachment_text", lambda p: ""), \
             mock.patch.object(R, "_register_fiscal_documents", mock.MagicMock()), \
             mock.patch.object(R, "run_extraction", lambda p, pw=None: (str(p), None)), \
             mock.patch.object(R, "read_extracted_rows", lambda c: [linha]):
            R.extract_and_store_accounts([Path("b.pdf")], "<m>", ctrl, email_rec=rec, body_text=CORPO)
        return ctrl

    def test_mesmo_barcode_nao_move_a_data_de_conta_paga(self):
        ctrl = self._roda("123", "123")
        ctrl.update_financial.assert_not_called()

    def test_barcode_novo_e_reemissao_e_atualiza(self):
        ctrl = self._roda("456", "123")
        ctrl.update_financial.assert_called_once()
        self.assertEqual(ctrl.update_financial.call_args.args[1]["due_date"], "2026-11-03")


if __name__ == "__main__":
    unittest.main()
