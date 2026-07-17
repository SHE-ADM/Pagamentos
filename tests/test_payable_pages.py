"""
test_payable_pages.py — split de PDF com VÁRIOS pagáveis (extract_pdf).

Cobre a causa raiz de um bug recorrente: um PDF com N pagáveis gerava só 1 conta porque o
split (`process_pdf`) só disparava por LINHA DIGITÁVEL de boleto (47 díg). Guia sem linha
digitável — FGTS Digital (só PIX Copia-e-Cola), DARF/guia de arrecadação (48 díg) — não era
detectada e todos os pagáveis além do 1º sumiam.

O detector agora é GENÉRICO: uma página é pagável se tem um INSTRUMENTO DE PAGAMENTO
(linha digitável 47 · arrecadação 48 · PIX EMV). Página de detalhamento (relação de
trabalhadores/instruções) não tem instrumento → não conta.

Funções PURAS sobre texto + `process_pdf` com mock (o PDF real do FGTS tem PII e NÃO pode
virar fixture).
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))
import extract_pdf as E  # noqa: E402

# Trechos REAIS (sem PII) das duas guias do FGTS Digital do caso que motivou o fix.
FGTS_GUIA_MENSAL = (
    "GFD - Guia do FGTS Digital\n"
    "Valor a recolher\n18.613,57\n"
    "Identificador 0126071650177531-3\n"
    "PIX Copia e Cola:\n00020101021226900014br.gov.bcb.pix2568pix-qrcode.caixa.gov.br/api"
)
FGTS_GUIA_CONSIGNADO = (
    "GFD - Guia do FGTS Digital\n"
    "Valor a recolher\n4.313,30\n"
    "Identificador 0126071650177513-5\n"
    "PIX Copia e Cola:\n00020101021226900014br.gov.bcb.pix2568pix-qrcode.caixa.gov.br/api"
)
FGTS_DETALHE = (
    "Detalhe da Guia Emitida\nRelação de Trabalhadores\n"
    "Nome Trabalhador Matrícula CPF Categoria Vencimento Total\n"
    "AMARO VICENTE DA SILVA 341 298.772.418-70 101 20/07/2026 199,50\n"
    "Total da Guia: 18.613,57"
)
# Boleto FEBRABAN (linha digitável de 47 díg: 5.5 5.6 5.6 1 14) — o caso que já funcionava.
BOLETO_TXT = "Beneficiário X\n23793.15980 00001.510883 50709.000001 3 39840016800000\nR$ 1.510,88"
# Guia de arrecadação com linha digitável de 48 díg (tributo/concessionária).
ARRECADACAO_TXT = "GUIA DARF\n85800000018-6 61410312024-0 08000642024-6 00000000000-0\nValor 18,00"


class HasPixEmvTest(unittest.TestCase):
    def test_pix_copia_e_cola(self):
        self.assertTrue(E._has_pix_emv("PIX Copia e Cola: 00020101021226900014br.gov.bcb.pix..."))

    def test_chave_bc_com_quebras_e_espacos(self):
        self.assertTrue(E._has_pix_emv("...br.gov.\nbcb.\npix2568..."))

    def test_texto_comum_nao_casa(self):
        self.assertFalse(E._has_pix_emv("pagamento via pix para o fornecedor"))

    def test_vazio(self):
        self.assertFalse(E._has_pix_emv(""))
        self.assertFalse(E._has_pix_emv(None))


class PageHasPayableTest(unittest.TestCase):
    def test_guia_fgts_por_pix(self):
        self.assertTrue(E._page_has_payable(FGTS_GUIA_MENSAL))
        self.assertTrue(E._page_has_payable(FGTS_GUIA_CONSIGNADO))

    def test_detalhamento_nao_e_pagavel(self):
        # A página de relação de trabalhadores tem "Total da Guia" e CPFs, mas NENHUM
        # instrumento de pagamento — não pode virar conta.
        self.assertFalse(E._page_has_payable(FGTS_DETALHE))

    def test_boleto_por_linha_digitavel(self):
        self.assertTrue(E._page_has_payable(BOLETO_TXT))

    def test_arrecadacao_48_digitos(self):
        self.assertTrue(E._page_has_payable(ARRECADACAO_TXT))

    def test_pagina_em_branco(self):
        self.assertFalse(E._page_has_payable(""))
        self.assertFalse(E._page_has_payable("apenas um texto qualquer sem valor"))


class ProcessPdfSplitTest(unittest.TestCase):
    """O split ≥2 (carnê/multi-guia) — hoje SEM cobertura direta. Mocka _payable_pages e
    _extract_single para não depender de PDF real nem de rede."""

    def _run(self, pages, per_page_recs):
        it = iter(per_page_recs)
        with mock.patch.object(E, "_is_image_file", return_value=False), \
             mock.patch.object(E, "_pdf_is_encrypted", return_value=False), \
             mock.patch.object(E, "_payable_pages", return_value=pages), \
             mock.patch.object(E, "_write_single_page", side_effect=lambda p, i: Path(f"/tmp/pg{i}.pdf")), \
             mock.patch.object(Path, "unlink", return_value=None), \
             mock.patch.object(E, "_extract_single", side_effect=lambda p, **k: next(it)):
            return E.process_pdf(Path("multi_guias_fgts.pdf"))

    def test_dois_pagaveis_geram_dois_registros(self):
        recs = self._run([0, 1], [
            {"amount": 18613.57, "document_type": "tributo"},
            {"amount": 4313.30, "document_type": "tributo"},
        ])
        self.assertEqual(len(recs), 2)
        self.assertEqual([r["amount"] for r in recs], [18613.57, 4313.30])
        # source_file preservado = o nome do PDF ORIGINAL (não a página temporária).
        self.assertTrue(all(r["source_file"] == "multi_guias_fgts.pdf" for r in recs))

    def test_um_pagavel_nao_divide_um_registro(self):
        # Contrato preservado: 1 pagável ⇒ 1 registro (não split).
        recs = self._run([0], [{"amount": 100.0, "document_type": "boleto"}])
        self.assertEqual(len(recs), 1)

    def test_circuit_breaker_para_no_erro_api(self):
        recs = self._run([0, 1, 2], [
            {"amount": 10.0, "document_type": "tributo"},
            {"extraction_source": "erro_api", "document_type": "ERRO"},
            {"amount": 30.0, "document_type": "tributo"},  # nunca alcançado
        ])
        self.assertEqual(len(recs), 2)  # parou no erro_api, não chamou o 3º


if __name__ == "__main__":
    unittest.main()
