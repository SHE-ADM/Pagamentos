"""
'Nº do Documento' do boleto em `invoice_number` — nunca o Nosso Número (2026-09-15).

Caso de origem (RAINHA MARIA, contas 1499-1525): o prompt pedia o NOSSO NÚMERO em
`invoice_number` e o modelo alternava entre os dois dentro do MESMO carnê — a coluna
"Nº Documento" de /consulta mostrava '00035803290000004122-7' onde o boleto imprime
'NF16751-7'. As linhas abaixo são o texto REAL do pdfplumber (com o U+FFFD que ele entrega
no lugar de 'º'/'ú'), medidas em 25 fornecedores.
"""

import json
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "skills" / "pdf-contas-pagar" / "scripts"))

import extract_pdf as E

F = "�"

# Ficha real do boleto 1675-1 (Banco do Brasil) — recibo do pagador + ficha de compensação.
RAINHA_1675_1 = f"""Recibo do Pagador
001-9 00190.00009 03580.329005 00004.122172 3 15700002880943
Nome do Pagador / Endere{F}o CNPJ Data de Vencimento
TEXTIL E CONFECCOES OTIMOTEX LT 47.273.917/0001-23 15/09/2026
Nome do Bene(cid:141)ci{F}rio / Endere{F}o CNPJ Nosso N{F}mero
RAINHA MARIA IMPORTACAO E EXPORTACAO LTD 39.697.742/0001-53 00035803290000004122-7
CEP: 88303-020, ITAJAI - SC 28.809,43
Uso do Banco Nr. do Documento Esp{F}cie Doc. Aceite Data Processamento (=) Valor Pago
NF16751-7 DM N 11/09/2026
Local do Pagamento Data de Vencimento
Pagar preferencialmente nos canais de autoatendimento do Banco do Brasil 15/09/2026
Data Documento Nr. do Documento Esp{F}cie Doc. Aceite Data Processamento Nosso N{F}mero
11/09/2026 NF16751-7 DM N 11/09/2026 00035803290000004122-7
Uso do Banco Carteira Esp{F}cie Quantidade (x) Valor (=) Valor do Documento
17 R$ 28.809,43
"""
NOSSO_1675_1 = "00035803290000004122-7"

# O que o modelo devolvia para esse boleto: o NOSSO NÚMERO no lugar do Nº do Documento.
MODELO = {"document_type": "boleto", "supplier_name": "RAINHA MARIA IMPORTACAO E EXPORTACAO LTD",
          "supplier_cnpj": "39697742000153", "invoice_number": NOSSO_1675_1,
          "nosso_numero": NOSSO_1675_1, "due_date": "2026-09-15", "issue_date": "2026-09-11",
          "amount": 28809.43, "payment_method": "boleto"}

# (cabeçalho, linha de valores, Nº do Documento esperado) — um layout real por fornecedor.
LAYOUTS = [
    (f"Data do Documennto N{F} Documento Esp{F}cie Doc. Aceite Data do Processamento Nosso N{F}mero",
     "09/09/2026 1-3196445/1 DM N 09/09/2026 29992030000118075", "1-3196445/1"),
    # Nosso número com espaços ('009 / 06001098465 - 9') não contamina o nº do documento.
    (f"Data do Doc. N{F} do documento Esp{F}cie Doc. Aceite Data Proces. Nosso N{F}mero",
     "10/09/2026 06001098465 DS N 10/09/2026 009 / 06001098465 - 9", "06001098465"),
    (f"Data do Documento N{F}mero do Documento Esp{F}cie Doc. Aceite Data do Processamento Nosso N{F}mero",
     "31/08/2026 000736.001 RC N 31/08/2026 14000000001252063-8", "000736.001"),
    # Nº do documento com espaço interno.
    (f"Data Documento: No. Documento Esp{F}cie Doc. Aceite Data Proces. Nosso N{F}mero",
     "24/08/2026 504811 01 DM A 25/08/2026 112 / 333949090", "504811 01"),
    # Data com ano de 2 dígitos.
    (f"Data do Documento N{F} do Documento Esp{F}cie Doc Aceite Data do Processamento Nosso N{F}mero",
     "18/08/26 96325/1 DP N 19/08/2026 109/00008273-9", "96325/1"),
    # Datas com ponto.
    (f"Data do Doc. N{F}mero Documento Esp{F}cie Doc. Aceite Data Processamento Nosso N{F}mero",
     "12.09.2026 000177318-007 DM N 12.09.2026", "000177318-007"),
    # Aceite 'NÃO'.
    (f"Data do Documento N{F} do Documento Esp{F}cie Documento Aceite Data de Processamento Nosso N{F}mero",
     f"16/08/2026 17069 DM N{F}O 16/08/2026 00019/112/9081863149-4", "17069"),
    # Sem Espécie impressa; nº do documento igual ao nosso número (legítimo).
    (f"Data do Documento Nr. Documento Esp{F}cie DOC Aceite Data do Processamento Nosso N{F}mero",
     "09/09/2026 1002887829 N 09/09/2026 1002887829", "1002887829"),
]


class HeaderGateTest(unittest.TestCase):
    """Sanidade do parser: se o gate parar de reconhecer os cabeçalhos reais, os testes de
    extração abaixo virariam `None == None` — verdes para sempre."""

    def test_reconhece_todos_os_cabecalhos_reais(self):
        for header, _, _ in LAYOUTS:
            self.assertTrue(E._is_docnum_header(header), header)

    def test_nao_reconhece_cabecalhos_que_nao_sao_a_linha_da_ficha(self):
        for header in (
            f"Pagador Nosso N{F}mero No. Documento Valor do Documento",  # sem 'Data'
            f"Nome do Pagador / Endere{F}o CNPJ Data de Vencimento",
            f"(-) Outras Dedu{F}{F}es (=) Valor Cobrado N{F} do Documento",
        ):
            self.assertFalse(E._is_docnum_header(header), header)


class ExtractDocumentNumberTest(unittest.TestCase):
    def test_boleto_RAINHA_MARIA(self):
        self.assertEqual(E.extract_boleto_document_number(RAINHA_1675_1), "NF16751-7")

    def test_um_layout_por_fornecedor(self):
        for header, row, esperado in LAYOUTS:
            with self.subTest(esperado=esperado):
                self.assertEqual(E.extract_boleto_document_number(f"{header}\n{row}\n"), esperado)

    def test_layout_com_colunas_em_outra_ordem_nao_adivinha(self):
        # 'Carteira | Data do Documento | Nº' — a linha começa por '109'; sem a âncora o
        # regex leria '10014 R$'. A 2ª ocorrência (layout padrão) resolve.
        texto = ("Uso do Banco Carteira Data do Documento Nr. Do Documento Esp�cie Data do Processamento\n"
                 "109 27/08/2026 10014 R$ 27/08/2026\n")
        self.assertIsNone(E.extract_boleto_document_number(texto))
        texto += ("Data do Documento Nr. Do Documento Esp�cie Doc. Aceite Data do Processamento Nosso N�mero\n"
                  "27/08/2026 10014 DS N 27/08/2026 109/20010014-4\n")
        self.assertEqual(E.extract_boleto_document_number(texto), "10014")

    def test_leituras_divergentes_nao_escolhem(self):
        # PDF com vários boletos: carimbar o 1º número nos demais seria erro silencioso.
        h = LAYOUTS[4][0]
        texto = (f"{h}\n18/08/26 96325/1 DP N 19/08/2026 109/00008273-9\n"
                 f"{h}\n18/08/26 96325/2 DP N 19/08/2026 109/00008274-7\n")
        self.assertIsNone(E.extract_boleto_document_number(texto))

    def test_valores_que_nao_sao_numero_de_documento(self):
        h = LAYOUTS[0][0]
        for row in ("11/09/2026 DM N 11/09/2026 00035803290000004122-7",  # coluna vazia
                    "18/06/2026 5.576,66 DM N 18/06/2026",                # valor monetário
                    "18/06/2026 18/06/2026 DM N 18/06/2026"):             # data
            with self.subTest(row=row):
                self.assertIsNone(E.extract_boleto_document_number(f"{h}\n{row}\n"))

    def test_cauda_de_especie_e_aceite_nao_entra_no_numero(self):
        # 🔴 Linhas REAIS com token de 6 letras, fora do teto {1,5} do regex: a cauda vazava
        # para o Nº e o script retroativo a gravou em 5 contas ('… RECIBO', '… DM NAO ACEITO').
        casos = [
            (f"Data do Documento No. do Documento Esp{F}cie doc. Aceite Data Processamento Nosso N{F}mero",
             "12/06/2026 1606 DS NAO ACEITO 12/06/2026 0000000000118", "1606"),
            (f"Data do Documento N{F} do Documento Esp{F}cie Doc. Aceite DATA DO PROC Nosso N{F}mero",
             "15/06/2026 0008901683 RECIBO N 16/06/2026 04/26/104177433-1", "0008901683"),
        ]
        for header, row, esperado in casos:
            with self.subTest(esperado=esperado):
                # Sanidade: o cabeçalho real é reconhecido — senão o teste seria `None == None`.
                self.assertTrue(E._is_docnum_header(header), header)
                self.assertEqual(E.extract_boleto_document_number(f"{header}\n{row}\n"), esperado)

    def test_sem_texto(self):
        self.assertIsNone(E.extract_boleto_document_number(None))
        self.assertIsNone(E.extract_boleto_document_number(""))
        self.assertIsNone(E.extract_boleto_document_number("Nosso Numero 00035803290000004122-7"))


class ApplyDocumentNumberTest(unittest.TestCase):
    def test_substitui_o_nosso_numero_lido_pelo_modelo(self):
        rec = {"invoice_number": NOSSO_1675_1, "processing_notes": None}
        E.apply_boleto_document_number(rec, RAINHA_1675_1)
        self.assertEqual(rec["invoice_number"], "NF16751-7")

    def test_sem_leitura_preserva_o_modelo(self):
        rec = {"invoice_number": "123456", "processing_notes": None}
        E.apply_boleto_document_number(rec, "texto sem ficha")
        self.assertEqual(rec["invoice_number"], "123456")

    def test_substituir_sintetico_retira_a_nota(self):
        rec = {"invoice_number": "boleto_150926",
               "processing_notes": f"outra nota | {E.SYNTHETIC_INVOICE_NOTE}"}
        E.apply_boleto_document_number(rec, RAINHA_1675_1)
        self.assertEqual(rec["processing_notes"], "outra nota")


class CallSiteTest(unittest.TestCase):
    """Os builders EXECUTADOS — testar a função pura não cobre o call site."""

    def test_caminho_de_texto(self):
        with mock.patch.object(E, "extract_fields_with_claude", return_value=dict(MODELO)), \
             mock.patch.object(E, "_try_barcode_vision", return_value=None):
            recs = E._build_records_text(Path("rainha_1675-1.pdf"), RAINHA_1675_1, "pdf_text")
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["invoice_number"], "NF16751-7")
        self.assertEqual(recs[0]["nosso_numero"], NOSSO_1675_1)

    def test_caminho_visual_com_texto_do_documento(self):
        recs = E._build_records_vision(Path("rainha_1675-1.pdf"), json.dumps(MODELO),
                                       "pdf_vision", doc_text=RAINHA_1675_1)
        self.assertEqual(recs[0]["invoice_number"], "NF16751-7")

    def test_caminho_visual_com_N_pagaveis_nao_carimba(self):
        outro = dict(MODELO, invoice_number="BOL16772-7", due_date="2026-09-16")
        recs = E._build_records_vision(Path("carne.pdf"), json.dumps([MODELO, outro]),
                                       "pdf_vision", doc_text=RAINHA_1675_1)
        self.assertEqual([r["invoice_number"] for r in recs], [NOSSO_1675_1, "BOL16772-7"])


class PromptTest(unittest.TestCase):
    def test_prompt_pede_o_numero_do_documento_e_nao_o_nosso_numero(self):
        m = re.search(r"^- invoice_number:(.*?)^- ", E.EXTRACTION_PROMPT, re.MULTILINE | re.DOTALL)
        self.assertIsNotNone(m, "regra de invoice_number não encontrada no prompt")
        regra = m.group(1)
        self.assertIn("Nr. do Documento", regra)
        self.assertIn("NUNCA use o 'Nosso Numero'", regra)
        self.assertNotIn("use o 'Nosso Numero' —", regra)


if __name__ == "__main__":
    unittest.main()
