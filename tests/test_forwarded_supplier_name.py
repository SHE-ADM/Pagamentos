"""
Testes do fallback de FORNECEDOR pelo REMETENTE ORIGINAL de um bloco encaminhado
(read_emails.py) e do numero de fatura no formato "Fatura No: NNNN".

Contexto (caso real conta 669, 2026-07-23): um e-mail interno encaminha um
lembrete periodico de fatura da Contabil Esquema (mesmo remetente da conta 668,
corrigida horas antes) SEM nenhum rotulo explicito "Fornecedor:"/"Favorecido:"
no corpo — apenas as linhas "De:"/"Assunto:" da cadeia encaminhada. O assunto
visivel tambem foi reescrito para algo generico ("boleto esquema"), que nao
contem o nome completo do fornecedor. Sem sinal no corpo nem no assunto, a
extracao caia no ULTIMO recurso (_supplier_name_from_subject sobre o assunto
truncado) e criava um fornecedor fragmentado ("esquema"), alem de nao capturar
o numero da fatura ("Fatura No: 20880", formato que _BODY_INVOICE_RE nao cobre).

Cobre:
  - _supplier_from_forwarded_sender: extrai o nome do remetente ORIGINAL (a
    linha "De:" mais profunda da cadeia) quando ancorado em sigla de razao
    social (LTDA/EIRELI/S.A....); ignora "De:" de dominio interno e de pessoa
    fisica (sem sigla).
  - _BODY_INVOICE_NO_RE: casa "Fatura No: NNNN" sem confundir com
    "fatura no valor de/total de".
  - extract_from_email_body: end-to-end com um corpo reconstruido no mesmo
    formato real (sem rotulo "Fornecedor:"), resolvendo o nome e o numero
    corretos em vez de cair nos fallbacks fragmentados.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Corpo reconstruido no mesmo formato real da conta 669: encaminhamento interno
# (Eunice) de um lembrete original da Contabil Esquema para Nelson, SEM nenhum
# rotulo "Fornecedor:"/"Favorecido:" explicito — apenas os cabecalhos "De:" da
# cadeia. O assunto (nao incluso aqui) foi reescrito para "boleto esquema".
BODY_669 = (
    "De: Eunice <eunice@otimotex.com.br>\r\n"
    "Enviada em: terca-feira, 21 de julho de 2026 17:41\r\n"
    "Para: financeiro@otimotex.com.br\r\n"
    "Assunto: pagamento Sua Fatura\r\n"
    "\r\n"
    "De: Contabil Esquema LTDA <lembrete@contabilesquema.com.br\r\n"
    "<mailto:lembrete@contabilesquema.com.br> >\r\n"
    "Enviada em: terca-feira, 21 de julho de 2026 09:46\r\n"
    "Para: nelson@otimotex.com.br <mailto:nelson@otimotex.com.br>\r\n"
    "Assunto: Lembrete Sua Fatura\r\n"
    "\r\n"
    "Lembrete - Sua Fatura\r\n"
    "Para:TEXTIL E CONFECCOES OTIMOTEX LTDA\r\n"
    "Documento: 47.273.917/0001-23\r\n"
    "No. Fatura Vencimento Valor Descricao\r\n"
    "20880 24/07/2026 22.655,00\r\n"
    "Fatura de Servicos Fatura No: 20880 Venc.: 24/07/2026 Valor: 22.655,00\r\n"
)


class SupplierFromForwardedSenderTest(unittest.TestCase):
    def test_extrai_remetente_original_ancorado_em_ltda(self):
        self.assertEqual(
            read_emails._supplier_from_forwarded_sender(BODY_669),
            "Contabil Esquema LTDA",
        )

    def test_ignora_de_interno_sem_sigla(self):
        body = "De: Eunice <eunice@otimotex.com.br>\r\nAssunto: pagamento\r\n\r\ntexto\r\n"
        self.assertIsNone(read_emails._supplier_from_forwarded_sender(body))

    def test_ignora_de_interno_mesmo_citando_ltda_no_dominio_bloqueado(self):
        body = (
            "De: Textil e Confeccoes Otimotex LTDA <financeiro@otimotex.com.br>\r\n"
            "Assunto: pagamento\r\n\r\ntexto\r\n"
        )
        self.assertIsNone(read_emails._supplier_from_forwarded_sender(body))

    def test_corpo_vazio_ou_sem_de(self):
        self.assertIsNone(read_emails._supplier_from_forwarded_sender(None))
        self.assertIsNone(read_emails._supplier_from_forwarded_sender("corpo sem cabecalho"))

    def test_usa_a_ocorrencia_mais_profunda_quando_ha_varias_validas(self):
        # A cadeia pode ter mais de um "De:" com sigla; o remetente ORIGINAL e o
        # mais profundo (ultima ocorrencia no texto).
        body = (
            "De: Intermediaria Repasses LTDA <contato@intermediaria.com.br>\r\n"
            "Assunto: RES: Lembrete Sua Fatura\r\n\r\n"
            "De: Contabil Esquema LTDA <lembrete@contabilesquema.com.br>\r\n"
            "Assunto: Lembrete Sua Fatura\r\n\r\ntexto\r\n"
        )
        self.assertEqual(
            read_emails._supplier_from_forwarded_sender(body),
            "Contabil Esquema LTDA",
        )


class BodyInvoiceNoRegexTest(unittest.TestCase):
    def test_casa_fatura_no_dois_pontos(self):
        m = read_emails._BODY_INVOICE_NO_RE.search("Fatura de Servicos Fatura No: 20880 Venc.: 24/07/2026")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "20880")

    def test_nao_casa_fatura_no_valor_de(self):
        self.assertIsNone(read_emails._BODY_INVOICE_NO_RE.search("fatura no valor de 100,00"))

    def test_nao_casa_fatura_no_total_de(self):
        self.assertIsNone(read_emails._BODY_INVOICE_NO_RE.search("fatura no total de R$: 100,00"))


class ExtractFromEmailBodyForwardedSupplierTest(unittest.TestCase):
    def test_resolve_numero_da_fatura_do_corpo(self):
        payload = read_emails.extract_from_email_body(
            BODY_669,
            "2026-07-21T17:41:00+00:00",
            "<msg-669>",
            sender_email="financeiro@otimotex.com.br",
            subject="boleto esquema",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["invoice_number"], "20880")

    def test_nao_captura_de_do_corpo_quando_nao_ha_cnpj_cpf_no_corpo(self):
        # Regressao (achada em code review): _supplier_from_forwarded_sender NAO deve
        # rodar dentro de extract_from_email_body — essa e uma fonte UNICA em
        # _finalize_supplier, que so a testa apos o assunto ancorado em sigla esgotar.
        # Se esta funcao capturasse o "De:" do corpo por conta propria, o payload
        # chegaria em _finalize_supplier com supplier_name JA preenchido
        # (has_real_supplier=True), pulando o fallback do assunto e travando o nome
        # do TERCEIRO da cadeia (nao o fornecedor real, nomeado no assunto).
        body = (
            "De: Intermediaria Repasses LTDA <contato@intermediaria.com.br>\r\n"
            "Assunto: RES: Fatura\r\n\r\n"
            "Valor: R$ 500,00\r\n"
        )
        payload = read_emails.extract_from_email_body(
            body,
            "2026-07-21T17:41:00+00:00",
            "<msg-intermediaria>",
            sender_email="compras@outraempresa.com.br",
            subject="FATURAMENTO -- MOVVI LOGISTICA LTDA 03/07/2026",
        )
        self.assertIsNotNone(payload)
        self.assertIsNone(payload.get("supplier_name"))

    def test_body_traz_o_cnpj_do_proprio_pagador_nao_o_fornecedor(self):
        # O corpo cita "Documento: 47.273.917/0001-23" no bloco do DESTINATARIO
        # (TEXTIL E CONFECCOES OTIMOTEX LTDA), nao do fornecedor — extract_from_email_body
        # captura esse CNPJ genericamente (nao sabe de quem e) e deixa supplier_name
        # vazio (sem rotulo explicito no corpo). E' _finalize_supplier quem descarta
        # esse CNPJ (mesma raiz da propria empresa pagadora) e resolve o fornecedor
        # pelo remetente original encaminhado — ver FinalizeSupplierForwardedTest.
        payload = read_emails.extract_from_email_body(
            BODY_669,
            "2026-07-21T17:41:00+00:00",
            "<msg-669>",
            sender_email="financeiro@otimotex.com.br",
            subject="boleto esquema",
        )
        self.assertIsNone(payload.get("supplier_name"))
        self.assertEqual(payload.get("supplier_cnpj"), "47273917000123")


class _FakeCtrlFinalize:
    """ctrl minimo para _finalize_supplier — sem rede."""

    def __init__(self, sk_supplier=1052, cost_center_id=9, chart_account_id=61):
        self._sk_supplier = sk_supplier
        self._defaults = (cost_center_id, chart_account_id)
        self.resolve_calls = []

    def company_cnpj(self):
        return "47273917000123"  # OTIMOTEX (mesma raiz das filiais)

    def resolve_supplier(self, payload):
        self.resolve_calls.append(dict(payload))
        return self._sk_supplier

    def supplier_defaults(self, sk_supplier):
        return self._defaults


class FinalizeSupplierForwardedTest(unittest.TestCase):
    def test_resolve_fornecedor_pelo_remetente_encaminhado_quando_cnpj_e_do_proprio_pagador(self):
        payload = read_emails.extract_from_email_body(
            BODY_669,
            "2026-07-21T17:41:00+00:00",
            "<msg-669>",
            sender_email="financeiro@otimotex.com.br",
            subject="boleto esquema",
        )
        ctrl = _FakeCtrlFinalize()
        ok = read_emails._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        self.assertEqual(len(ctrl.resolve_calls), 1)
        # o CNPJ do proprio pagador foi descartado; o nome veio do remetente encaminhado.
        self.assertEqual(ctrl.resolve_calls[0].get("supplier_name"), "Contabil Esquema LTDA")
        self.assertIsNone(ctrl.resolve_calls[0].get("supplier_cnpj"))
        self.assertEqual(payload["sk_supplier"], 1052)
        self.assertEqual(payload["cost_center_id"], 9)
        self.assertEqual(payload["chart_account_id"], 61)
        # colunas denormalizadas nunca sobrevivem no payload final.
        self.assertNotIn("supplier_name", payload)
        self.assertNotIn("supplier_cnpj", payload)

    def test_assunto_ancorado_em_sigla_vence_o_de_do_corpo(self):
        # Regressao (achada em code review): o assunto ja e um sinal CONFIAVEL quando
        # ancora numa sigla de razao social (caso real id 401, "FATURAMENTO -- MOVVI
        # LOGISTICA LTDA") — nao pode ser hijackado por uma linha "De:" de OUTRO
        # correspondente (ex.: intermediario/repassador) que porventura aparece mais
        # fundo no corpo. O fallback do corpo so deve entrar em jogo quando o assunto
        # NAO trouxer uma sigla propria (caso 669).
        payload = {
            "subject": "ENC: FATURAMENTO -- MOVVI LOGISTICA LTDA 03/07/2026",
            "email_body_excerpt": (
                "De: Intermediaria Repasses LTDA <contato@intermediaria.com.br>\r\n"
                "Assunto: RES: Fatura\r\n\r\ntexto\r\n"
            ),
            "document_type": "boleto",
        }
        ctrl = _FakeCtrlFinalize()
        ok = read_emails._finalize_supplier(ctrl, payload)
        self.assertTrue(ok)
        self.assertEqual(ctrl.resolve_calls[0].get("supplier_name"), "MOVVI LOGISTICA LTDA")


if __name__ == "__main__":
    unittest.main()
