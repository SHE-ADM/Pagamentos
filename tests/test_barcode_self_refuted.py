"""
test_barcode_self_refuted.py — código de barras CORROMPIDO pelo OCR de scan.

CAUSA RAIZ (medida em 07/08/2026 sobre as 442 contas com barcode do banco):
boleto escaneado faz o Vision inserir/deslocar dígitos. O código continua com 44 dígitos —
passa no filtro de COMPRIMENTO, única validação que havia — mas os campos saem deslocados
uma casa: valor exatamente **10×** o do documento e fator de vencimento **impossível**
(5370/5380/5420 onde o correto era 1537 → 2026-08-13, batendo o vencimento real).

Auditoria: 349 consistentes · 68 não-boleto · **18 corrompidos, 100% `pdf_vision`** · 7 em
que só o valor diverge (preservados — a conjunção evita apagar código bom). Fecha em 442.

⚠️ Este bloco já disse "19 corrompidos · 6 só-valor" — números que também somavam 442 e por
isso pareciam consistentes. Re-medido no banco em 2026-08-08 rodando `barcode_self_refuted`
sobre TODOS os barcodes vivos: 0 ainda refutados (a limpeza pegou o conjunto exato), restam
424 = 349 + 68 + **7**, e 442 − 424 = **18** apagados. O erro estava no "6".

POR QUE APAGAR É MELHOR QUE MANTER — e por que isto é, na prática, uma proteção CONTRA
DUPLICATA: o barcode é a impressão digital 1 da dedup, a mais forte. Um código corrompido
não casa o boleto REAL quando ele volta na 2ª via; a dedup falha e nasce conta DUPLICADA.
Sem barcode, a dedup cai nas impressões 2/3 (documento+valor, valor+vencimento), que
funcionam. Código errado é pior que ausente.

Fixtures são códigos REAIS do banco (contas 915/920/926/927 e os candidatos de 916-919).
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))
import extract_pdf as E  # noqa: E402
from febraban import barcode_self_refuted  # noqa: E402

# Conta 915 — leitura BOA: fator 1537 → 2026-08-13 (= vencimento real), valor confere.
BOM = "23799153700038058740001052060055483502653860"
BOM_AMOUNT, BOM_REF = 38058.74, "2026-08-13"

# Contas 920/926/927 — gravadas CORROMPIDAS: valor 10× e fator impossível.
CORROMPIDOS = [
    ("920", "23791538000112001700098200018286570015521602", 11200.17, "2026-08-14"),
    ("926", "23791542000349937500098200018286573015521606", 34993.75, "2026-08-18"),
    ("927", "23791542000087637700098200018286405015521603", 8763.77, "2026-08-18"),
]


class BarcodeSelfRefutedTest(unittest.TestCase):

    def test_codigo_bom_nao_e_refutado(self):
        self.assertFalse(barcode_self_refuted(BOM, BOM_AMOUNT, BOM_REF))

    def test_codigos_corrompidos_sao_refutados(self):
        for rot, bc, amt, ref in CORROMPIDOS:
            with self.subTest(conta=rot):
                self.assertTrue(barcode_self_refuted(bc, amt, ref))

    def test_valor_confere_basta_para_NAO_refutar(self):
        """Um dos dois testes passando já absolve — é o que preserva os 6 casos em que
        só o valor diverge, e evita apagar código bom por causa de um `amount` mal lido."""
        self.assertFalse(barcode_self_refuted(BOM, BOM_AMOUNT, "2035-01-01"))

    def test_sem_amount_decide_pelo_fator(self):
        self.assertFalse(barcode_self_refuted(BOM, None, BOM_REF))
        self.assertTrue(barcode_self_refuted(CORROMPIDOS[0][1], None, CORROMPIDOS[0][3]))

    def test_amount_ilegivel_nao_quebra(self):
        self.assertFalse(barcode_self_refuted(BOM, "n/d", BOM_REF))

    def test_boleto_A_VISTA_nao_e_refutado(self):
        """Fator 0 = sem vencimento embutido, situação legítima. Sem esta saída o gate
        leria 'ausência de prova' como 'prova de erro' e apagaria o código."""
        self.assertFalse(barcode_self_refuted("0019" + "0" * 40, None, BOM_REF))

    def test_ref_date_e_a_data_do_DOCUMENTO_nao_hoje(self):
        """Reprocessamento histórico: um boleto de 2 anos atrás tem fator legítimo mas
        distante de hoje. Julgado contra a data do próprio documento, ele é absolvido —
        contra 'hoje', seria apagado."""
        antigo = "23799133700038058740001052060055483502653860"
        venc = E.due_date_from_barcode(antigo, "2025-06-01")
        self.assertIsNotNone(venc)
        self.assertFalse(barcode_self_refuted(antigo, None, venc))

    def test_nao_boleto_nunca_e_refutado(self):
        """Chave NF-e/CT-e (44 díg, moeda ≠ 9), arrecadação (48) e lixo: nada a refutar."""
        for valor in (None, "", "123", "8" * 48,
                      "35260614200166000187550010000123451000123456"):
            with self.subTest(barcode=str(valor)[:12]):
                self.assertFalse(barcode_self_refuted(valor, 100.0, BOM_REF))


class BuildRecordDescartaBarcodeTest(unittest.TestCase):
    """WIRING: o descarte tem de acontecer no builder, ANTES de o código ser usado."""

    def _rec(self, source, bc, amount):
        return E.build_record_from_json(
            Path("x.pdf"),
            {"document_type": "boleto", "amount": amount, "barcode": bc,
             "due_date": "2026-08-14"},
            source)

    def test_vision_descarta_barcode_corrompido(self):
        rec = self._rec("pdf_vision", CORROMPIDOS[0][1], CORROMPIDOS[0][2])
        self.assertIsNone(rec["barcode"])
        self.assertIn("descartado", rec["processing_notes"])

    def test_vision_preserva_barcode_bom(self):
        rec = self._rec("pdf_vision", BOM, BOM_AMOUNT)
        self.assertTrue(rec["barcode"])

    def test_TODA_fonte_visual_aplica_o_gate(self):
        """🔴 ESTRUTURAL: o gate é regido por `VISION_SOURCES`, não por tupla literal.

        `docx_vision` — Vision sobre a imagem embutida no Word — ficou de fora enquanto a
        lista estava escrita à mão no builder: um print de boleto colado no Word corrompe
        dígito igual a um scan, e o código corrompido seguia gravado como chave de dedup.
        O laço percorre a CONSTANTE: fonte visual nova nasce coberta ou este teste
        vermelha.
        """
        self.assertIn("docx_vision", E.VISION_SOURCES)      # sanidade: o laço não é vazio
        for source in E.VISION_SOURCES:
            with self.subTest(source=source):
                rec = self._rec(source, CORROMPIDOS[0][1], CORROMPIDOS[0][2])
                self.assertIsNone(rec["barcode"], f"{source} manteve código refutado")
                self.assertIn("descartado", rec["processing_notes"])

    def test_fonte_visual_preserva_codigo_bom(self):
        """Anti-vacuidade do laço acima: o gate DISCRIMINA, não apaga tudo."""
        for source in E.VISION_SOURCES:
            with self.subTest(source=source):
                self.assertTrue(self._rec(source, BOM, BOM_AMOUNT)["barcode"])

    def test_pdf_text_NAO_aplica_o_gate(self):
        """No texto os dígitos vêm do PDF e conferem (228/228 medidos); aplicar o gate ali
        custaria barcodes bons sem corrigir nada."""
        rec = self._rec("pdf_text", CORROMPIDOS[0][1], CORROMPIDOS[0][2])
        self.assertTrue(rec["barcode"])

    def test_barcode_corrompido_NAO_contamina_o_valor_da_conta(self):
        """`apply_barcode_amount` preenche `amount` a partir do código quando o documento
        não expõe valor. Com o código corrompido isso gravaria 10× — por isso o descarte
        roda ANTES. Sem a ordem correta, a conta nasceria com valor errado, não vazio."""
        recs = E.build_records(
            Path("x.pdf"),
            '{"document_type": "boleto", "amount": null, "due_date": "2026-08-14",'
            f' "barcode": "{CORROMPIDOS[0][1]}"}}',
            "pdf_vision")
        self.assertIsNone(recs[0]["barcode"])
        self.assertNotEqual(recs[0]["amount"], 112001.70)


if __name__ == "__main__":
    unittest.main()
