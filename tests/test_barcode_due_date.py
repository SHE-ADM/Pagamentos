"""
Vencimento AUTORITATIVO pelo FATOR DE VENCIMENTO do código de barras FEBRABAN.

Falha grave de origem (id 435): boleto OBER cujo Vision INVERTEU dia/mês do vencimento —
gravou 2026-08-07 (07/08) no lugar de 2026-07-08 (08/07). O fator de vencimento do código de
barras é DETERMINÍSTICO (o emissor o codifica) e não sofre inversão, então é a fonte de verdade.
`due_date_from_barcode` decodifica o fator (tratando o reset FEBRABAN de 22/02/2025) e
`apply_barcode_due_date` sobrescreve a data extraída se divergir.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import extract_pdf as e  # noqa: E402

# Barcode real da conta 435 (Itaú 341, fator 1501, valor 795,00) → vencimento 08/07/2026.
BC_435 = "34191150100000795001097308595621248093807000"
REF_435 = "2026-05-09"  # emissão (referência p/ desambiguar o reset da base FEBRABAN)

# Barcode CORROMPIDO pelo OCR (id 463 CIPATEX, boleto escaneado): valor embutido R$ 2.026.142,93
# e fator 1259 (→ 2025-11-08), mas o valor REAL da conta é R$ 32.400,00. O Vision leu a data
# impressa CERTA (2026-07-10); a regra do fator NÃO pode sobrescrever com um barcode mal lido.
BC_463_CORROMPIDO = "34191125902026142931864598900021503000324000"
AMT_463 = 32400.00
REF_463 = "2026-06-16"  # emissão


class DueDateFromBarcodeTest(unittest.TestCase):
    def test_fator_1501_da_08_07_2026(self):
        self.assertEqual(e.due_date_from_barcode(BC_435, REF_435), "2026-07-08")

    def test_desambiguacao_sem_ref_usa_hoje(self):
        # Com ref em 2026, a base NOVA (2026-07-08) vence a antiga (2001-11-16).
        self.assertEqual(e.due_date_from_barcode(BC_435, "2026-01-01"), "2026-07-08")

    def test_fator_zero_e_none(self):
        # fator 0000 = boleto à vista / sem vencimento.
        bc = "3419" + "0000" + "0000079500" + "1" * 25 + "0"  # 44 díg, moeda 9, fator 0000
        bc = bc[:44]
        self.assertIsNone(e.due_date_from_barcode(bc, REF_435))

    def test_nao_boleto_e_none(self):
        self.assertIsNone(e.due_date_from_barcode(None))
        self.assertIsNone(e.due_date_from_barcode(""))
        self.assertIsNone(e.due_date_from_barcode("12345"))                 # curto
        self.assertIsNone(e.due_date_from_barcode("3" * 44))                # moeda != 9
        self.assertIsNone(e.due_date_from_barcode("0" * 44))                # banco 000
        self.assertIsNone(e.due_date_from_barcode("1" * 48))               # arrecadação (48)


# Carnê HYOSUNG (id 473/474): boleto securitizado cuja linha digitável vem QUEBRADA por "ITAU
# 341-7" e cujo FATOR (1051 → 2025-04-14) é STALE — o vencimento IMPRESSO (21/07/2026) é a verdade.
HYOSUNG_TEXT = (
    "Data do Documento N do Documento Esp. Doc Aceite Data Movto (=)Valor Documento\n"
    "26/05/2026 182110/1 R$ N 26/05/2026 3.560,08\n"
    "34191.09099 11249.463834 38053.630000 1\n"
    "ITAU 341-7\n"
    "10510000356008\n"
    "Local de Pagamento Vencimento\n"
    "PAGÁVEL PREFERENCIALMENTE NO BANCO BANCO ITAU SA, APOS O\n"
    "21/07/2026\n"
)
HYOSUNG_BARCODE = "34191105100003560081090911249463833805363000"  # fator 1051, valor 3560,08


class ExtractLinhaDigitavelSplitTest(unittest.TestCase):
    """Linha digitável QUEBRADA em linhas (ruído 'ITAU 341-7' no meio) — carnê HYOSUNG."""

    def test_linha_digitavel_quebrada(self):
        ld = e.extract_linha_digitavel(HYOSUNG_TEXT)
        self.assertIsNotNone(ld)
        self.assertEqual(len(ld), 47)
        self.assertEqual(e.normalize_barcode(ld), HYOSUNG_BARCODE)


class ExtractDueDateFromTextTest(unittest.TestCase):
    def test_pega_vencimento_impresso_nao_data_documento(self):
        # Deve pegar 21/07/2026 (Vencimento), não 26/05/2026 (Data do Documento).
        self.assertEqual(e.extract_due_date_from_text(HYOSUNG_TEXT), "2026-07-21")

    def test_sem_vencimento_e_none(self):
        self.assertIsNone(e.extract_due_date_from_text("texto sem data de vencimento"))


class DueDatePlausibleTest(unittest.TestCase):
    def test_venc_apos_emissao_e_plausivel(self):
        self.assertTrue(e._due_date_plausible("2026-07-21", "2026-05-26"))

    def test_venc_antes_da_emissao_nao_e_plausivel(self):
        self.assertFalse(e._due_date_plausible("2025-04-14", "2026-05-26"))

    def test_sem_emissao_aceita(self):
        self.assertTrue(e._due_date_plausible("2026-07-21", None))


class AuthoritativeBarcodeDueDateTest(unittest.TestCase):
    """O fator só é autoritativo quando o barcode é CONSISTENTE (valor) e PLAUSÍVEL (>= emissão)."""

    def test_barcode_consistente_devolve_vencimento(self):
        # BC_435: valor embutido 795,00 == amount 795,00 → confia no fator.
        self.assertEqual(
            e.authoritative_barcode_due_date(BC_435, 795.00, REF_435, issue_date=REF_435),
            "2026-07-08")

    def test_barcode_corrompido_valor_divergente_e_none(self):
        # id 463: valor embutido R$ 2mi != amount R$ 32.400 → NÃO confia (barcode mal lido).
        self.assertIsNone(
            e.authoritative_barcode_due_date(BC_463_CORROMPIDO, AMT_463, REF_463))

    def test_fator_stale_anterior_a_emissao_e_none(self):
        # id 473/474: barcode CONSISTENTE (valor bate) mas fator 1051 → 2025-04-14 < emissão
        # 2026-05-26 (impossível) → guard de plausibilidade rejeita.
        self.assertIsNone(e.authoritative_barcode_due_date(
            HYOSUNG_BARCODE, 3560.08, "2026-05-26", issue_date="2026-05-26"))

    def test_sem_amount_nao_confia(self):
        # Sem amount não há como cross-validar o barcode → None (conservador).
        self.assertIsNone(e.authoritative_barcode_due_date(BC_435, None, REF_435))

    def test_amount_dentro_da_tolerancia_de_1_centavo(self):
        self.assertEqual(
            e.authoritative_barcode_due_date(BC_435, 795.009, REF_435, issue_date=REF_435),
            "2026-07-08")


class ApplyBarcodeDueDateTest(unittest.TestCase):
    def _rec(self, **over):
        # amount = valor embutido no BC_435 (795,00) — passa o gate de consistência.
        base = {"barcode": BC_435, "amount": 795.00, "issue_date": REF_435,
                "due_date": None, "processing_notes": None}
        base.update(over)
        return base

    def test_barcode_corrompido_nao_sobrescreve_data_correta(self):
        # id 463: Vision leu a data impressa CERTA (2026-07-10); o barcode corrompido
        # (fator 1259 → 2025-11-08, valor R$ 2mi) NÃO pode sobrescrevê-la.
        rec = {"barcode": BC_463_CORROMPIDO, "amount": AMT_463, "issue_date": REF_463,
               "due_date": "2026-07-10", "processing_notes": None}
        self.assertFalse(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-07-10")  # preservada
        self.assertIsNone(rec["processing_notes"])

    def test_corrige_data_invertida(self):
        rec = self._rec(due_date="2026-08-07")  # inversão dia/mês (o bug)
        self.assertTrue(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-07-08")
        self.assertIn("código de barras", rec["processing_notes"])

    def test_define_quando_ausente(self):
        rec = self._rec(due_date=None)
        self.assertTrue(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-07-08")

    def test_data_correta_nao_muda(self):
        rec = self._rec(due_date="2026-07-08")
        self.assertFalse(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-07-08")
        self.assertIsNone(rec["processing_notes"])

    def test_sem_barcode_nao_muda(self):
        rec = self._rec(barcode=None, due_date="2026-08-07")
        self.assertFalse(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-08-07")

    def test_barcode_nao_boleto_nao_muda(self):
        rec = self._rec(barcode="3" * 44, due_date="2026-08-07")  # chave NF-e (moeda != 9)
        self.assertFalse(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], "2026-08-07")


# ── Boleto PRORROGADO: o fator NÃO acompanha a data reimpressa ────────────────────────────
# Conta 1613 (RAINHA MARIA, NF17241-10, 22/09/2026). O PDF imprime "Data de Vencimento
# 05/10/2026" nas DUAS vias e "JRS ... A PARTIR DE 06/10/26" — o beneficiário PRORROGOU o
# título —, mas a linha digitável manteve o fator ORIGINAL 1576 (21/09/2026). Tratar o fator
# como autoritativo gravava a data velha e a conta nascia VENCIDA. Mesmo caso da conta 1029,
# que o usuário corrigiu à mão em 14/08/2026.
BC_1613 = "00198157600025092000000003580329000000432917"
AMT_1613 = 25092.00
ISS_1613 = "2026-09-17"      # Data do Documento
IMPRESSO_1613 = "2026-10-05"  # o que está no papel
FATOR_1613 = "2026-09-21"     # o que o código de barras codifica


class BarcodeDueDateSupersedesTest(unittest.TestCase):
    """A política pura: QUANDO o fator vence a data lida do documento."""

    def test_data_ausente_o_fator_e_a_unica_fonte(self):
        self.assertTrue(e.barcode_due_date_supersedes(None, FATOR_1613))
        self.assertTrue(e.barcode_due_date_supersedes("", FATOR_1613))
        self.assertTrue(e.barcode_due_date_supersedes("prosa", FATOR_1613))

    def test_inversao_dia_mes_ainda_e_corrigida_pelo_fator(self):
        # id 435: lido 07/08, fator 08/07 — a falha que deu ao fator a autoridade.
        self.assertTrue(e.barcode_due_date_supersedes("2026-08-07", "2026-07-08"))

    def test_data_anterior_a_emissao_perde(self):
        self.assertTrue(e.barcode_due_date_supersedes(
            "2026-09-10", FATOR_1613, issue_date=ISS_1613))

    def test_data_anterior_ao_fator_perde(self):
        # Leitura de campo VIZINHO ('Data do Documento'/'Data Processamento'): prorrogação
        # nunca anda para trás.
        self.assertTrue(e.barcode_due_date_supersedes("2026-09-18", FATOR_1613,
                                                      issue_date=ISS_1613))

    def test_prorrogacao_plausivel_vence_o_fator(self):
        self.assertFalse(e.barcode_due_date_supersedes(
            IMPRESSO_1613, FATOR_1613, issue_date=ISS_1613))

    def test_prorrogacao_alem_do_teto_perde(self):
        # Dígito de ANO trocado ('2126') — a conta nasceria com vencimento que nunca chega.
        self.assertTrue(e.barcode_due_date_supersedes("2027-09-21", FATOR_1613,
                                                      issue_date=ISS_1613))
        # Limite exato: 60 dias ainda passa; 61 não. O teto é 4x o extremo medido (14 dias) —
        # acima dele, um dígito de MÊS trocado seria acolhido como "prorrogação".
        self.assertFalse(e.barcode_due_date_supersedes("2026-11-20", FATOR_1613))
        self.assertTrue(e.barcode_due_date_supersedes("2026-11-21", FATOR_1613))

    def test_erro_de_mes_na_leitura_nao_vira_prorrogacao(self):
        # 21/09 lido como 21/12 (dígito de mês): 91 dias à frente ⇒ o fator determinístico
        # volta a mandar. Era o buraco do teto de 180 dias.
        self.assertTrue(e.barcode_due_date_supersedes("2026-12-21", FATOR_1613,
                                                      issue_date=ISS_1613))

    def test_sem_fator_nao_ha_o_que_sobrepor(self):
        self.assertFalse(e.barcode_due_date_supersedes(IMPRESSO_1613, None))
        self.assertFalse(e.barcode_due_date_supersedes(None, None))

    def test_dia_igual_ao_mes_nao_e_inversao(self):
        # 07/07 x 07/07 não pode ser lido como "invertido" (anti-vacuidade do _day_month_swapped).
        self.assertFalse(e.barcode_due_date_supersedes("2026-07-07", "2026-07-07"))


class BoletoProrrogadoTest(unittest.TestCase):
    """O caso 1613 ponta a ponta no extrator, e a nota que o torna auditável."""

    def _rec(self, due):
        return {"barcode": BC_1613, "amount": AMT_1613, "issue_date": ISS_1613,
                "due_date": due, "processing_notes": None}

    def test_data_impressa_posterior_e_preservada_com_ressalva(self):
        rec = self._rec(IMPRESSO_1613)
        self.assertFalse(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], IMPRESSO_1613)       # o papel vence
        self.assertIn("Vencimento gravado", rec["processing_notes"])
        self.assertIn(FATOR_1613, rec["processing_notes"])     # a divergência fica registrada

    def test_nota_nao_duplica_em_duas_passagens(self):
        # O caminho de TEXTO chama apply_barcode_due_date DUAS vezes sobre o mesmo registro
        # (builder + pós-processamento) — a conta 1613 gravou a mesma frase duas vezes.
        rec = self._rec(IMPRESSO_1613)
        e.apply_barcode_due_date(rec)
        e.apply_barcode_due_date(rec)
        self.assertEqual(rec["processing_notes"].count("Vencimento gravado"), 1)

    def test_data_lida_mais_antiga_ainda_cede_ao_fator(self):
        rec = self._rec("2026-09-18")
        self.assertTrue(e.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], FATOR_1613)
        self.assertEqual(rec["processing_notes"].count("Vencimento corrigido"), 1)


class RegisterFinancialCallSiteTest(unittest.TestCase):
    """🔴 O CALL SITE EXECUTADO — `read_emails._apply_barcode_due_date`, no choke point de
    gravação. Testar só o extrator NÃO cobre este caminho: era ele que, sendo o ÚLTIMO a
    falar, revertia a data impressa que o extrator havia decidido (a nota duplicada da conta
    1613 é a prova de que as duas camadas escreviam)."""

    def setUp(self):
        sys.path.insert(
            0, str(Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"))
        import read_emails
        self.R = read_emails

    def _payload(self, due):
        return {"barcode": BC_1613, "amount": AMT_1613, "issue_date": ISS_1613,
                "due_date": due, "processing_notes": None}

    def test_gravacao_nao_reverte_a_data_impressa(self):
        payload = self._payload(IMPRESSO_1613)
        self.R._apply_barcode_due_date(payload)
        self.assertEqual(payload["due_date"], IMPRESSO_1613)
        self.assertIn("Vencimento gravado", payload["processing_notes"])

    def test_gravacao_ainda_corrige_a_inversao_dia_mes(self):
        # Não regredir a rede de segurança: o caminho do CORPO não tem data impressa, e a
        # inversão do Vision (id 435) continua sendo corrigida aqui.
        payload = self._payload("2026-09-18")
        self.R._apply_barcode_due_date(payload)
        self.assertEqual(payload["due_date"], FATOR_1613)
        self.assertIn("Vencimento corrigido", payload["processing_notes"])

    def test_as_duas_camadas_escrevem_a_MESMA_nota_uma_unica_vez(self):
        # Extrator e gravação em sequência, como em produção: uma nota só, uma grafia só.
        rec = {"barcode": BC_1613, "amount": AMT_1613, "issue_date": ISS_1613,
               "due_date": IMPRESSO_1613, "processing_notes": None}
        e.apply_barcode_due_date(rec)
        self.R._apply_barcode_due_date(rec)
        self.assertEqual(rec["processing_notes"].count("Vencimento gravado"), 1)
        self.assertEqual(rec["due_date"], IMPRESSO_1613)


if __name__ == "__main__":
    unittest.main()
