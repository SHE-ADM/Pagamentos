"""
Testes das regras de CLASSIFICACAO CONTABIL FORCADA por tipo de documento (na extracao
de e-mail): IRRF, DUIMP/ICMS Importacao e transporte forcam cost_center_id/chart_account_id
na conta; transporte e DUIMP/ICMS tambem gravam a classificacao no supplier (write-back),
exceto para a OTIMOTEX (sk_supplier=1). IRRF nunca faz write-back.

Ver "Classificacao contabil forcada" no CLAUDE.md.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402


class _FakeCtrl:
    """SupabaseControl minimo: registra os write-backs de classificacao do fornecedor e
    resolve o plano de contas 4.1.06 (usado pela regra DAM/DUAM)."""

    def __init__(self, chart_codes=None):
        self._available = True
        self.writeback_calls = []
        # codigo -> (cost_center_id, chart_account_id). 4.1.06 = ISS a Recolher (cc=3, id=42);
        # 4.1.02 = ICMS-ST a Recolher (cc=3, id=33).
        self._chart_codes = (chart_codes if chart_codes is not None
                             else {"4.1.06": (3, 42), "4.1.02": (3, 33)})

    def supplier_defaults(self, sk_supplier):
        return (0, 0)

    def update_supplier_classification(self, sk_supplier, cost_center_id, chart_account_id):
        self.writeback_calls.append((sk_supplier, cost_center_id, chart_account_id))
        return True

    def classification_for_account_code(self, account_code):
        return self._chart_codes.get(account_code, (0, 0))


class DetectForcedClassificationTest(unittest.TestCase):
    def test_irrf(self):
        # IRRF -> Fiscal / IRRF a Recolher; NAO propaga ao supplier (write_back=False).
        for txt in ("PAGAMENTO IRRF", "Enc: irrf retido", "DARF IRRF 1708"):
            self.assertEqual(
                R._detect_forced_classification("darf", txt),
                (R.CC_FISCAL, R.CA_IRRF, False), txt)

    def test_duimp(self):
        for txt in ("PAGAMENTO DUIMP", "duimp de importacao"):
            self.assertEqual(
                R._detect_forced_classification("outro", txt),
                (R.CC_FISCAL, R.CA_ICMS_IMPORT, True), txt)

    def test_icms_importacao_por_frase(self):
        for txt in ("ICMS Importação SP", "ICMS de importacao", "importacao icms guia"):
            self.assertEqual(
                R._detect_forced_classification("gnre", txt),
                (R.CC_FISCAL, R.CA_ICMS_IMPORT, True), txt)

    def test_icms_sozinho_nao_casa(self):
        # ICMS/GNRE normal NAO deve virar importacao — exige o par icms+importacao.
        self.assertIsNone(R._detect_forced_classification("gnre", "PAGAMENTO ICMS SP"))
        self.assertIsNone(R._detect_forced_classification("gare", "GARE ICMS mensal"))

    def test_transporte_por_document_type_cte(self):
        # Um boleto de transporte ja chega rotulado document_type='cte'.
        self.assertEqual(
            R._detect_forced_classification("cte", "PAGAMENTO BOLETO"),
            (R.CC_LOGISTICA, R.CA_TRANSPORTADORAS, True))

    def test_transporte_por_termo_no_texto(self):
        for txt in ("PAGAMENTO TRANSPORTADORA X", "frete conhecimento de transporte"):
            self.assertEqual(
                R._detect_forced_classification("boleto", txt),
                (R.CC_LOGISTICA, R.CA_TRANSPORTADORAS, True), txt)

    def test_precedencia_irrf_sobre_transporte(self):
        # IRRF tem precedencia (mais especifico) — caso raro de ambos no texto.
        self.assertEqual(
            R._detect_forced_classification("cte", "IRRF transporte"),
            (R.CC_FISCAL, R.CA_IRRF, False))

    def test_transporte_nao_casa_pela_descricao_ou_corpo(self):
        # "transporte"/"frete" solto na descricao/corpo NAO classifica como transporte —
        # so o ASSUNTO (+ document_type) conta (evita falso positivo). IRRF/DUIMP/ICMS,
        # por serem distintivos, continuam casando no corpo.
        self.assertIsNone(R._detect_forced_classification(
            "boleto", "PAGAMENTO FORNECEDOR XYZ",
            "taxa de transporte de valores", "frete incluso no servico"))

    def test_sem_regra_retorna_none(self):
        for dt, txt in (("boleto", "PAGAMENTO FORNECEDOR XYZ"), ("pix", "PIX JOAO"),
                        ("darf", "PAGAMENTO DARF SP"), (None, None)):
            self.assertIsNone(R._detect_forced_classification(dt, txt), txt)

    def test_palavra_inteira(self):
        # 'irrf'/'duimp' nao casam dentro de outra palavra.
        self.assertIsNone(R._detect_forced_classification("outro", "irrfando o teste"))
        self.assertIsNone(R._detect_forced_classification("outro", "duimpx"))

    def test_varios_textos(self):
        # A deteccao junta assunto + descricao + corpo (varargs).
        self.assertEqual(
            R._detect_forced_classification("outro", "Assunto qualquer", None, "corpo com IRRF retido"),
            (R.CC_FISCAL, R.CA_IRRF, False))


class ApplyForcedClassificationTest(unittest.TestCase):
    def test_irrf_forca_conta_sem_writeback(self):
        ctrl = _FakeCtrl()
        payload = {"document_type": "darf", "subject": "PAGAMENTO IRRF", "sk_supplier": 555}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], R.CC_FISCAL)
        self.assertEqual(payload["chart_account_id"], R.CA_IRRF)
        self.assertEqual(ctrl.writeback_calls, [])  # IRRF nunca propaga ao supplier

    def test_duimp_forca_conta_e_faz_writeback(self):
        ctrl = _FakeCtrl()
        payload = {"document_type": "outro", "subject": "DUIMP importacao", "sk_supplier": 555}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], R.CC_FISCAL)
        self.assertEqual(payload["chart_account_id"], R.CA_ICMS_IMPORT)
        self.assertEqual(ctrl.writeback_calls, [(555, R.CC_FISCAL, R.CA_ICMS_IMPORT)])

    def test_transporte_forca_conta_e_faz_writeback(self):
        ctrl = _FakeCtrl()
        payload = {"document_type": "cte", "subject": "PAGAMENTO BOLETO", "sk_supplier": 777}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], R.CC_LOGISTICA)
        self.assertEqual(payload["chart_account_id"], R.CA_TRANSPORTADORAS)
        self.assertEqual(ctrl.writeback_calls, [(777, R.CC_LOGISTICA, R.CA_TRANSPORTADORAS)])

    def test_writeback_nunca_para_otimotex(self):
        # Regra global: nao gravar no supplier quando sk_supplier=1 (OTIMOTEX).
        ctrl = _FakeCtrl()
        payload = {"document_type": "cte", "subject": "TRANSPORTADORA",
                   "sk_supplier": R.OTIMOTEX_SK_SUPPLIER}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], R.CC_LOGISTICA)
        self.assertEqual(payload["chart_account_id"], R.CA_TRANSPORTADORAS)
        self.assertEqual(ctrl.writeback_calls, [])  # sk=1 nunca faz write-back

    def test_sem_regra_nao_altera_nem_grava(self):
        ctrl = _FakeCtrl()
        payload = {"document_type": "boleto", "subject": "PAGAMENTO XYZ", "sk_supplier": 555}
        R.apply_forced_classification(ctrl, payload)
        self.assertNotIn("cost_center_id", payload)
        self.assertNotIn("chart_account_id", payload)
        self.assertEqual(ctrl.writeback_calls, [])

    def test_detecta_pela_descricao_do_documento(self):
        # Sem assunto, o texto do documento (description) dispara a regra.
        ctrl = _FakeCtrl()
        payload = {"document_type": "outro", "subject": None,
                   "description": "Recolhimento de IRRF sobre servicos", "sk_supplier": 555}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["chart_account_id"], R.CA_IRRF)
        self.assertEqual(ctrl.writeback_calls, [])


class BodyPathTest(unittest.TestCase):
    def test_corpo_irrf_classifica_sem_writeback(self):
        # No caminho de corpo, o body_text (extra_text) dispara a regra de IRRF (termo
        # distintivo). Transporte no corpo NAO conta — so o assunto/document_type — e um
        # transporte sem boleto no corpo ja e ignorado antes deste ponto.
        body = ("Fornecedor: ACME SERVICOS LTDA\n"
                "Retencao de IRRF sobre nota de servico\nValor R$ 100,00")
        payload = R.extract_from_email_body(
            body, "2026-07-01T10:00:00+00:00", "<msg-body-irrf>",
            "financeiro@acme.com", subject="PAGAMENTO")
        self.assertIsNotNone(payload)
        payload["sk_supplier"] = 888  # normalmente setado por _finalize_supplier
        ctrl = _FakeCtrl()
        R.apply_forced_classification(ctrl, payload, extra_text=body)
        self.assertEqual(payload["cost_center_id"], R.CC_FISCAL)
        self.assertEqual(payload["chart_account_id"], R.CA_IRRF)
        self.assertEqual(ctrl.writeback_calls, [])  # IRRF nunca faz write-back


class DamDuamTest(unittest.TestCase):
    def test_detect_puro_nao_trata_dam_duam(self):
        # A regra DAM/DUAM precisa do ctrl (resolve o plano 4.1.06) — o detector PURO nao a cobre.
        self.assertIsNone(R._detect_forced_classification("dam / duam", "PAGAMENTO DAMSP"))

    def test_resolve_dam_duam_pega_classificacao_do_codigo_4106(self):
        ctrl = _FakeCtrl({"4.1.06": (3, 42)})
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "dam / duam", "PAGAMENTO BOLETO DAMSP"),
            (3, 42, False))  # cc/ca vindos da linha 4.1.06; NAO propaga ao supplier

    def test_resolve_dam_duam_sem_4106_nao_forca(self):
        # 4.1.06 ausente no cadastro → nao forca (mantem o default do fornecedor).
        ctrl = _FakeCtrl({})
        self.assertIsNone(R.resolve_forced_classification(ctrl, "dam / duam", "DAMSP"))

    def test_apply_dam_duam_forca_conta_sem_writeback(self):
        ctrl = _FakeCtrl({"4.1.06": (3, 42)})
        payload = {"document_type": "dam / duam", "subject": "PAGAMENTO TFE", "sk_supplier": 1237}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], 3)
        self.assertEqual(payload["chart_account_id"], 42)
        self.assertEqual(ctrl.writeback_calls, [])  # DAM/DUAM nunca faz write-back

    def test_regras_fixas_tem_precedencia_sobre_dam_duam(self):
        # Se um dam/duam trouxer termo de IRRF no texto, a regra fixa vence (raro).
        ctrl = _FakeCtrl({"4.1.06": (3, 42)})
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "dam / duam", "IRRF retido"),
            (R.CC_FISCAL, R.CA_IRRF, False))


class GnreIcmsStTest(unittest.TestCase):
    def test_gnre_com_frase_st_pega_4102(self):
        ctrl = _FakeCtrl()
        for txt in ("GNRE ICMS Substituição Tributária",
                    "Tributo: 1538 - ICMS SUBST.TRIBUT.POR OPERACAO",
                    "GNRE ICMS ST", "guia icms-st"):
            self.assertEqual(
                R.resolve_forced_classification(ctrl, "gnre", txt),
                (3, 33, False), txt)  # 4.1.02 = ICMS-ST a Recolher; NAO propaga ao supplier

    def test_gnre_sem_frase_st_nao_forca(self):
        # GNRE so com codigo de receita/protocolo (sem a frase) NAO casa (decisao do usuario).
        ctrl = _FakeCtrl()
        for txt in ("ENC: GUIA GNRE .", "PROTOCOLO ICMS 32/2009 - Codigo da Receita: 100099",
                    "Chave DF-e: 3526..."):
            self.assertIsNone(R.resolve_forced_classification(ctrl, "gnre", txt), txt)

    def test_st_exige_document_type_gnre(self):
        # A frase de ST em um documento que NAO e gnre nao dispara a regra 4.1.02.
        ctrl = _FakeCtrl()
        self.assertIsNone(
            R.resolve_forced_classification(ctrl, "boleto", "ICMS Substituição Tributária"))

    def test_gnre_importacao_tem_precedencia_sobre_st(self):
        # GNRE de ICMS Importacao -> 3/11 (regra fixa, precedencia), nao 4.1.02.
        ctrl = _FakeCtrl()
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "gnre", "GNRE ICMS Importação"),
            (R.CC_FISCAL, R.CA_ICMS_IMPORT, True))

    def test_apply_gnre_st_forca_conta_sem_writeback(self):
        ctrl = _FakeCtrl()
        payload = {"document_type": "gnre", "subject": "GNRE -PAGAMENTO",
                   "description": "Tributo: 1538 - ICMS SUBST.TRIBUT.POR OPERACAO", "sk_supplier": 555}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], 3)
        self.assertEqual(payload["chart_account_id"], 33)
        self.assertEqual(ctrl.writeback_calls, [])  # GNRE-ST nunca faz write-back

    def test_gnre_de_remetente_lebianco_sem_frase_pega_4102(self):
        # Gatilho adicional: GNRE de @lebianco (setor que envia ST) vira 4.1.02 mesmo SEM
        # a frase de ST no texto. Vale para o dominio e subdominios.
        ctrl = _FakeCtrl()
        for email in ("rosangela@lebianco.com.br", "lidiane@lebianco.com.br",
                      "marcio@lebianco.com.br", "qualquer@fin.lebianco.com.br"):
            self.assertEqual(
                R.resolve_forced_classification(ctrl, "gnre", "ENC: GUIA GNRE .",
                                                sender_email=email),
                (3, 33, False), email)

    def test_gnre_de_outro_dominio_sem_frase_nao_forca(self):
        # Remetente fora de @lebianco e sem frase de ST -> nao forca (comportamento antigo).
        ctrl = _FakeCtrl()
        self.assertIsNone(
            R.resolve_forced_classification(ctrl, "gnre", "ENC: GUIA GNRE .",
                                            sender_email="financeiro@fornecedor.com"))

    def test_remetente_lebianco_so_vale_para_gnre(self):
        # O gatilho de remetente so aplica a GNRE — outro document_type nao dispara 4.1.02.
        ctrl = _FakeCtrl()
        self.assertIsNone(
            R.resolve_forced_classification(ctrl, "boleto", "PAGAMENTO XYZ",
                                            sender_email="rosangela@lebianco.com.br"))

    def test_gnre_importacao_de_lebianco_ainda_vai_para_importacao(self):
        # Precedencia preservada: GNRE @lebianco COM sinal de ICMS Importacao -> 3/11 (regra
        # fixa vence), nao 4.1.02.
        ctrl = _FakeCtrl()
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "gnre", "GNRE ICMS Importação",
                                            sender_email="marcio@lebianco.com.br"),
            (R.CC_FISCAL, R.CA_ICMS_IMPORT, True))

    def test_apply_gnre_lebianco_forca_conta_sem_writeback(self):
        ctrl = _FakeCtrl()
        payload = {"document_type": "gnre", "subject": "ENC: GUIA GNRE",
                   "sender_email": "rosangela@lebianco.com.br", "sk_supplier": 555}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], 3)
        self.assertEqual(payload["chart_account_id"], 33)
        self.assertEqual(ctrl.writeback_calls, [])  # GNRE-ST nunca faz write-back

    def test_gnre_sem_lebianco_com_frase_st_continua_casando(self):
        # Regressao: o gatilho de frase de ST continua valendo sem depender do remetente.
        ctrl = _FakeCtrl()
        self.assertEqual(
            R.resolve_forced_classification(ctrl, "gnre", "GNRE ICMS-ST",
                                            sender_email="terceiro@outro.com"),
            (3, 33, False))


class SupersedesSupplierDefaultTest(unittest.TestCase):
    """A regra por tipo de documento SOBREPOE a classificacao herdada do supplier
    (injetada por _finalize_supplier). Aqui o payload ja chega com o default do fornecedor
    e a regra forcada deve sobrescreve-lo."""

    def test_forcada_sobrepoe_default_do_fornecedor(self):
        ctrl = _FakeCtrl()
        # payload como se _finalize_supplier tivesse injetado o default do fornecedor (9/99).
        payload = {"document_type": "darf", "subject": "PAGAMENTO IRRF",
                   "sk_supplier": 555, "cost_center_id": 9, "chart_account_id": 99}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], R.CC_FISCAL)   # 9 -> 3
        self.assertEqual(payload["chart_account_id"], R.CA_IRRF)   # 99 -> 28

    def test_dam_duam_sobrepoe_default_do_fornecedor(self):
        ctrl = _FakeCtrl({"4.1.06": (3, 42)})
        payload = {"document_type": "dam / duam", "subject": "DAMSP",
                   "sk_supplier": 1237, "cost_center_id": 3, "chart_account_id": 37}
        R.apply_forced_classification(ctrl, payload)
        self.assertEqual(payload["cost_center_id"], 3)
        self.assertEqual(payload["chart_account_id"], 42)  # 37 -> 42 (do 4.1.06)


if __name__ == "__main__":
    unittest.main()
