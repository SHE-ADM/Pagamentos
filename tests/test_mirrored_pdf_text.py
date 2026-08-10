"""
Testes do PDF com texto ESPELHADO (pagina inteira invertida) — extract_pdf.

Caso real: o boleto das seguradoras (SEGUROS SURA) e um PDF digital cujo pdfplumber
entrega cada linha com os caracteres em ordem invertida ("otnemicneV"=Vencimento,
"49,331 $R"=R$ 133,94). O volume de texto passa longe do limiar de "texto curto", entao
nao havia fallback e o Claude recebia texto ilegivel. Pior: a LINHA DIGITAVEL fica
fragmentada entre colunas e nao volta nem invertendo as linhas — sem ela nao ha barcode,
e a regra de seguradora (so boleto valido vira conta) nunca fecharia.

Solucao: detectar o espelhamento e mandar o PDF ao Claude Vision, que le a pagina
RENDERIZADA (visualmente correta). Distinto de fix_reversed_lines, que anota campos
isolados de uma coluna RTL.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import extract_pdf as E  # noqa: E402

# Linhas REAIS extraidas do boleto da SEGUROS SURA (pdfplumber), todas espelhadas.
MIRRORED = "\n".join([
    "otnemicneV",           # Vencimento
    "6202/80/01",           # 10/08/2026
    "oiráicifeneB",         # Beneficiário
    "A/S ARUS SORUGES",     # SEGUROS SURA S/A
    "49,331 $R",            # R$ 133,94
    "otnemucoD od rolaV",   # Valor do Documento
    "otnemagaP ed lacoL",   # Local de Pagamento
])

# Boleto normal — inclui uma linha de campo RTL isolada (tratada por fix_reversed_lines),
# que NAO pode ser confundida com pagina espelhada.
NORMAL = "\n".join([
    "BANCO ITAU S.A. 341-7",
    "Local de Pagamento: PAGAVEL PREFERENCIALMENTE NA REDE ITAU",
    "Beneficiario: FORNECEDOR EXEMPLO LTDA",
    "Vencimento 10/08/2026",
    "Valor do Documento R$ 133,94",
    "Nosso Numero 109/26634652-4  Carteira 109",
    "34191.09008 02011.924000 01500.000000 8 11534000013394",
])


class IsMirroredTextTest(unittest.TestCase):
    def test_detecta_pagina_espelhada(self):
        self.assertTrue(E.is_mirrored_text(MIRRORED))

    def test_texto_normal_nao_dispara(self):
        self.assertFalse(E.is_mirrored_text(NORMAL))

    def test_normal_com_anotacoes_rtl_nao_dispara(self):
        # fix_reversed_lines anexa linhas "[RTL: ...]" num boleto normal; elas nao podem
        # ser lidas como espelhamento de pagina.
        self.assertFalse(E.is_mirrored_text(E.fix_reversed_lines(NORMAL)))

    def test_pdf_misto_dispara(self):
        # O PDF real da SURA tem paginas NORMAIS (informacoes ao segurado) + a pagina do
        # boleto espelhada. Contar por linha e o que faz esse caso ser detectado.
        self.assertTrue(E.is_mirrored_text(NORMAL + "\n" + MIRRORED))

    def test_vazio_e_curto(self):
        self.assertFalse(E.is_mirrored_text(""))
        self.assertFalse(E.is_mirrored_text(None))
        self.assertFalse(E.is_mirrored_text("otnemicneV"))   # 1 linha < minimo


class ExtractSingleRoteiaParaVisionTest(unittest.TestCase):
    """_extract_records manda ao Vision quando o texto sai espelhado."""

    def _run(self, raw):
        # O mock precisa ser de `build_records` (o que o codigo chama): mockar o antigo
        # `build_record` nao teria efeito nenhum e o teste passaria a exercitar o extrator
        # REAL — o `call_count` abaixo mediria o fallback tier-2 "valor ausente", nao o
        # espelhamento. O `amount` preenchido e o que mantem esse tier-2 fora do caminho.
        with patch.object(E, "is_scanned_pdf", return_value=False), \
             patch.object(E, "extract_with_pdfplumber", return_value=(raw, "pdf_text")), \
             patch.object(E, "extract_with_vision",
                          return_value=("{}", "pdf_vision")) as vision, \
             patch.object(E, "build_records", return_value=[{"amount": "133.94"}]):
            E._extract_records(Path("boleto.pdf"))
        return vision

    def test_texto_espelhado_chama_vision(self):
        self.assertEqual(self._run(MIRRORED).call_count, 1)

    def test_texto_normal_nao_chama_vision(self):
        # Nao regredir: PDF digital comum continua saindo pelo pdfplumber, sem custo
        # de uma chamada Vision.
        self.assertEqual(self._run(NORMAL).call_count, 0)


if __name__ == "__main__":
    unittest.main()
