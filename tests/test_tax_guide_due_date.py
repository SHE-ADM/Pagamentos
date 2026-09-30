"""
Guia de TRIBUTO: o fator do código de barras nunca empurra o vencimento para DEPOIS da
data-limite impressa.

Caso real (2026-09-29, conta 1757): DAS do Simples, "Pagar até: 29/09/2026", R$ 4.965,29.
A linha digitável vem em formato BANCÁRIO (não arrecadação '8'), com DV e valor corretos e
fator 1607 = 22/10/2026. A política de boleto ("data lida anterior ao fator = campo
vizinho") gravou 22/10 — pagamento em atraso, com multa, sem erro nenhum. Mesmo desfecho
na conta 607 (20/07 -> 28/07).

Executa as DUAS camadas que decidem (extrator e gravação — a última a falar), além da
função pura e da paridade dos conjuntos de guia.
"""

import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import extract_pdf  # noqa: E402
import febraban as F  # noqa: E402
import read_emails  # noqa: E402

# Código real do DAS da conta 1757 (lido do texto do PDF; DV e valor conferem).
DAS_BARCODE = "26095160700004965291675060125772170590000000"
DAS_AMOUNT = 4965.29
PRAZO_LEGAL = "2026-09-29"   # "Pagar até" impresso
FATOR = "2026-10-22"         # fator 1607


class SanidadeDoCasoRealTest(unittest.TestCase):
    """Sem isto os testes abaixo seriam vácuos: o código PRECISA ser aceito como confiável."""

    def test_codigo_real_passa_nas_travas_e_aponta_22_10(self):
        self.assertFalse(F.barcode_dv_refuted(DAS_BARCODE))
        self.assertIsNone(F.arrecadacao_44(DAS_BARCODE))           # não é arrecadação '8'
        self.assertEqual(F.authoritative_barcode_due_date(
            DAS_BARCODE, DAS_AMOUNT, PRAZO_LEGAL), FATOR)


class PoliticaPuraTest(unittest.TestCase):
    def test_guia_nunca_anda_para_depois_do_prazo_legal(self):
        self.assertFalse(F.barcode_due_date_supersedes(PRAZO_LEGAL, FATOR, tax_guide=True))

    def test_boleto_mantem_a_regra_do_campo_vizinho(self):
        self.assertTrue(F.barcode_due_date_supersedes(PRAZO_LEGAL, FATOR))

    def test_guia_sem_data_lida_ou_com_inversao_segue_o_fator(self):
        self.assertTrue(F.barcode_due_date_supersedes(None, FATOR, tax_guide=True))
        self.assertTrue(F.barcode_due_date_supersedes("2026-08-07", "2026-07-08", tax_guide=True))

    def test_guia_com_data_lida_implausivelmente_posterior_segue_o_fator(self):
        self.assertTrue(F.barcode_due_date_supersedes("2027-09-29", FATOR, tax_guide=True))


class CamadaDoExtratorTest(unittest.TestCase):
    def _rec(self, doc_type):
        return {"barcode": DAS_BARCODE, "amount": DAS_AMOUNT, "due_date": PRAZO_LEGAL,
                "issue_date": None, "document_type": doc_type, "processing_notes": None}

    def test_das_preserva_o_prazo_impresso_com_ressalva(self):
        rec = self._rec("das")
        self.assertFalse(extract_pdf.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], PRAZO_LEGAL)
        self.assertIn(FATOR, rec["processing_notes"])            # divergência nunca silenciosa

    def test_boleto_com_o_mesmo_codigo_segue_o_fator(self):
        rec = self._rec("boleto")
        self.assertTrue(extract_pdf.apply_barcode_due_date(rec))
        self.assertEqual(rec["due_date"], FATOR)


class CamadaDeGravacaoTest(unittest.TestCase):
    """A gravação é a ÚLTIMA a falar: sem o `tax_guide` ela desfaria o extrator."""

    def _payload(self, doc_type):
        return {"barcode": DAS_BARCODE, "amount": DAS_AMOUNT, "due_date": PRAZO_LEGAL,
                "issue_date": None, "document_type": doc_type, "processing_notes": None}

    def test_das_mantem_o_prazo_legal_na_gravacao(self):
        p = self._payload("das")
        read_emails._apply_barcode_due_date(p)
        self.assertEqual(p["due_date"], PRAZO_LEGAL)
        self.assertIn(FATOR, p["processing_notes"])

    def test_tipo_composto_dar_dare_tambem_e_guia(self):
        p = self._payload("dar / dare")
        read_emails._apply_barcode_due_date(p)
        self.assertEqual(p["due_date"], PRAZO_LEGAL)

    def test_boleto_na_gravacao_segue_o_fator(self):
        p = self._payload("boleto")
        read_emails._apply_barcode_due_date(p)
        self.assertEqual(p["due_date"], FATOR)


class LeituraDaNotaCorrigidaTest(unittest.TestCase):
    """`due_date_corrected_from` lê a nota que o PRÓPRIO febraban escreve."""

    def test_le_a_origem_da_nota_canonica(self):
        nota = F.due_date_corrected_note(PRAZO_LEGAL, FATOR)
        self.assertEqual(F.due_date_corrected_from(f"outra | {nota}", FATOR), PRAZO_LEGAL)

    def test_le_a_grafia_antiga_sem_acento_e_seta_ascii(self):
        nota = f"Vencimento corrigido pelo codigo de barras (fator FEBRABAN): {PRAZO_LEGAL} -> {FATOR}"
        self.assertEqual(F.due_date_corrected_from(nota, FATOR), PRAZO_LEGAL)

    def test_nunca_inventa_origem(self):
        casos = [
            (F.due_date_corrected_note(None, FATOR), FATOR),            # origem '—'
            (F.due_date_corrected_note(PRAZO_LEGAL, FATOR), "2026-10-23"),  # outro destino
            (F.due_date_extension_note(PRAZO_LEGAL, FATOR), FATOR),     # nota de outro desfecho
            ("Vencimento corrigido pelo código de barras: 2026-13-45 → " + FATOR, FATOR),
            (None, FATOR), ("", FATOR), (F.due_date_corrected_note(PRAZO_LEGAL, FATOR), None),
        ]
        for notes, destino in casos:
            self.assertIsNone(F.due_date_corrected_from(notes, destino), (notes, destino))


class GuiaReclassificadaPeloAssuntoTest(unittest.TestCase):
    """O extrator decide com o tipo do PDF; o ASSUNTO reclassifica depois. Um DAS lido como
    'boleto' sai do extrator com o fator — a gravação tem de devolver o prazo legal."""

    def _extraido_como_boleto(self):
        rec = {"barcode": DAS_BARCODE, "amount": DAS_AMOUNT, "due_date": PRAZO_LEGAL,
               "issue_date": None, "document_type": "boleto", "processing_notes": None}
        self.assertTrue(extract_pdf.apply_barcode_due_date(rec))   # pré-condição: fator aplicado
        self.assertEqual(rec["due_date"], FATOR)
        return rec

    def test_cadeia_real_extrator_assunto_gravacao_restaura_o_prazo(self):
        payload = self._extraido_como_boleto()
        payload["document_type"] = "das"                  # reclassificação pelo assunto
        read_emails._apply_barcode_due_date(payload)
        self.assertEqual(payload["due_date"], PRAZO_LEGAL)
        notas = payload["processing_notes"]
        self.assertIn(FATOR, notas)                        # divergência segue declarada
        self.assertNotIn("corrigido", notas.lower())       # e a nota descreve o estado FINAL

    def test_boleto_de_verdade_continua_com_o_fator(self):
        payload = self._extraido_como_boleto()
        read_emails._apply_barcode_due_date(payload)
        self.assertEqual(payload["due_date"], FATOR)
        self.assertIn("corrigido", payload["processing_notes"].lower())

    def test_sem_a_nota_nao_ha_o_que_restaurar(self):
        payload = self._extraido_como_boleto()
        payload["document_type"] = "das"
        payload["processing_notes"] = None
        read_emails._apply_barcode_due_date(payload)
        self.assertEqual(payload["due_date"], FATOR)

    def test_origem_recusada_pela_politica_segue_o_fator(self):
        # Data lida mais de 60 dias DEPOIS do fator: a própria política dá o fator também
        # para guia — a restauração não pode contorná-la.
        distante = "2027-01-15"
        self.assertTrue(F.barcode_due_date_supersedes(distante, FATOR, tax_guide=True))
        payload = {"barcode": DAS_BARCODE, "amount": DAS_AMOUNT, "due_date": FATOR,
                   "issue_date": None, "document_type": "das",
                   "processing_notes": F.due_date_corrected_note(distante, FATOR)}
        read_emails._apply_barcode_due_date(payload)
        self.assertEqual(payload["due_date"], FATOR)

    def test_vencimento_presumido_nao_e_restaurado(self):
        payload = self._extraido_como_boleto()
        payload["document_type"] = "das"
        payload["processing_notes"] = (f"{payload['processing_notes']} | "
                                       f"{read_emails.DUE_DATE_PRESUMED_NOTE}")
        read_emails._apply_barcode_due_date(payload)
        self.assertEqual(payload["due_date"], FATOR)


class ParidadeDosConjuntosDeGuiaTest(unittest.TestCase):
    """O conjunto canônico cobre os dois conjuntos de guia do pipeline — um tipo de guia
    novo em qualquer camada sem entrar aqui voltaria a ter o prazo legal sobrescrito."""

    def test_cobre_extract_pdf(self):
        self.assertTrue(extract_pdf.TAX_DOC_TYPES)                 # anti-vacuidade
        faltando = {t for t in extract_pdf.TAX_DOC_TYPES if not F.is_tax_guide(t)}
        self.assertEqual(faltando, set())

    def test_cobre_read_emails(self):
        self.assertTrue(read_emails._TAX_DOCUMENT_TYPES)
        faltando = {t for t in read_emails._TAX_DOCUMENT_TYPES if not F.is_tax_guide(t)}
        self.assertEqual(faltando, set())

    def test_tipos_que_nao_sao_guia(self):
        for t in ("boleto", "fatura", "cte", "outro", None, ""):
            self.assertFalse(F.is_tax_guide(t), t)


if __name__ == "__main__":
    unittest.main()
