"""Conteudo do CT-e a partir da fatura agregada (Onda 5, item 5.3).

O que estes testes travam:
  - a fixture e um TRECHO REAL da fatura BRASPRESS 2607128724 (3 conhecimentos + SUB-TOTAL),
    copiado do PDF que esta no bucket — nao um exemplo inventado que casa o proprio regex;
  - o oraculo do SUB-TOTAL e FAIL-CLOSED: fatura com linha faltando devolve NADA, porque um
    rateio incompleto atribui frete ao conjunto errado sem que nada acuse;
  - "DIVER." (varias notas no mesmo conhecimento) nao vira numero de nota fiscal;
  - a chave tem de estar na linha SEGUINTE — senao uma linha sem chave herdaria a de baixo e
    todo o rateio se deslocaria de um.

Os dados sao publicos de conhecimento de transporte (chave, rota, peso) — sem segredo.
"""

import sys
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"))

import cte_content as C  # noqa: E402

# Trecho REAL da fatura 2607128724 (e-mail "ENC: 1o. ENVIO - Acesso a faturas via WEB").
# Os tres conhecimentos e o SUB-TOTAL sao os do PDF; o cabecalho foi encurtado.
FATURA_REAL = """Matriz: ROD PRESIDENTE DUTRA KM 222,500 S/N
CNPJ 48.740.351/0001-65 Insc. Est.796621736119
Cliente: TEXTIL E CONFECCOES OTIMOTEX LTDA CNPJ: 47.273.917/0001-23
BRASPRES TRANSPORTES URGENTES LTDA - CNPJ: 48.740.351/0001-65
www.braspress.com.br - Central de atendimento Cobranca Braspress: 0800-775-3333
Fatura de Conhecimento(s) de transporte eletronico, acesse o site abaixo e informe a(s) chave(s)
NUMERO PERCURSO DATA PESO NOTA VRL. VRL. DESTINATARIO
AWB ORIG DEST FISCAL MERC. FRETE
005709378 CCT RIO 14/07/2026 96,00 248632 24.156,61 652,60 HANDRED STUDIO COMERCIO LTDA
Chave CTe 35260748740351011442570000057093781966739743
005712210 CCT RIO 16/07/2026 3,00 248658 511,20 148,70 HANDRED STUDIO COMERCIO LTDA
Chave CTe 35260748740351011442570000057122101176557511
005710879 CCT V2C 15/07/2026 8,28 248586 2.300,40 133,87 HAGAEF CONFECCOES EIRELI
Chave CTe 35260748740351011442570000057108791138923112
SUB-TOTAL 107,28 26.968,21 935,17
TOTAL BRUTO R$ PESO CREDIT SUB-TOTAL ICMS ST ICMS QTD AW DESCONTO VALOR LIQUIDO R$
935,17 107,28 0,00 935,17 0,00 0,00 3 0,00 935,17
"""


class DeteccaoTest(unittest.TestCase):
    def test_reconhece_a_fatura_braspress(self):
        self.assertTrue(C.is_braspress_invoice(FATURA_REAL))

    def test_texto_de_outro_emissor_nao_e_fatura_braspress(self):
        """O marcador do emissor evita que o regex generico case tabela de outro documento."""
        dacte = ("DACTE MODAL\nRODONAVES TRANSPORTES E ENCOMENDAS LTDA\n"
                 "005709378 CCT RIO 14/07/2026 96,00 248632 24.156,61 652,60 FULANO\n")
        self.assertFalse(C.is_braspress_invoice(dacte))
        self.assertEqual(C.parse_braspress_invoice(dacte), [])

    def test_texto_vazio_ou_none(self):
        self.assertFalse(C.is_braspress_invoice(""))
        self.assertFalse(C.is_braspress_invoice(None))
        self.assertEqual(C.parse_braspress_invoice(""), [])


class ParseTest(unittest.TestCase):
    def setUp(self):
        self.itens = C.parse_braspress_invoice(FATURA_REAL)

    def test_extrai_os_tres_conhecimentos(self):
        self.assertEqual(len(self.itens), 3)

    def test_campos_do_primeiro_conhecimento(self):
        i = self.itens[0]
        self.assertEqual(i["access_key"], "35260748740351011442570000057093781966739743")
        self.assertEqual(i["awb"], "005709378")
        self.assertEqual(i["origin"], "CCT")
        self.assertEqual(i["destination"], "RIO")
        self.assertEqual(i["service_date"], date(2026, 7, 14))
        self.assertEqual(i["cargo_weight_kg"], Decimal("96.00"))
        self.assertEqual(i["cargo_amount"], Decimal("24156.61"))
        self.assertEqual(i["freight_amount"], Decimal("652.60"))
        self.assertEqual(i["linked_invoice"], "248632")
        self.assertEqual(i["receiver_name"], "HANDRED STUDIO COMERCIO LTDA")

    def test_a_chave_de_cada_linha_e_a_da_linha_seguinte(self):
        """Deslocamento de um atribuiria o frete ao CT-e errado — em silencio."""
        self.assertEqual([i["access_key"][-4:] for i in self.itens], ["9743", "7511", "3112"])

    def test_as_chaves_extraidas_sao_de_cte(self):
        """Modelo 57 = CT-e. Se viesse NF-e aqui, o conteudo estaria no documento errado."""
        for i in self.itens:
            self.assertEqual(i["access_key"][20:22], "57")

    def test_soma_do_frete_bate_com_o_subtotal_impresso(self):
        soma = sum(i["freight_amount"] for i in self.itens)
        self.assertEqual(soma, Decimal("935.17"))


class DiversasNotasTest(unittest.TestCase):
    """'DIVER.' declara VARIAS notas — guardar o literal seria inventar uma NF."""

    FATURA_DIVER = FATURA_REAL.replace(
        "005709378 CCT RIO 14/07/2026 96,00 248632 24.156,61 652,60 HANDRED STUDIO COMERCIO LTDA",
        "005709378 CCT RIO 14/07/2026 96,00 DIVER. 24.156,61 652,60 HANDRED STUDIO COMERCIO LTDA")

    def test_diver_vira_none_e_nao_texto(self):
        itens = C.parse_braspress_invoice(self.FATURA_DIVER)
        self.assertEqual(len(itens), 3)
        self.assertIsNone(itens[0]["linked_invoice"])
        # As demais continuam com a NF real — o sentinela nao contamina o resto.
        self.assertEqual(itens[1]["linked_invoice"], "248658")


class OraculoFailClosedTest(unittest.TestCase):
    """Se o SUB-TOTAL nao fechar, NADA e devolvido — rateio parcial e resposta errada."""

    def test_linha_faltando_derruba_a_fatura_inteira(self):
        sem_uma = FATURA_REAL.replace(
            "005712210 CCT RIO 16/07/2026 3,00 248658 511,20 148,70 HANDRED STUDIO COMERCIO LTDA\n"
            "Chave CTe 35260748740351011442570000057122101176557511\n", "")
        # Sanidade: o trecho realmente saiu (senao o teste mediria a fatura intacta).
        self.assertNotIn("005712210", sem_uma)
        self.assertEqual(C.parse_braspress_invoice(sem_uma), [])

    def test_subtotal_adulterado_derruba_a_fatura(self):
        adulterada = FATURA_REAL.replace("SUB-TOTAL 107,28 26.968,21 935,17",
                                         "SUB-TOTAL 107,28 26.968,21 999,99")
        self.assertEqual(C.parse_braspress_invoice(adulterada), [])

    def test_fatura_sem_subtotal_nao_e_aceita(self):
        sem_total = FATURA_REAL.replace("SUB-TOTAL 107,28 26.968,21 935,17", "")
        self.assertEqual(C.parse_braspress_invoice(sem_total), [])

    def test_tolerancia_absorve_centavo_de_arredondamento_mas_nao_uma_linha(self):
        um_centavo = FATURA_REAL.replace("SUB-TOTAL 107,28 26.968,21 935,17",
                                         "SUB-TOTAL 107,28 26.968,21 935,18")
        self.assertEqual(len(C.parse_braspress_invoice(um_centavo)), 3)

        # 133,87 e a MENOR linha da fatura: se a tolerancia a absorvesse, o oraculo seria inutil.
        uma_linha = FATURA_REAL.replace("SUB-TOTAL 107,28 26.968,21 935,17",
                                        "SUB-TOTAL 107,28 26.968,21 801,30")
        self.assertEqual(C.parse_braspress_invoice(uma_linha), [])


class ChaveNaLinhaSeguinteTest(unittest.TestCase):
    def test_linha_sem_chave_nao_herda_a_chave_de_baixo(self):
        """Sem a exigencia de adjacencia, o rateio inteiro se desloca de um."""
        sem_chave = FATURA_REAL.replace(
            "Chave CTe 35260748740351011442570000057093781966739743\n", "")
        itens = C.parse_braspress_invoice(sem_chave)
        # O oraculo derruba a fatura (faltaria o frete da linha orfa na soma).
        self.assertEqual(itens, [])


class TotalsMatchTest(unittest.TestCase):
    def test_lista_vazia_nunca_fecha(self):
        """0 == 0 nao pode ser lido como 'a fatura fecha' — seria o pior falso verde."""
        self.assertFalse(C.totals_match(FATURA_REAL, []))

    def test_texto_sem_subtotal_nao_fecha(self):
        self.assertFalse(C.totals_match("sem total algum", [
            {"cargo_weight_kg": Decimal(0), "freight_amount": Decimal(0)}]))


class GanchoNoPipelineTest(unittest.TestCase):
    """O gancho EXECUTADO — nao uma guarda de texto que le o call site.

    A licao ja registrada no projeto (regra 2, item 6): guarda textual prova que a chamada
    EXISTE, so a execucao prova que ela FUNCIONA. Foi assim que um `UnboundLocalError` passou
    por uma guarda de wiring verde e derrubou 13 e-mails num dia.
    """

    def setUp(self):
        import importlib.util  # noqa: PLC0415

        raiz = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location(
            "read_emails_para_teste_cte", raiz / "skills" / "email-reader" / "scripts" / "read_emails.py")
        self.R = importlib.util.module_from_spec(spec)
        # `read_emails` precisa achar `cte_content`/`fiscal_key` no sys.path da skill de PDF.
        sys.path.insert(0, str(raiz / "skills" / "pdf-contas-pagar" / "scripts"))
        spec.loader.exec_module(self.R)

        self.chamadas: list = []
        test = self

        class CtrlFalso:
            """Registra a ORDEM das chamadas — e a ordem que este teste existe para travar."""

            _available = True

            def register_fiscal_document(self, doc, storage_key=None, ctx=None):
                test.chamadas.append(("registrou", doc["access_key"]))
                return True

            def update_fiscal_content(self, item):
                test.chamadas.append(("conteudo", item["access_key"]))
                return True

        self.ctrl = CtrlFalso()

    def test_grava_o_conteudo_dos_tres_conhecimentos(self):
        self.R._register_fiscal_documents(self.ctrl, FATURA_REAL, "fatura.pdf")
        conteudos = [c for c in self.chamadas if c[0] == "conteudo"]
        self.assertEqual(len(conteudos), 3)

    def test_o_conteudo_e_gravado_DEPOIS_do_registro_da_chave(self):
        """Conteudo e UPDATE: antes do INSERT ele grava em nada, sem erro e sem sinal."""
        self.R._register_fiscal_documents(self.ctrl, FATURA_REAL, "fatura.pdf")
        tipos = [c[0] for c in self.chamadas]
        # Sanidade do proprio teste: as duas etapas ocorreram.
        self.assertIn("registrou", tipos)
        self.assertIn("conteudo", tipos)
        self.assertLess(max(i for i, t in enumerate(tipos) if t == "registrou"),
                        min(i for i, t in enumerate(tipos) if t == "conteudo"),
                        "todo registro de chave tem de vir ANTES do primeiro UPDATE de conteudo")

    def test_pdf_que_nao_e_fatura_nao_grava_conteudo(self):
        dacte = "DACTE MODAL\nRODONAVES\nCHAVE 35260844914992000138570010624091571624091570\n"
        self.R._register_fiscal_documents(self.ctrl, dacte, "dacte.pdf")
        self.assertEqual([c for c in self.chamadas if c[0] == "conteudo"], [])

    def test_falha_no_conteudo_nao_derruba_o_registro_fiscal(self):
        """NAO-FATAL: o gancho de conteudo nao pode quebrar a extracao do e-mail."""
        class CtrlQueQuebra(type(self.ctrl)):
            def update_fiscal_content(self, item):
                raise RuntimeError("banco fora do ar")

        # Nao deve levantar.
        self.R._register_fiscal_documents(CtrlQueQuebra(), FATURA_REAL, "fatura.pdf")

    def test_modulo_ausente_nao_quebra_o_gancho(self):
        """Deploy parcial (sem cte_content.py) degrada com aviso, nao com excecao."""
        original = self.R._CTE_CONTENT
        try:
            self.R._CTE_CONTENT = False           # simula import que falhou
            self.assertEqual(
                self.R._register_cte_content(self.ctrl, FATURA_REAL, "fatura.pdf"), 0)
        finally:
            self.R._CTE_CONTENT = original


if __name__ == "__main__":
    unittest.main()
