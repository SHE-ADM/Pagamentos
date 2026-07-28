"""
Testes da regra de SEGURADORA (document_type='seguro' + contexto por ASSUNTO).

Regra de negocio: e-mail de seguradora so gera conta a pagar quando traz um BOLETO com
linha digitavel valida; sem boleto valido o e-mail vira 'ignorado' (nao 'falha'). O
pagavel resultante e rotulado document_type='seguro'.

Caso de origem: email_control 1082 (noreply@segurossuradireto.com.br, assunto
"SEGUROS SURA VID_G_002_930_2011924_15") — o kit digital traz DOIS documentos por link
(boleto + "conjunto faturamento"); so o boleto se paga.

O contexto e detectado SO PELO ASSUNTO. Este arquivo trava, com os dados REAIS de
producao, o motivo: casar por fornecedor/remetente destruiria contas que hoje existem
(348 "PORTO SEGURO - SEGURO SAUDE S/A" sem barcode, 617/58 "Rastreador" da Porto Seguro).
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

# Assuntos REAIS de contas que ja existem no banco e NAO podem virar contexto de
# seguradora — se virarem, o gate do boleto valido as apaga (348/58) ou o rotulo muda (617).
ASSUNTO_CONTA_348 = "BOLETO - PORTO SAÚDE"                       # boleto escaneado, sem barcode
ASSUNTO_CONTA_617 = "Rastreador - Demonstrativo fatura - 07/2026"  # rastreador, nao e seguro
ASSUNTO_CONTA_58 = "Rastreador - Demonstrativo fatura - 06/2026"  # veio do CORPO, sem barcode
ASSUNTO_CONTA_460 = "BOLETO SURA"                                 # ja funciona hoje
ASSUNTO_SURA = "SEGUROS SURA VID_G_002_930_2011924_15"            # o alvo


class IsInsuranceContextTest(unittest.TestCase):
    def test_assunto_do_caso_de_origem(self):
        self.assertTrue(R._is_insurance_context(ASSUNTO_SURA))

    def test_variacoes_de_termo(self):
        for subject in (
            "Apólice de seguro renovada",
            "apolice 123 - segunda via",
            "SEGURADORA XYZ - cobranca mensal",
            "Seguros do Brasil - parcela 03",
            "ENC: SEGURO DE VIDA EM GRUPO",
        ):
            self.assertTrue(R._is_insurance_context(subject), subject)

    def test_nao_casa_dentro_de_outra_palavra(self):
        # Palavra inteira (_has_word): "seguranca"/"segurado" nao sao "seguro".
        for subject in (
            "Curso de segurança do trabalho",
            "BOLETOS LMED MEDICINA E SEGURANCA DO TRABALHO",
            "Informacoes ao segurado",
        ):
            self.assertFalse(R._is_insurance_context(subject), subject)

    def test_nao_quebra_contas_existentes_da_porto_seguro(self):
        # Nenhum destes tem "seguro" no ASSUNTO — e por isso que o criterio por assunto
        # os preserva. Casar por supplier_name/remetente ("PORTO SEGURO…",
        # "@portoseguro.com.br") destruiria as contas 348 e 58.
        for subject in (ASSUNTO_CONTA_348, ASSUNTO_CONTA_617,
                        ASSUNTO_CONTA_58, ASSUNTO_CONTA_460):
            self.assertFalse(R._is_insurance_context(subject), subject)

    def test_vazio(self):
        self.assertFalse(R._is_insurance_context(None))
        self.assertFalse(R._is_insurance_context(""))


class ApplySeguroDocTypeTest(unittest.TestCase):
    def test_relabela_tipos_genericos(self):
        for dtype in ("boleto", "outro", ""):
            self.assertEqual(R._apply_seguro_doc_type(dtype, ASSUNTO_SURA), "seguro")

    def test_preserva_tipo_especifico(self):
        # Uma seguradora que manda guia/CT-e/cartorio continua com o tipo proprio.
        for dtype in ("darf", "das", "cte", "cartório", "honorários", "nfse", "iptu"):
            self.assertEqual(R._apply_seguro_doc_type(dtype, ASSUNTO_SURA), dtype)

    def test_sem_contexto_mantem(self):
        self.assertEqual(R._apply_seguro_doc_type("boleto", ASSUNTO_CONTA_617), "boleto")
        self.assertEqual(R._apply_seguro_doc_type("boleto", None), "boleto")

    def test_idempotente(self):
        self.assertEqual(R._apply_seguro_doc_type("seguro", ASSUNTO_SURA), "seguro")


def _row(**over):
    row = {
        "source_file": "boleto.pdf",
        "document_type": "boleto",
        "barcode": "34191153400000133940990080201192400001500000",
        "amount": "133.94",
        "supplier_name": "SEGUROS SURA S/A",
        "invoice_number": "02.00993.0002011924.000015",
        "due_date": "2026-08-10",
        "extraction_source": "pdf_vision",
    }
    row.update(over)
    return row


class PdfPayloadSeguroTest(unittest.TestCase):
    """Camada build_financial_payload (caminho do PDF/link)."""

    def test_boleto_de_seguradora_vira_seguro(self):
        payload = R.build_financial_payload(
            _row(), "<msg-1082>", received_at="2026-07-25T14:39:52+00:00",
            subject=ASSUNTO_SURA)
        self.assertEqual(payload["document_type"], "seguro")

    def test_nao_reclassifica_rastreador_da_porto_seguro(self):
        # Anti-regressao da conta 617: mesmo fornecedor "PORTO SEGURO…", assunto sem
        # o termo → segue 'boleto'.
        payload = R.build_financial_payload(
            _row(supplier_name="PORTO SEGURO PROTECAO E MONITORAMENTO"),
            "<msg-982>", received_at="2026-07-21T01:31:30+00:00",
            subject=ASSUNTO_CONTA_617)
        self.assertEqual(payload["document_type"], "boleto")

    def test_numero_sintetico_usa_o_tipo_seguro(self):
        payload = R.build_financial_payload(
            _row(invoice_number=""), "<msg-1082>",
            received_at="2026-07-25T14:39:52+00:00", subject=ASSUNTO_SURA)
        self.assertTrue(payload["invoice_number"].startswith("seguro_"),
                        payload["invoice_number"])


if __name__ == "__main__":
    unittest.main()
