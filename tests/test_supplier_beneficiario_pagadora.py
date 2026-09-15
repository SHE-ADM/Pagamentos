"""Boleto cujo BENEFICIÁRIO é a própria pagadora (OTIMOTEX) e o PAGADOR é um terceiro → sk 1.

Caso real (conta 933, e-mail "BOLETOS SAMUEL - SHADOW 3"; dados corrigidos na migration 141): o
boleto imprime como beneficiário "CONFECCOES OTIMOTEX - CNPJ 047.273.917/0001-23" e como pagador
CONFECCOES SHADOW LTDA. O pipeline descartava o CNPJ pela raiz da pagadora, e o nome curto — que não
é a razão social exata — ia à RPC e criava o cadastro-apelido 1227. Removido, o apelido continuaria
casando, porque a RPC ignora `deleted_at` no passo por nome. Decisão do usuário (2026-09-15): esse
boleto vai para o sk 1.

Propriedades travadas:

🔴 1. CNPJ da raiz do sk 1 + nome reconhecido como a pagadora + pagador TERCEIRO (CNPJ de outra
      raiz ou CPF) ⇒ sk 1, sem passar pela RPC — inclusive com a razão social EXATA, que a guarda
      por nome removeria antes.
🔴 2. NÃO herda o default de classificação do sk 1 (RH / Vale Alimentação — o plano errado de
      895/1396); a guia de tributo, que tem regra própria, continua herdando.
🔴 3. NÃO regredir o caso MOVVI: bloco do DESTINATÁRIO copiado no fornecedor, com o PAGADOR também
      OTIMOTEX, segue para o favorecido do assunto.
🔴 4. Conservadora: pagador ausente, CNPJ da LE BLANC (fornecedora legítima) ou nome de terceiro não
      disparam a regra.
🔴 5. Call site EXECUTADO (`extract_and_store_accounts`).
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R

CNPJ_TECIDOS = "47273917000123"
CNPJ_LE_BLANC = "20584679000110"
CNPJ_SHADOW = "45531878000191"
NOME_CURTO = "CONFECCOES OTIMOTEX"                  # como o boleto da conta 933 imprime
RAZAO_SOCIAL = "TÊXTIL E CONFECÇÕES OTIMOTEX LTDA"
SK_APELIDO = 1227
SK_LE_BLANC_FORNECEDOR = 999
SK_OUTRO_FORNECEDOR = 12345
DEFAULT_SK1 = (8, 478)                            # RH / Vale Alimentação

COMPANY_ROWS = [
    {"sk_company": 1, "cnpj": CNPJ_TECIDOS, "legal_name": RAZAO_SOCIAL, "trade_name": "OTIMOTEX TECIDOS"},
    {"sk_company": 2, "cnpj": "47273917000223", "legal_name": "LEBIANCO PLÁSTICOS", "trade_name": "LEBIANCO"},
    {"sk_company": 3, "cnpj": "47273917000323", "legal_name": "OTIMOTEX IMPORTAÇÕES", "trade_name": "OTIMOTEX FARDOS"},
    {"sk_company": 4, "cnpj": CNPJ_LE_BLANC, "legal_name": "LE BLANC ADMINISTRACAO DE BENS PROPRIOS LTDA",
     "trade_name": "LE BLANC"},
]
OWN_NAMES = frozenset(R._company_legal_names_from_rows(COMPANY_ROWS))
BRAND = frozenset(R._company_brand_tokens_from_rows(COMPANY_ROWS))


class _Ctrl:
    """Ctrl mínimo: a RPC emula a ordem real (CNPJ antes do nome) e o ímã do apelido 1227."""

    def __init__(self):
        self.payloads = []

    def company_cnpj(self):
        return CNPJ_TECIDOS

    def company_cnpjs(self):
        return [row["cnpj"] for row in COMPANY_ROWS]

    def company_legal_names(self):
        return OWN_NAMES

    def company_brand_tokens(self):
        return BRAND

    def find_supplier_by_email(self, email):
        return None

    def resolve_supplier(self, payload):
        self.payloads.append(dict(payload))
        cnpj = payload.get("supplier_cnpj")
        if cnpj == CNPJ_TECIDOS:
            return R.OTIMOTEX_SK_SUPPLIER
        if cnpj == CNPJ_LE_BLANC:
            return SK_LE_BLANC_FORNECEDOR
        if R._normalize_company_name(payload.get("supplier_name")) == R._normalize_company_name(NOME_CURTO):
            return SK_APELIDO
        return SK_OUTRO_FORNECEDOR if (payload.get("supplier_name") or cnpj) else None

    def supplier_defaults(self, sk_supplier):
        return DEFAULT_SK1 if sk_supplier == R.OTIMOTEX_SK_SUPPLIER else (0, 0)


# O boleto IMPRIME "047.273.917/0001-23" (15 dígitos, formato bancário), mas o reader recebe 14:
# o prompt pede só dígitos com 14 caracteres e `extract_pdf` descarta CNPJ de outro tamanho.
def _boleto(**over):
    payload = {"document_type": "boleto", "amount": "12364.34", "subject": "BOLETOS SAMUEL - SHADOW 3",
               "sender_email": "barbara@otimotex.com.br",
               "supplier_name": NOME_CURTO, "supplier_cnpj": "47.273.917/0001-23", "supplier_cpf": None,
               "payer_name": "CONFECCOES SHADOW LTDA", "payer_cnpj": CNPJ_SHADOW}
    payload.update(over)
    return payload


class BeneficiarioPagadoraTest(unittest.TestCase):

    def test_conta_933_vai_ao_sk1_sem_rpc_e_sem_default(self):
        ctrl = _Ctrl()
        payload = _boleto()
        # Anti-vacuidade: a guarda exata por razão social NÃO reconhece o nome curto.
        self.assertFalse(R._is_own_company_name(NOME_CURTO, OWN_NAMES))

        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))

        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [], "o nome curto na RPC recriaria o apelido 1227")
        self.assertNotIn("cost_center_id", payload, "nao pode herdar RH do sk 1")
        self.assertNotIn("chart_account_id", payload, "nao pode herdar Vale Alimentacao do sk 1")
        for col in ("supplier_name", "supplier_cnpj", "supplier_cpf"):
            self.assertNotIn(col, payload)

    def test_razao_social_exata_tambem_vai_ao_sk1(self):
        # A guarda por razão social remove o nome ANTES; a regra precisa do nome capturado antes dela.
        self.assertTrue(R._is_own_company_name(RAZAO_SOCIAL, OWN_NAMES), "sanidade: o nome e o exato")
        ctrl = _Ctrl()
        payload = _boleto(supplier_name=RAZAO_SOCIAL)
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [])

    def test_pagador_pessoa_fisica_e_terceiro(self):
        ctrl = _Ctrl()
        payload = _boleto(payer_name="SAMUEL DA SILVA", payer_cnpj="123.456.789-09")
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [])


class NaoRegredirTest(unittest.TestCase):

    def test_destinatario_copiado_com_pagador_otimotex_nao_dispara(self):
        # Caso MOVVI: a extração copia o bloco do DESTINATÁRIO (a OTIMOTEX) no fornecedor E no
        # pagador. A regra não pode decidir sozinha — o fluxo anterior segue intacto.
        nome_destinatario = "TEXTIL E CONF.OTIMOTEX"
        # Anti-vacuidade: o nome É reconhecido como a pagadora — quem barra a regra é o PAGADOR.
        self.assertTrue(R._is_contribuinte_name(nome_destinatario, None, OWN_NAMES, BRAND))
        ctrl = _Ctrl()
        payload = _boleto(supplier_name=nome_destinatario, supplier_cnpj="47273917/0001-23",
                          payer_name=nome_destinatario, payer_cnpj=CNPJ_TECIDOS,
                          subject="FATURAMENTO -- MOVVI LOGISTICA LTDA 25/07/2026",
                          sender_email="sender@movvi.com.br")
        self.assertFalse(R._beneficiary_is_own_payer(nome_destinatario, CNPJ_TECIDOS, payload,
                                                     CNPJ_TECIDOS, OWN_NAMES, BRAND))

        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))

        self.assertTrue(ctrl.payloads, "o fluxo anterior (RPC) precisa ter rodado")
        self.assertIsNone(ctrl.payloads[0].get("supplier_cnpj"),
                          "o CNPJ do destinatario continua saindo pela raiz, como antes")

    def test_pagador_ausente_nao_dispara(self):
        ctrl = _Ctrl()
        payload = _boleto(payer_cnpj=None)
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertTrue(ctrl.payloads, "sem pagador por documento a regra nao pode decidir sozinha")

    def test_cnpj_da_le_blanc_com_pagador_terceiro_e_fornecedora(self):
        ctrl = _Ctrl()
        payload = _boleto(supplier_name="LE BLANC ADMINISTRADORA", supplier_cnpj=CNPJ_LE_BLANC,
                          subject="ALUGUEL")
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], SK_LE_BLANC_FORNECEDOR)
        self.assertEqual(ctrl.payloads[0]["supplier_cnpj"], CNPJ_LE_BLANC)

    def test_nome_de_terceiro_com_cnpj_da_otimotex_nao_dispara(self):
        ctrl = _Ctrl()
        payload = _boleto(supplier_name="KALIMO TEXTIL LTDA")
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], SK_OUTRO_FORNECEDOR)
        self.assertEqual(ctrl.payloads[0]["supplier_name"], "KALIMO TEXTIL LTDA")

    def test_guia_de_tributo_segue_a_regra_propria_e_herda_o_default(self):
        # Contraprova do "não herda": a guia vai ao sk 1 pela regra de IMPOSTO, que herda.
        ctrl = _Ctrl()
        payload = _boleto(document_type="gnre")
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual((payload["cost_center_id"], payload["chart_account_id"]), DEFAULT_SK1)


class _PipelineCtrl(_Ctrl):

    def __init__(self):
        super().__init__()
        self.financial_calls = []
        self.error_calls = []

    def upload_attachment(self, pdf_path):
        return True

    def register_financial(self, payload):
        self.financial_calls.append(dict(payload))
        return len(self.financial_calls)

    def register_attachment(self, account_id, file_name, size_bytes=0, uploaded_by=None):
        return True

    def resolve_user(self, sender_email):
        return None

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

    def unique_invoice_number(self, base):
        return base

    def find_financial_duplicate(self, payload):
        return None

    def update_supplier_classification(self, *args, **kwargs):
        return True

    def update_supplier_contact(self, *args, **kwargs):
        return True


class CallSiteAnexoTest(unittest.TestCase):

    def test_conta_933_executada_grava_no_sk1_sem_default(self):
        ctrl = _PipelineCtrl()
        row = {"source_file": "barbara_BOLETOS_SAMUEL_-_SHADOW_3_20260807_boletos_samuel_-_sha.pdf",
               "document_type": "boleto", "extraction_source": "pdf_text",
               "supplier_name": NOME_CURTO, "supplier_cnpj": "47.273.917/0001-23",
               "payer_name": "CONFECCOES SHADOW LTDA", "payer_cnpj": CNPJ_SHADOW,
               "invoice_number": "242406-C", "amount": "12364.34",
               "due_date": "2026-08-24", "issue_date": "2026-04-06", "barcode": ""}

        def fake_run_extraction(pdf_path, pdf_passwords=None):
            return (pdf_path.name, None)

        with patch.object(R, "run_extraction", fake_run_extraction), \
             patch.object(R, "read_extracted_rows", return_value=[row]), \
             patch.object(R, "_attachment_text", return_value=""):
            R.extract_and_store_accounts(
                [Path(row["source_file"])], "<MID-933>", ctrl,
                email_rec={"received_at": "2026-08-07T13:02:26+00:00",
                           "subject": "BOLETOS SAMUEL - SHADOW 3", "sender_email": "barbara@otimotex.com.br"},
                body_text="")

        self.assertEqual(len(ctrl.financial_calls), 1, ctrl.error_calls)
        conta = ctrl.financial_calls[0]
        self.assertEqual(conta["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [], "o apelido so seria alcancado pela RPC")
        self.assertNotEqual((conta.get("cost_center_id"), conta.get("chart_account_id")), DEFAULT_SK1)


if __name__ == "__main__":
    unittest.main()
