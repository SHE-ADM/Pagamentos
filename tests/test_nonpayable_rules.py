"""
Testes das regras PERMANENTES que impedem que documentos NAO-pagaveis caiam em
/erros (read_emails.py). Cobrem:

  - subject_is_ignorable_notification: "Aviso de fatura a vencer" → ignorado.
  - _is_receivable_notice: baixa/cobranca de RECEBIVEL proprio (titulo que a
    empresa EMITIU) nao e conta a pagar.
  - _is_nonpayable_visual: imagem de assinatura/logo de e-mail ou apresentacao de
    marketing (sem valor, sem boleto) nao e conta a pagar; recibo/boleto legitimo
    (com valor ou linha digitavel) NAO cai na regra.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

# Boleto bancario real (44 digitos, moeda '9') — usado para provar que a regra
# visual NAO dispara quando ha linha digitavel.
_BOLETO_BARCODE = "34191150100000795001097308595621248093807000"


class AvisoFaturaVencerTest(unittest.TestCase):
    def test_aviso_de_fatura_a_vencer_e_notificacao(self):
        self.assertTrue(R.subject_is_ignorable_notification(
            "Aviso de fatura a vencer - HB Transportes e Logística Ltda"))

    def test_boleto_real_com_vencimento_nao_e_notificacao(self):
        # "vencimento" sozinho nao pode virar notificacao (pode ser boleto real).
        self.assertFalse(R.subject_is_ignorable_notification(
            "Boleto XPTO vencimento 10/07"))


class TransportNotificationTest(unittest.TestCase):
    """CT-e/transporte SEM boleto (notificacao de disponibilizacao ou ocorrencia de
    entrega) → 'ignorado'. Um boleto de transporte real gera conta antes, entao nao
    e escondido por estes termos."""

    def test_conhecimento_de_transporte_disponivel(self):
        self.assertTrue(R.subject_is_ignorable_notification(
            "Arquivos de Conhecimento de Transporte Eletronico (1-1/1)"))

    def test_ocorrencia_cte_entrega(self):
        self.assertTrue(R.subject_is_ignorable_notification(
            "OCORRENCIA CTE 699089 P 207 NF 241733 ENTREGA REALIZADA COM FALTA"))

    def test_dacte(self):
        self.assertTrue(R.subject_is_ignorable_notification("Envio de DACTE"))

    def test_palavra_comum_com_cte_nao_casa(self):
        # 'cte' e casado como PALAVRA inteira — nao dispara dentro de outra palavra.
        self.assertFalse(R.subject_is_ignorable_notification(
            "Boleto do projeto arquitetonico"))


class ReceivableNoticeTest(unittest.TestCase):
    def test_assunto_cobranca_otimotex(self):
        self.assertTrue(R._is_receivable_notice("RES: COBRANÇA OTIMOTEX TECIDO", None))

    def test_assunto_cobrancas_nao_enviadas(self):
        self.assertTrue(R._is_receivable_notice(
            "RES: Cobranças não enviadas — ação necessária (1 título)", None))

    def test_descricao_cancelamento_baixa(self):
        desc = ("Cancelamento (Baixa) de 3 boletos. Boleto 109/00227094 venc. "
                "05/06/2026 R$ 855,40. Operacao realizada em 29/05/2026 11:59.")
        self.assertTrue(R._is_receivable_notice("Assunto qualquer", desc))

    def test_conta_a_pagar_normal_nao_casa(self):
        self.assertFalse(R._is_receivable_notice(
            "Boleto fornecedor XPTO NF 123", "Boleto referente a NF 123 do fornecedor."))


class NonpayableVisualTest(unittest.TestCase):
    def test_assinatura_de_email_sem_valor(self):
        row = {"amount": "0.0", "barcode": "",
               "description": "Assinatura de e-mail comercial de Rose Rocha - Otimotex."}
        self.assertTrue(R._is_nonpayable_visual(row))

    def test_apresentacao_marketing_sem_valor(self):
        row = {"amount": "0.0", "barcode": "",
               "description": "Apresentação institucional da GNW Business Solutions Ltda."}
        self.assertTrue(R._is_nonpayable_visual(row))

    def test_recibo_com_valor_nao_e_suprimido(self):
        # Documento legitimo tem valor → nao cai na regra, mesmo com texto ambiguo.
        row = {"amount": "172.39", "barcode": "",
               "description": "Assinatura de e-mail comercial / recibo de postagem."}
        self.assertFalse(R._is_nonpayable_visual(row))

    def test_boleto_com_barcode_nao_e_suprimido(self):
        # Linha digitavel presente → e documento pagavel, ignora o texto da descricao.
        row = {"amount": "0.0", "barcode": _BOLETO_BARCODE,
               "description": "logotipo da empresa"}
        self.assertFalse(R._is_nonpayable_visual(row))

    def test_descricao_neutra_nao_casa(self):
        row = {"amount": "0.0", "barcode": "",
               "description": "Boleto de cobranca referente a NF 987."}
        self.assertFalse(R._is_nonpayable_visual(row))


if __name__ == "__main__":
    unittest.main()
