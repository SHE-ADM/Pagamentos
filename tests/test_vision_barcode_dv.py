"""
2ª barreira do caminho VISUAL: o DV geral do código de barras.

DEFEITO DE ORIGEM (medido em 22/09/2026, acervo inteiro): o modelo às vezes CONVERTE por
conta própria a linha digitável de 47 dígitos em código de barras de 44 e erra o campo livre,
mantendo banco, DV, fator e valor intactos — por isso `barcode_self_refuted` (que cruza VALOR
e FATOR) não o pega. Resultado gravado, por exemplo, na conta 1614:

    impresso   00190.00009 03580.329005 00004.330171 1 15770002509200
    gravado    00191157700025092000000090358032905000043301   ← DVs de bloco no campo livre

São 20 códigos assim na base, **100% `pdf_vision`** — ZERO em `pdf_text`/`email_body`, onde os
dígitos vêm do texto do PDF. Um código errado não casa a 2ª via na dedup por barcode e faz
nascer conta DUPLICADA; o próprio `febraban.normalize_barcode` já declara que "código
inventado causa dedup falsa e PERDA SILENCIOSA" enquanto "barcode ausente só custa a chave de
dedup". Sem barcode a dedup cai no nosso número / documento+valor, que funcionam.

Descartar só é seguro porque a linha SEM barcode deixou de ser confundida com "fatura do mesmo
débito" (ver `tests/test_fatura_boleto.py::CarneParcelasMesmoValorTest`).
"""

import json
import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import extract_pdf as e  # noqa: E402

# Código REAL e íntegro (conta 1613 / NF17241-10, R$ 25.092,00, fator 1576 → 21/09/2026).
BC_BOM = "00198157600025092000000003580329000000432917"
# Código REAL gravado na conta 1614 pela conversão errada do modelo: valor (25.092,00) e
# fator (1577 → 22/09/2026) conferem — o que o refuta é só o DV geral.
BC_DV_ERRADO = "00191157700025092000000090358032905000043301"
AMT = 25092.00
ISS = "2026-09-17"


def _data(barcode, **over):
    base = {"document_type": "boleto", "supplier_name": "RAINHA MARIA",
            "amount": AMT, "barcode": barcode, "issue_date": ISS,
            "due_date": "2026-09-22", "invoice_number": "NF17242-10",
            "nosso_numero": "00035803290000004330-0"}
    base.update(over)
    return base


class DvRefutadoNoVisualTest(unittest.TestCase):

    def test_o_codigo_da_conta_1614_e_refutado_pelo_DV(self):
        # Sanidade do fixture (anti-vacuidade): o defeito É invisível às outras duas guardas.
        self.assertTrue(e.barcode_dv_refuted(BC_DV_ERRADO))
        self.assertFalse(e.barcode_self_refuted(BC_DV_ERRADO, AMT, "2026-09-22"))
        self.assertEqual(e.amount_from_barcode(BC_DV_ERRADO), AMT)

    def test_visual_descarta_e_anota(self):
        # 🔴 Pelo BUILDER COMPLETO do caminho visual: o descarte roda no FIM da cadeia, não
        # dentro de `build_record_from_json`. Chamar o builder isolado deixaria o código de
        # fora do teste e o defeito B3 (descarte antes da derivação) voltaria sem vermelho.
        rec = e._build_records_vision(
            Path("boleto.pdf"), json.dumps(_data(BC_DV_ERRADO)), "pdf_vision")[0]
        self.assertIsNone(rec["barcode"])
        self.assertIn("DV não confere", rec["processing_notes"])
        # O resto da leitura é preservado — a conta continua existindo e pagável.
        self.assertEqual(rec["amount"], AMT)
        self.assertEqual(rec["invoice_number"], "NF17242-10")
        self.assertEqual(rec["due_date"], "2026-09-22")

    def test_visual_preserva_codigo_integro(self):
        rec = e._build_records_vision(
            Path("boleto.pdf"), json.dumps(_data(BC_BOM)), "pdf_vision")[0]
        self.assertEqual(rec["barcode"], BC_BOM)
        self.assertNotIn("DV", rec["processing_notes"] or "")

    def test_docx_vision_tambem_descarta(self):
        # A guarda é por VISION_SOURCES (constante), nunca por tupla literal: `docx_vision`
        # é OCR como os outros e ficou de fora por dois meses quando a lista era escrita à mão.
        for fonte in e.VISION_SOURCES:
            rec = e._build_records_vision(
                Path("x.pdf"), json.dumps(_data(BC_DV_ERRADO)), fonte)[0]
            self.assertIsNone(rec["barcode"], fonte)

    def test_o_fator_do_codigo_descartado_AINDA_corrige_a_data(self):
        # 🔴 O modo de falha que a barreira combate deixa VALOR e FATOR intactos — anular o
        # código antes da derivação jogava fora a única fonte determinística do vencimento e
        # desligava, no Vision, a rede que existe desde o id 435. O código alimenta a
        # derivação e só DEPOIS sai.
        rec = e._build_records_vision(
            Path("b.pdf"),
            json.dumps(_data(BC_DV_ERRADO, due_date="2026-12-09")),   # data lida errada
            "pdf_vision")[0]
        self.assertEqual(rec["due_date"], "2026-09-22")               # fator do código
        self.assertIsNone(rec["barcode"])                             # mas o código não é gravado
        self.assertIn("Vencimento corrigido", rec["processing_notes"])

    def test_marca_do_descarte_sobrevive_para_a_dedup(self):
        # A nota é CONTRATO de três camadas (extrator → CSV → gravador): `read_emails`
        # a lê para não fundir este boleto com um irmão de mesmo valor e vencimento.
        rec = e._build_records_vision(
            Path("b.pdf"), json.dumps(_data(BC_DV_ERRADO)), "pdf_vision")[0]
        self.assertTrue(e.barcode_was_discarded(rec["processing_notes"]))

    def test_texto_preserva_o_mesmo_codigo(self):
        # No caminho de TEXTO os dígitos vêm do PDF (228/228 medidos conferindo): ali um DV que
        # não fecha não é prova de leitura errada, e apagar custaria a chave de dedup.
        rec = e.build_record_from_json(Path("x.pdf"), _data(BC_DV_ERRADO), "pdf_text")
        self.assertEqual(rec["barcode"], BC_DV_ERRADO)

    def test_arrecadacao_de_48_nao_e_afetada(self):
        # `barcode_dv_refuted` declara não cobrir arrecadação (outro esquema de DV) — quem
        # julga lá é `arrecadacao_dv_refuted`. A guarda não pode apagar guia de tributo.
        arrec = "8" * 48
        rec = e.build_record_from_json(
            Path("guia.pdf"), _data(arrec, document_type="gnre"), "pdf_vision")
        self.assertEqual(rec["barcode"], arrec)


class NotaDoBuilderSobreviveTest(unittest.TestCase):
    """🔴 As notas dos `apply_*` não podem ser apagadas pelo join do fim do builder.

    Era o que acontecia: `apply_barcode_due_date` anotava a troca de vencimento e a linha
    seguinte sobrescrevia `processing_notes` com a lista local. No caminho visual a correção
    ficava SEM RASTRO — as 5 contas do scan de 21/09/2026 têm a data do fator e nota vazia.
    """

    def test_nota_do_vencimento_sobrevive_no_visual(self):
        # Data lida ANTERIOR ao fator (leitura de campo vizinho) → o fator corrige, e a nota
        # tem de chegar ao registro.
        rec = e.build_record_from_json(
            Path("b.pdf"), _data(BC_BOM, due_date="2026-09-18"), "pdf_vision")
        self.assertEqual(rec["due_date"], "2026-09-21")
        self.assertIn("Vencimento corrigido", rec["processing_notes"])

    def test_nota_do_builder_e_a_do_apply_convivem(self):
        # Nota do próprio builder (CNPJ inválido) + nota do apply: nenhuma das duas some.
        rec = e.build_record_from_json(
            Path("b.pdf"), _data(BC_BOM, due_date="2026-09-18", supplier_cnpj="123"),
            "pdf_vision")
        self.assertIn("CNPJ do beneficiario invalido", rec["processing_notes"])
        self.assertIn("Vencimento corrigido", rec["processing_notes"])

    def _gravacao(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]
                               / "skills" / "email-reader" / "scripts"))
        import read_emails
        return read_emails._apply_barcode_due_date

    def test_nota_do_vencimento_chega_ao_BANCO(self):
        # 🔴 O CALL SITE EXECUTADO: extrator e depois o choke point de gravação, como em
        # produção. A gravação encontra a data JÁ igual ao fator e apagava a nota ao limpar as
        # notas de decisão — a troca chegava ao banco sem rastro (review max de 2026-09-23).
        rec = e._build_records_vision(
            Path("b.pdf"), json.dumps(_data(BC_BOM, due_date="2026-09-18")), "pdf_vision")[0]
        self._gravacao()(rec)
        self.assertEqual(rec["due_date"], "2026-09-21")
        self.assertIn("2026-09-18 → 2026-09-21", rec["processing_notes"] or "")

    def test_nota_OBSOLETA_ainda_sai_na_gravacao(self):
        # Contraprova: a preservação é só da correção cujo DESTINO é a data do registro. Uma
        # nota de extensão ou de correção para OUTRA data não descreve mais o registro.
        rec = {"barcode": BC_BOM, "amount": AMT, "issue_date": ISS, "due_date": "2026-09-21",
               "processing_notes": ("Vencimento gravado 2026-10-05 conforme lido no documento"
                                    " | Vencimento corrigido pelo código de barras (fator "
                                    "FEBRABAN): 2026-09-18 → 2026-10-01 | outra nota")}
        self._gravacao()(rec)
        self.assertEqual(rec["processing_notes"], "outra nota")


if __name__ == "__main__":
    unittest.main()
