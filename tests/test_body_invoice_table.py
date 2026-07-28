"""
Testes da TABELA DE FATURAS no corpo do e-mail (read_emails.py).

Caso de origem — conta 693 (MOVVI): o corpo e uma tabela HTML ACHATADA, uma linha
por CAMPO. Todos os rotulos ficam no CABECALHO e os valores vem depois, entao os
regex ancorados em rotulo nao alcancam nada:

    FATURA / EMISSAO / VENCIMENTO / VALOR / DESCONTO / BOLETO / LINHA DIGITAVEL
    454663_01 / 22/07/2026 / 01/08/2026 / R$ 181.90 / R$ 0.00 / VISUALIZAR / 23793...

Resultado gravado (errado): invoice_number sintetico 'fatura_250726', emissao E
vencimento = 25/07/2026 (a data do e-mail, fallback) e barcode nulo — o vencimento
real, 01/08/2026, esta impresso na tabela E codificado no fator do codigo de barras.

O que a correcao trava aqui:
  1. a linha e reconhecida pela FORMA (documento + 2 datas + R$ valor), sem rotulo;
  2. a linha digitavel e capturada sem rotulo adjacente (separador por PONTO);
  3. rotulo explicito continua tendo PRECEDENCIA sobre a tabela (sem regressao);
  4. a tabela de PARCELAS (OBER, com parcela/dias) NAO e capturada por este parser;
  5. tabela com N faturas -> uma linha por fatura, cada uma com o SEU barcode.
"""

import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))

import extract_pdf  # noqa: E402
import read_emails  # noqa: E402

# Corpo real da conta 693 (acentos removidos; a extracao normaliza acento).
MOVVI_BODY = (
    "MOVVI \r\n MOVVI \r\n TEXTIL E CONF.OTIMOTEX \r\n CNPJ: 47273917/0001-23 \r\n"
    " CARO CLIENTE,\n A(S) FATURA(S) ABAIXO LISTADA(S), FOI(RAM) EMITIDA(S).\n"
    " FATURA \r\n EMISSAO \r\n VENCIMENTO \r\n VALOR \r\n DESCONTO \r\n"
    " BOLETO \r\n LINHA DIGITAVEL \r\n"
    " 454663_01 \r\n 22/07/2026 \r\n 01/08/2026 \r\n R$ 181.90 \r\n R$ 0.00 \r\n"
    " VISUALIZAR \r\n"
    " 23793.39100.90000.004375.07000.842000.3.15250000018190 \r\n OBS:\n"
    " FAVOR DESCONSIDERAR ESTA MENSAGEM, CASO JA TENHO SIDO LIQUIDADO.\r\n"
)

# Barcode de 44 digitos derivado da linha digitavel acima (fator 1525 = 01/08/2026,
# valor 18190 centavos = R$ 181,90 — os dois conferem com o impresso na tabela).
MOVVI_BARCODE = "23793152500000181903391090000004370700084200"

# Data de chegada do e-mail — o vencimento correto (01/08) NAO pode sair dela.
RECEIVED_AT = "2026-07-25T13:05:00+00:00"

# Tabela de parcelas (OBER): 6 campos por linha, incluindo 'Parcela' e 'Dias'.
OBER_BODY = (
    "Prezado(a)  TEXTIL E CONFECCOES OTIMOTEX LTDA\r"
    "  Documento \r  Parcela \r  Emissao \r  Vencimento \r  Valor \r  Dias \r"
    "  963901 \r  001 \r  19/06/2026 \r  19/07/2026 \r  R$ 463,19 \r  25 \r"
    "  963901 \r  002 \r  19/06/2026 \r  18/08/2026 \r  R$ 463,2 \r  55 \r"
    "  963901 \r  003 \r  19/06/2026 \r  17/09/2026 \r  R$ 463,21 \r  85 \r"
    "  Total \r  R$ 1.389,60 \r"
)


class TestExtractLinhaDigitavelPontuada(unittest.TestCase):
    """extract_pdf.extract_linha_digitavel (fonte unica) com separador por PONTO."""

    def test_captura_linha_digitavel_toda_pontuada(self):
        raw = "23793.39100.90000.004375.07000.842000.3.15250000018190"
        self.assertEqual(extract_pdf.extract_linha_digitavel(raw),
                         "23793391009000000437507000842000315250000018190")

    def test_formatos_existentes_nao_regridem(self):
        # Padrao canonico (pontos DENTRO dos campos, espaco ENTRE eles) — o mais
        # comum em PDF digital; o padrao novo e o ultimo da ordem e nao o afeta.
        canonico = "23793.39100 90000.004375 07000.842000 3 15250000018190"
        self.assertEqual(extract_pdf.extract_linha_digitavel(canonico),
                         "23793391009000000437507000842000315250000018190")

    def test_texto_sem_linha_digitavel(self):
        self.assertIsNone(extract_pdf.extract_linha_digitavel(
            "Fatura 454663 no valor de R$ 181,90 vence em 01/08/2026"))


class TestExtractBodyInvoiceRow(unittest.TestCase):
    """Parser da linha da tabela — documento, datas, valor e barcode da linha."""

    def test_le_documento_datas_valor_e_barcode(self):
        row = read_emails._extract_body_invoice_row(MOVVI_BODY)
        self.assertIsNotNone(row)
        self.assertEqual(row["doc"], "454663_01")
        self.assertEqual(row["issue_date"], "2026-07-22")
        self.assertEqual(row["due_date"], "2026-08-01")
        self.assertEqual(row["amount"], 181.90)
        self.assertEqual(row["barcode"], MOVVI_BARCODE)

    def test_valor_com_virgula_tambem_e_lido(self):
        body = " 7788/01 \r\n 22/07/2026 \r\n 01/08/2026 \r\n R$ 1.234,56 \r\n"
        row = read_emails._extract_body_invoice_row(body)
        self.assertEqual(row["amount"], 1234.56)
        self.assertEqual(row["doc"], "7788/01")

    def test_data_nao_vira_numero_de_documento(self):
        # A classe do documento aceita '/' e digitos: sem a guarda, a propria data
        # casaria como documento.
        body = " 01/07/2026 \r\n 22/07/2026 \r\n 01/08/2026 \r\n R$ 10,00 \r\n"
        row = read_emails._extract_body_invoice_row(body)
        self.assertTrue(row is None or row["doc"] != "01/07/2026")

    def test_barcode_distante_do_rodape_nao_e_adotado(self):
        # A ÚLTIMA linha não tem "próxima" que a delimite: sem o teto
        # _INVOICE_ROW_BARCODE_WINDOW ela varreria até o fim do corpo e adotaria uma
        # linha digitável do rodapé, que não é dela.
        distante = (" 111_01 \r\n 22/07/2026 \r\n 01/08/2026 \r\n R$ 10,00 \r\n"
                    + " ruido" * 120 + "\r\n"
                    + " 23793.39100.90000.004375.07000.842000.3.15250000018190 \r\n")
        rows = read_emails._extract_body_invoice_rows(distante)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["barcode"])

    def test_barcode_dentro_da_janela_e_adotado(self):
        perto = (" 111_01 \r\n 22/07/2026 \r\n 01/08/2026 \r\n R$ 10,00 \r\n"
                 " 23793.39100.90000.004375.07000.842000.3.15250000018190 \r\n")
        self.assertEqual(read_emails._extract_body_invoice_rows(perto)[0]["barcode"],
                         MOVVI_BARCODE)

    def test_corpo_sem_tabela_nao_produz_linha(self):
        self.assertIsNone(read_emails._extract_body_invoice_row(
            "Segue o pagamento. Valor: R$ 500,00. Obrigado."))

    def test_tabela_de_parcelas_nao_e_capturada(self):
        # A coluna 'Parcela' ('001') nao pode virar numero de documento — o layout
        # de 6 campos e do _extract_body_installments.
        self.assertEqual(read_emails._extract_body_invoice_rows(OBER_BODY), [])
        self.assertEqual(len(read_emails._extract_body_installments(OBER_BODY)), 3)


class TestExtractFromEmailBodyMovvi(unittest.TestCase):
    """Ponta a ponta: o payload que a conta 693 deveria ter recebido."""

    def _payload(self):
        return read_emails.extract_from_email_body(
            MOVVI_BODY, RECEIVED_AT, "<msg-693>",
            sender_email="sender@movvi.com.br",
            subject="FATURAMENTO -- MOVVI LOGISTICA LTDA 25/07/2026")

    def test_numero_do_documento_e_o_da_fatura(self):
        payload = self._payload()
        self.assertEqual(payload["invoice_number"], "454663_01")
        # E, por consequencia, deixa de ser um numero SINTETICO (que a dedup ignora).
        self.assertFalse(read_emails._is_synthetic_invoice_number(payload["invoice_number"]))

    def test_vencimento_vem_da_tabela_nao_da_data_do_email(self):
        payload = self._payload()
        self.assertEqual(payload["due_date"], "2026-08-01")
        self.assertNotEqual(payload["due_date"], RECEIVED_AT[:10])

    def test_emissao_vem_da_tabela(self):
        self.assertEqual(self._payload()["issue_date"], "2026-07-22")

    def test_barcode_capturado_sem_rotulo_adjacente(self):
        payload = self._payload()
        self.assertEqual(payload["barcode"], MOVVI_BARCODE)
        self.assertTrue(read_emails._is_boleto_barcode(payload["barcode"]))
        self.assertEqual(payload["payment_method"], "boleto")

    def test_vencimento_confere_com_o_fator_do_codigo_de_barras(self):
        # O fator FEBRABAN e a fonte autoritativa: a rede de seguranca de
        # register_financial nao deve ter nada a corrigir neste payload.
        payload = self._payload()
        self.assertEqual(
            extract_pdf.authoritative_barcode_due_date(
                payload["barcode"], payload["amount"], payload["issue_date"],
                issue_date=payload["issue_date"]),
            payload["due_date"])

    def test_valor_preservado(self):
        self.assertEqual(self._payload()["amount"], 181.90)


class TestRotuloTemPrecedenciaSobreTabela(unittest.TestCase):
    """A tabela e PREENCHIMENTO DE LACUNA: nunca sobrescreve um rotulo explicito."""

    def test_vencimento_rotulado_vence_a_linha_da_tabela(self):
        body = (
            "Vencimento: 15/09/2026\r\n Emissao: 10/09/2026\r\n Fatura n 99887\r\n"
            " 454663_01 \r\n 22/07/2026 \r\n 01/08/2026 \r\n R$ 181.90 \r\n")
        payload = read_emails.extract_from_email_body(
            body, RECEIVED_AT, "<msg>", sender_email="x@fornecedor.com.br",
            subject="PAGAMENTO FORNECEDOR LTDA")
        self.assertEqual(payload["due_date"], "2026-09-15")
        self.assertEqual(payload["issue_date"], "2026-09-10")
        self.assertEqual(payload["invoice_number"], "99887")


class TestMultiplasFaturasNaTabela(unittest.TestCase):
    """N faturas na tabela -> uma conta por fatura (NUNCA uma conta somada)."""

    BODY = (
        " FATURA \r\n EMISSAO \r\n VENCIMENTO \r\n VALOR \r\n LINHA DIGITAVEL \r\n"
        " 454663_01 \r\n 22/07/2026 \r\n 01/08/2026 \r\n R$ 181.90 \r\n"
        " 23793.39100.90000.004375.07000.842000.3.15250000018190 \r\n"
        " 454663_02 \r\n 22/07/2026 \r\n 01/09/2026 \r\n R$ 250.00 \r\n"
        " 23793.39100.90000.004375.07000.842000.3.15560000025000 \r\n")

    def test_uma_linha_por_fatura(self):
        rows = read_emails._extract_body_invoice_table(self.BODY)
        self.assertEqual(len(rows), 2)
        self.assertEqual([r["doc"] for r in rows], ["454663_01", "454663_02"])
        self.assertEqual([r["due_date"] for r in rows], ["2026-08-01", "2026-09-01"])
        self.assertEqual([r["amount"] for r in rows], [181.90, 250.00])

    def test_cada_fatura_leva_o_proprio_barcode(self):
        # Herdar o barcode da PRIMEIRA linha faria as demais colidirem na dedup por
        # codigo de barras (impressao 1) e sumirem em silencio.
        rows = read_emails._extract_body_invoice_table(self.BODY)
        barcodes = [r["barcode"] for r in rows]
        self.assertTrue(all(barcodes), "toda linha deve ter a sua linha digitavel")
        self.assertEqual(len(set(barcodes)), 2)
        self.assertEqual(barcodes[0], MOVVI_BARCODE)

    def test_fatura_unica_nao_entra_no_caminho_multiplo(self):
        # Uma linha so -> conta unica (o gate espelha o de _extract_body_installments).
        self.assertEqual(read_emails._extract_body_invoice_table(MOVVI_BODY), [])


class FakeCtrl:
    """ctrl minimo para try_extract_from_body — sem rede (mesmo molde de
    tests/test_body_duplicate.py)."""

    def __init__(self):
        self.registered_payloads = []

    def find_financial_duplicate(self, payload):
        return None

    def resolve_supplier(self, payload):
        return 1

    def supplier_defaults(self, sk_supplier):
        return (0, 0)

    def unique_invoice_number(self, n):
        return n

    def register_financial(self, payload):
        self.registered_payloads.append(dict(payload))
        return len(self.registered_payloads)


class TestTryExtractFromBodyMultiFatura(unittest.TestCase):
    """O LAÇO de clones de `try_extract_from_body` — uma conta por fatura, cada uma
    com o SEU barcode.

    Cobre a linha `if "barcode" in inst` do laço, cujo modo de falha é SILENCIOSO:
    sem ela, todas as faturas herdariam o barcode da PRIMEIRA (que o payload base
    recebe da busca no corpo inteiro), colidiriam na dedup por código de barras
    (impressão 1) e os títulos seguintes sumiriam sem erro.
    """

    def _run(self, body):
        ctrl = FakeCtrl()
        rec = {"subject": "FATURAMENTO -- FORNECEDOR LTDA"}
        outcome = read_emails.try_extract_from_body(
            rec, body, "2026-07-25T10:00:00+00:00", "<msg-multi>", ctrl,
            sender_email="financeiro@fornecedor.com.br")
        return outcome, ctrl.registered_payloads

    def test_uma_conta_por_fatura_com_barcode_proprio(self):
        outcome, pagas = self._run(TestMultiplasFaturasNaTabela.BODY)
        self.assertEqual(outcome, read_emails.BODY_CREATED)
        self.assertEqual(len(pagas), 2, "cada fatura vira UMA conta — nunca uma soma")
        self.assertEqual([p["invoice_number"] for p in pagas], ["454663_01", "454663_02"])
        self.assertEqual([p["amount"] for p in pagas], [181.90, 250.00])
        self.assertEqual([p["due_date"] for p in pagas], ["2026-08-01", "2026-09-01"])
        barcodes = [p["barcode"] for p in pagas]
        self.assertTrue(all(barcodes))
        self.assertEqual(len(set(barcodes)), 2, "barcode por linha — não herdar o da 1ª")
        self.assertEqual(barcodes[0], MOVVI_BARCODE)

    def test_linha_sem_linha_digitavel_nao_herda_o_barcode_da_primeira(self):
        body = (
            " 111_01 \r\n 22/07/2026 \r\n 01/08/2026 \r\n R$ 10,00 \r\n"
            " 23793.39100.90000.004375.07000.842000.3.15250000018190 \r\n"
            " 222_01 \r\n 22/07/2026 \r\n 01/09/2026 \r\n R$ 20,00 \r\n")
        _, pagas = self._run(body)
        self.assertEqual(len(pagas), 2)
        self.assertEqual(pagas[0]["barcode"], MOVVI_BARCODE)
        self.assertIsNone(pagas[1]["barcode"], "sem boleto próprio, o campo fica vazio")

    def test_parcelas_ober_nao_perdem_o_barcode_do_payload_base(self):
        # O layout de PARCELAS não traz a chave 'barcode' nas linhas — os clones devem
        # manter o do payload base (a guarda `in inst` existe justamente para isso).
        rows = read_emails._extract_body_installments(OBER_BODY)
        self.assertEqual(len(rows), 3)
        self.assertTrue(all("barcode" not in r for r in rows))


if __name__ == "__main__":
    unittest.main()
