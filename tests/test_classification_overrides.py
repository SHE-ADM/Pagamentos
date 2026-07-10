"""
Testes da CLASSIFICACAO CONTABIL AUTOMATICA de GUIAS TRIBUTARIAS (na extracao de e-mail).

ESTRITA e EXCLUSIVAMENTE para _is_tax_document: a guia e relacionada ao plano de contas
(financial_chart_of_account) pelo TIPO/CONTEXTO do imposto -> account_code -> (cost_center_id,
chart_account_id) via classification_for_account_code. Precedencia MAXIMA (vence o default do
fornecedor) e write-back True (o supplier e atualizado com o mesmo destino, exceto OTIMOTEX
sk=1 / funcionario). Transporte (CT-e/frete, NAO-tributario) segue -> Logistica/Transportadoras.

Ver "Classificacao contabil FORCADA por tipo de documento" no CLAUDE.md.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

# account_code -> (cost_center_id, chart_account_id) — espelha as linhas reais de
# financial_chart_of_account (todas cc=3 Fiscal, exceto onde indicado).
_REAL_CODES = {
    "4.3.05": (3, 11), "4.1.02": (3, 33), "4.2.03": (3, 28), "4.2.01": (3, 41),
    "4.2.02": (3, 27), "4.2.04": (3, 29), "4.2.05": (3, 30), "4.1.06": (3, 42),
    "4.1.03": (3, 44), "4.1.05": (3, 43), "4.1.04": (3, 13), "4.1.01": (3, 34),
    "6.4.02": (3, 9), "6.4.01": (3, 55), "4.3.01": (3, 31), "4.4.01": (3, 48),
    "4.4.02": (3, 49), "4.4.03": (3, 2), "4.4.04": (3, 12),
}


class _FakeCtrl:
    """SupabaseControl minimo: registra write-backs e resolve account_code -> (cc, ca)."""

    def __init__(self, chart_codes=None):
        self._available = True
        self.writeback_calls = []
        self._chart_codes = _REAL_CODES if chart_codes is None else chart_codes

    def update_supplier_classification(self, sk_supplier, cost_center_id, chart_account_id):
        self.writeback_calls.append((sk_supplier, cost_center_id, chart_account_id))
        return True

    def classification_for_account_code(self, account_code):
        return self._chart_codes.get(account_code, (0, 0))


def _code(document_type, subject, sender=None):
    """Atalho: normaliza o assunto (como resolve_forced_classification faz) e resolve o code."""
    return R._resolve_tax_chart_code(document_type, R._ns_body(subject), sender_email=sender)


class ResolveTaxChartCodeTest(unittest.TestCase):
    """Mapa TRIBUTARIO: tipo/contexto do imposto -> account_code do plano de contas."""

    def test_nivel1_frases_especificas(self):
        self.assertEqual(_code("gnre", "GNRE ICMS Importação"), "4.3.05")   # importacao
        self.assertEqual(_code("gnre", "GNRE ICMS Substituição Tributária"), "4.1.02")  # ST
        self.assertEqual(_code("darf", "recolhimento de PIS COFINS CSLL retidos"), "4.2.05")
        self.assertEqual(_code("darf", "guia de Imposto de Importação"), "4.3.01")

    def test_nivel1_palavra_chave_do_imposto(self):
        casos = {"DARF IRRF 1708": "4.2.03", "IRPJ trimestral": "4.2.01",
                 "CSLL a pagar": "4.2.02", "INSS retido servico": "4.2.04",
                 "PAGAMENTO ISS": "4.1.06", "guia IPI": "4.1.03",
                 "COFINS mensal": "4.1.05", "PIS mensal": "4.1.04",
                 "recolhimento ICMS proprio": "4.1.01"}
        for subj, code in casos.items():
            self.assertEqual(_code("darf", subj), code, subj)

    def test_nivel2_por_document_type(self):
        self.assertEqual(_code("gnre", "ENC: GUIA GNRE ."), "4.4.01")   # GNRE a Recolher
        self.assertEqual(_code("gare", "GARE ICMS mensal"), "4.1.01")   # GARE = ICMS
        self.assertEqual(_code("iss", "boleto"), "4.1.06")
        self.assertEqual(_code("ipva", "IPVA 2026"), "6.4.02")
        self.assertEqual(_code("iptu", "PAGAMENTO IPTU"), "6.4.01")
        self.assertEqual(_code("das", "Guia do SIMPLES NACIONAL"), "4.4.04")

    def test_nivel2_gnre_nao_e_rebaixada_a_icms_pela_palavra(self):
        # GNRE que cita "ICMS" no texto continua GNRE a Recolher (4.4.01), nao 4.1.01.
        self.assertEqual(_code("gnre", "PROTOCOLO ICMS 32/2009 GNRE"), "4.4.01")

    def test_nivel3_fallback_por_esfera(self):
        self.assertEqual(_code("darf", "PAGAMENTO IMPOSTOS"), "4.4.04")        # federal
        self.assertEqual(_code("gru", "GRU uniao"), "4.4.04")                  # federal
        self.assertEqual(_code("dare", "PAGAMENTO DARE - REF. T05S1"), "4.4.02")  # estadual
        self.assertEqual(_code("dam / duam", "PAGAMENTO BOLETO DAMSP"), "4.4.03")  # municipal
        self.assertEqual(_code("dam / duam", "PAGAMENTO TFE 06.2026"), "4.4.03")
        self.assertEqual(_code("itbi", "ITBI compra imovel"), "4.4.03")        # municipal

    def test_lebianco_sem_frase_st_vira_4102(self):
        self.assertEqual(_code("gnre", "ENC: GUIA GNRE", "rosangela@lebianco.com.br"), "4.1.02")
        self.assertEqual(_code("gnre", "GNRE", "qualquer@fin.lebianco.com.br"), "4.1.02")

    def test_lebianco_so_vale_para_gnre(self):
        # De outro dominio e sem frase -> GNRE a Recolher (nao ST).
        self.assertEqual(_code("gnre", "ENC: GUIA GNRE", "x@fornecedor.com"), "4.4.01")

    def test_tributo_sem_esfera_nao_forca(self):
        self.assertIsNone(_code("tributo", "BOLETO DE TUDO UTILIDADES"))

    def test_palavra_inteira_sem_falso_positivo(self):
        # 'iss'/'pis' nao casam dentro de outra palavra (emissao/lapis) — mas como o gate
        # e _is_tax_document, testamos o resolvedor puro: sem termo, cai na esfera do darf.
        self.assertEqual(_code("darf", "emissao de guia federal"), "4.4.04")


class ResolveForcedClassificationTest(unittest.TestCase):
    """resolve_forced_classification: (cc, ca, write_back) — tributario com write_back=True."""

    def test_tributario_resolve_cc_ca_com_writeback(self):
        ctrl = _FakeCtrl()
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "darf", "PAGAMENTO IRRF"),
            (3, 28, True))   # 4.2.03 IRRF a Recolher

    def test_tributario_gnre_st_lebianco(self):
        ctrl = _FakeCtrl()
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "gnre", "ENC: GUIA GNRE",
                                            sender_email="marcio@lebianco.com.br"),
            (3, 33, True))   # 4.1.02 ICMS-ST

    def test_tributario_das_generico_federal(self):
        ctrl = _FakeCtrl()
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "das", "Simples Nacional guia"),
            (3, 12, True))   # 4.4.04 Taxas Federais

    def test_dam_duam_municipal(self):
        ctrl = _FakeCtrl()
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "dam / duam", "PAGAMENTO TFE"),
            (3, 2, True))    # 4.4.03 Taxas Municipais

    def test_codigo_ausente_no_cadastro_nao_forca(self):
        # Se o plano nao tem a linha (cc/ca = 0/0), nao forca (mantem default).
        ctrl = _FakeCtrl({})
        self.assertIsNone(R.resolve_forced_classification(ctrl, "iss", "PAGAMENTO ISS"))

    def test_gate_documento_nao_tributario_nao_e_tocado(self):
        # 'boleto' com "ICMS" no texto NAO e classificado pela regra tributaria (gate estrito).
        ctrl = _FakeCtrl()
        self.assertIsNone(
            R.resolve_forced_classification(ctrl, "boleto", "GUIA ICMS Substituição Tributária"))

    def test_transporte_nao_tributario_preservado(self):
        ctrl = _FakeCtrl()
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "cte", "PAGAMENTO BOLETO"),
            (R.CC_LOGISTICA, R.CA_TRANSPORTADORAS, True))
        for txt in ("PAGAMENTO TRANSPORTADORA X", "frete conhecimento de transporte"):
            self.assertEqual(
                R.resolve_forced_classification(ctrl, "boleto", txt),
                (R.CC_LOGISTICA, R.CA_TRANSPORTADORAS, True), txt)

    def test_transporte_nao_casa_pela_descricao_ou_corpo(self):
        ctrl = _FakeCtrl()
        self.assertIsNone(R.resolve_forced_classification(
            ctrl, "boleto", "PAGAMENTO FORNECEDOR XYZ",
            "taxa de transporte de valores", "frete incluso"))


class ApplyForcedClassificationTest(unittest.TestCase):
    def test_tributario_forca_conta_e_faz_writeback(self):
        ctrl = _FakeCtrl()
        payload = {"document_type": "darf", "subject": "PAGAMENTO IRRF", "sk_supplier": 555}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], 3)
        self.assertEqual(payload["chart_account_id"], 28)   # IRRF a Recolher
        self.assertEqual(ctrl.writeback_calls, [(555, 3, 28)])   # write-back p/ fornecedor real

    def test_writeback_nunca_para_otimotex(self):
        ctrl = _FakeCtrl()
        payload = {"document_type": "gnre", "subject": "GUIA GNRE",
                   "sk_supplier": R.OTIMOTEX_SK_SUPPLIER}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], 3)
        self.assertEqual(payload["chart_account_id"], 48)   # GNRE a Recolher
        self.assertEqual(ctrl.writeback_calls, [])          # sk=1 nunca faz write-back

    def test_sobrepoe_default_do_fornecedor(self):
        # A regra tributaria VENCE o default injetado por _finalize_supplier (9/99).
        ctrl = _FakeCtrl()
        payload = {"document_type": "iss", "subject": "PAGAMENTO ISS",
                   "sk_supplier": 555, "cost_center_id": 9, "chart_account_id": 99}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], 3)
        self.assertEqual(payload["chart_account_id"], 42)   # 99 -> 42 (ISS a Recolher)

    def test_transporte_forca_conta_e_faz_writeback(self):
        ctrl = _FakeCtrl()
        payload = {"document_type": "cte", "subject": "PAGAMENTO BOLETO", "sk_supplier": 777}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], R.CC_LOGISTICA)
        self.assertEqual(payload["chart_account_id"], R.CA_TRANSPORTADORAS)
        self.assertEqual(ctrl.writeback_calls, [(777, R.CC_LOGISTICA, R.CA_TRANSPORTADORAS)])

    def test_sem_regra_nao_altera_nem_grava(self):
        ctrl = _FakeCtrl()
        payload = {"document_type": "boleto", "subject": "PAGAMENTO XYZ", "sk_supplier": 555}
        R.apply_forced_classification(ctrl, payload)
        self.assertNotIn("cost_center_id", payload)
        self.assertNotIn("chart_account_id", payload)
        self.assertEqual(ctrl.writeback_calls, [])

    def test_detecta_pela_descricao_do_documento(self):
        # Sem assunto util, o texto do documento (description) dispara — doc tributario.
        ctrl = _FakeCtrl()
        payload = {"document_type": "darf", "subject": None,
                   "description": "Recolhimento de IRRF sobre servicos", "sk_supplier": 555}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["chart_account_id"], 28)   # IRRF a Recolher
        self.assertEqual(ctrl.writeback_calls, [(555, 3, 28)])


class ExcludedSupplierTest(unittest.TestCase):
    """Fornecedor em TAX_CLASSIFICATION_EXCLUDED_SK_SUPPLIERS (ex.: Dr. Ricardo sk 1262 —
    despachante, contas de reembolso/honorarios/juridico) NUNCA recebe classificacao
    tributaria forcada: a regra e pulada e a conta mantem o default do fornecedor."""

    def test_excluido_nao_resolve_tributo(self):
        ctrl = _FakeCtrl()
        # Mesma guia (das) que para outro fornecedor daria 4.4.04 -> aqui e None.
        self.assertIsNone(R.resolve_forced_classification(
            ctrl, "das", "Guia do SIMPLES NACIONAL", sk_supplier=1262))
        self.assertEqual(R.resolve_forced_classification(
            ctrl, "das", "Guia do SIMPLES NACIONAL", sk_supplier=555), (3, 12, True))

    def test_apply_excluido_nao_altera_nem_grava(self):
        ctrl = _FakeCtrl()
        # Payload chega com o default do fornecedor (Juridico/Reembolsos 14/530) — preservado.
        payload = {"document_type": "tributo", "subject": "BOLETO X - JUNTA COMERCIAL",
                   "sk_supplier": 1262, "cost_center_id": 14, "chart_account_id": 530}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], 14)     # default preservado
        self.assertEqual(payload["chart_account_id"], 530)
        self.assertEqual(ctrl.writeback_calls, [])          # nunca faz write-back tributario

    def test_excluido_ainda_permite_transporte(self):
        # A exclusao e SO da regra tributaria; transporte (nao-tributario) segue valendo.
        ctrl = _FakeCtrl()
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "cte", "PAGAMENTO BOLETO", sk_supplier=1262),
            (R.CC_LOGISTICA, R.CA_TRANSPORTADORAS, True))


if __name__ == "__main__":
    unittest.main()
