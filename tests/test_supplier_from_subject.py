"""
Testes para _supplier_name_from_subject + integracao em _finalize_supplier.

Regressao: e-mail interno de pagamento ("PAGAMENTO BOLETO HYOSUNG 181063-3")
cujo anexo/imagem nao traz nome/CNPJ e cujo remetente (@otimotex.com.br) e
bloqueado como fornecedor caia em db_erro "Falha ao resolver fornecedor",
PERDENDO a conta (com valor + codigo de barras). O assunto nomeia o favorecido,
entao passa a ser usado como ULTIMO recurso para o nome do fornecedor.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402


class SupplierNameFromSubjectTest(unittest.TestCase):
    def test_boleto_com_prefixo_e_numero(self):
        self.assertEqual(
            R._supplier_name_from_subject("PAGAMENTO BOLETO HYOSUNG 181063-3"),
            "HYOSUNG",
        )

    def test_prefixo_de_encaminhamento(self):
        self.assertEqual(
            R._supplier_name_from_subject("ENC: PAGAMENTO BOLETO HYOSUNG 181063-1"),
            "HYOSUNG",
        )

    def test_pix_com_descricao_e_pessoa(self):
        self.assertEqual(
            R._supplier_name_from_subject("PAGAMENTO PIX SORTEIO BLUSAS DO BRASIL - SAMUEL"),
            "SORTEIO BLUSAS DO BRASIL - SAMUEL",
        )

    def test_nome_simples(self):
        self.assertEqual(R._supplier_name_from_subject("PAGAMENTO FORNECEDOR ACME LTDA"),
                         "FORNECEDOR ACME LTDA")

    def test_so_numeros_retorna_vazio(self):
        self.assertEqual(R._supplier_name_from_subject("PAGAMENTO BOLETO 181063-3"), "")

    def test_vazio_e_none(self):
        self.assertEqual(R._supplier_name_from_subject(""), "")
        self.assertEqual(R._supplier_name_from_subject(None), "")

    def test_tipo_de_documento_nao_vira_fornecedor(self):
        # "ENC: GUIA GNRE" -> "GNRE" (tipo de documento) -> rejeitado
        self.assertEqual(R._supplier_name_from_subject("ENC: GUIA GNRE ."), "")
        self.assertEqual(R._supplier_name_from_subject("PAGAMENTO DARF"), "")
        self.assertEqual(R._supplier_name_from_subject("PAGAMENTO GNRE MG"), "")

    def test_ancora_sigla_ltda_descarta_prefixo(self):
        # Caso real da conta id 401: prefixo "FATURAMENTO --" + cauda de data;
        # a sigla LTDA ancora o nome do fornecedor real.
        self.assertEqual(
            R._supplier_name_from_subject(
                "ENC: FATURAMENTO -- MOVVI LOGISTICA LTDA 03/07/2026"),
            "MOVVI LOGISTICA LTDA",
        )

    def test_ancora_sigla_sa_com_cauda_de_numero(self):
        self.assertEqual(
            R._supplier_name_from_subject("PAGAMENTO ACME COMERCIO S/A - 12345"),
            "ACME COMERCIO S/A",
        )

    def test_ancora_sigla_sem_separador_remove_ruido(self):
        self.assertEqual(
            R._supplier_name_from_subject("FATURAMENTO ACME DISTRIBUIDORA LTDA"),
            "ACME DISTRIBUIDORA LTDA",
        )


class SupplierNameByLegalSuffixTest(unittest.TestCase):
    def test_sem_sigla_retorna_vazio(self):
        self.assertEqual(R._supplier_name_by_legal_suffix("PAGAMENTO BOLETO HYOSUNG"), "")
        self.assertEqual(R._supplier_name_by_legal_suffix(""), "")
        self.assertEqual(R._supplier_name_by_legal_suffix(None), "")

    def test_ultima_sigla_quando_ha_mais_de_uma(self):
        # Prefixo "OTIMOTEX LTDA" (pagador) + fornecedor real ao final: fica com o ultimo.
        self.assertEqual(
            R._supplier_name_by_legal_suffix(
                "OTIMOTEX LTDA -- MOVVI LOGISTICA LTDA"),
            "MOVVI LOGISTICA LTDA",
        )


class IsNonSupplierTermTest(unittest.TestCase):
    def test_tipos_documento_e_pagamento(self):
        for t in ("GNRE", "boleto", "PIX", "DARF", "das", "Fatura", "TED", "guia",
                  "gnre mg", "darf sp"):
            self.assertTrue(R._is_non_supplier_term(t), t)

    def test_fornecedor_que_apenas_contem_a_palavra(self):
        # nao rejeita nomes reais que CONTÊM um termo
        for t in ("Porto Seguro", "Vale Fertilizantes", "HYOSUNG",
                  "SORTEIO BLUSAS DO BRASIL - SAMUEL"):
            self.assertFalse(R._is_non_supplier_term(t), t)


class _FakeCtrl:
    """SupabaseControl minimo: captura o p_name resolvido pela RPC."""

    def __init__(self, own_cnpj=None):
        self.last_payload = None
        self._own_cnpj = own_cnpj

    def company_cnpj(self):
        return self._own_cnpj

    def resolve_supplier(self, payload):
        self.last_payload = dict(payload)
        # simula a RPC: so resolve quando ha um identificador valido
        name = (payload.get("supplier_name") or "").strip()
        cnpj = (payload.get("supplier_cnpj") or "").strip()
        cpf = (payload.get("supplier_cpf") or "").strip()
        if name or cnpj or cpf:
            return 12345  # sk_supplier ficticio
        return None

    def supplier_defaults(self, sk_supplier):
        return (0, 0)


class FinalizeSupplierSubjectFallbackTest(unittest.TestCase):
    def test_sem_identificador_usa_assunto(self):
        ctrl = _FakeCtrl()
        payload = {
            "amount": "9603.06",
            "subject": "PAGAMENTO BOLETO HYOSUNG 181063-3",
            "sender_email": "ester@otimotex.com.br",
        }
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], 12345)
        # o nome derivado do assunto foi enviado a RPC
        self.assertEqual(ctrl.last_payload["supplier_name"], "HYOSUNG")
        # colunas denormalizadas removidas do payload final
        self.assertNotIn("supplier_name", payload)

    def test_identificador_extraido_tem_precedencia(self):
        ctrl = _FakeCtrl()
        payload = {
            "amount": "100.00",
            "supplier_name": "REAL LTDA",
            "subject": "PAGAMENTO BOLETO OUTRO NOME 999",
        }
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        # nao sobrescreve o nome ja extraido
        self.assertEqual(ctrl.last_payload["supplier_name"], "REAL LTDA")

    def test_assunto_inutil_e_sem_pagador_segue_falhando(self):
        ctrl = _FakeCtrl()
        payload = {"amount": "100.00", "subject": "PAGAMENTO 12345"}
        ok = R._finalize_supplier(ctrl, payload)
        self.assertFalse(ok)  # sem nome utilizavel nem pagador -> db_erro (correto)

    def test_tipo_documento_extraido_e_descartado(self):
        """Se a extracao puser um TIPO ('GNRE') como supplier_name, e descartado."""
        ctrl = _FakeCtrl()
        payload = {
            "amount": "57.91", "supplier_name": "GNRE",
            "subject": "ENC: GUIA GNRE", "payer_name": "TEXTIL E CONFECCOES OTIMOTEX",
        }
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)  # cai no pagador
        self.assertEqual(ctrl.last_payload["supplier_name"], "TEXTIL E CONFECCOES OTIMOTEX")

    def test_ultimo_recurso_usa_pagador(self):
        """GNRE interno: sem nome/CNPJ/CPF/e-mail útil e assunto = tipo -> usa o PAGADOR."""
        ctrl = _FakeCtrl()
        payload = {
            "amount": "57.91", "subject": "ENC: GUIA GNRE .",
            "sender_email": "rosangela@lebianco.com.br",
            "payer_name": "TEXTIL E CONFECCOES OTIMOTEX", "payer_cnpj": "47.273.917/0001-23",
        }
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], 12345)
        # pagador entrou como fornecedor (nome ou CNPJ de 14 digitos)
        self.assertEqual(ctrl.last_payload.get("supplier_cnpj"), "47273917000123")
        self.assertEqual(ctrl.last_payload.get("supplier_name"), "TEXTIL E CONFECCOES OTIMOTEX")


class FinalizePayerCnpjGuardTest(unittest.TestCase):
    """Regressao conta id 401: e-mail de faturamento reencaminhado traz o bloco do
    destinatario (OTIMOTEX) e a extracao capturava o CNPJ da PROPRIA pagadora como
    fornecedor, gravando a conta sob a OTIMOTEX (sk=1). O favorecido real estava
    nomeado no assunto ('MOVVI LOGISTICA LTDA')."""

    OTIMOTEX_CNPJ = "47273917000123"

    def test_cnpj_do_pagador_ignorado_usa_assunto_ltda(self):
        ctrl = _FakeCtrl(own_cnpj=self.OTIMOTEX_CNPJ)
        payload = {
            "amount": "167.15",
            "supplier_cnpj": self.OTIMOTEX_CNPJ,  # CNPJ da propria OTIMOTEX (pagador)
            "subject": "ENC: FATURAMENTO -- MOVVI LOGISTICA LTDA 03/07/2026",
            "sender_email": "rose@otimotex.com.br",
        }
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        # o CNPJ do pagador foi descartado — nao entrou na RPC como fornecedor
        self.assertIsNone(ctrl.last_payload.get("supplier_cnpj"))
        # o nome ancorado na sigla LTDA do assunto foi usado
        self.assertEqual(ctrl.last_payload.get("supplier_name"), "MOVVI LOGISTICA LTDA")

    def test_cnpj_de_terceiro_e_preservado(self):
        # CNPJ de fornecedor real (diferente do pagador) NAO e descartado.
        ctrl = _FakeCtrl(own_cnpj=self.OTIMOTEX_CNPJ)
        payload = {
            "amount": "100.00",
            "supplier_cnpj": "11703922000181",  # HYOSUNG (terceiro)
            "subject": "PAGAMENTO BOLETO HYOSUNG",
        }
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        self.assertEqual(ctrl.last_payload.get("supplier_cnpj"), "11703922000181")

    def test_cnpj_de_outra_filial_do_mesmo_grupo_e_descartado(self):
        """Regressao id 668 (fatura Contabil Esquema encaminhada, e-mail 1004): o
        bloco do destinatario trazia o CNPJ de uma filial (47273917/0003-95) —
        mesma raiz da OTIMOTEX (sk_company=1, CNPJ 47273917/0001-23), sufixo
        diferente. Match exato deixava passar e a conta era gravada sob o
        sk_supplier de uma filial da propria OTIMOTEX ja mal-cadastrada como
        "fornecedor" (sk_supplier 404, trade_name "CDI")."""
        ctrl = _FakeCtrl(own_cnpj=self.OTIMOTEX_CNPJ)
        payload = {
            "amount": "2950.00",
            "supplier_cnpj": "47273917000395",  # filial 0003-95 — mesma raiz, sufixo distinto
            "subject": "pagamento Sua Fatura",
        }
        ok = R._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        self.assertIsNone(ctrl.last_payload.get("supplier_cnpj"))


if __name__ == "__main__":
    unittest.main()
