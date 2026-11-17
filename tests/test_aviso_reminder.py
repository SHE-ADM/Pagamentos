"""AVISO COMBINADO — "aviso" + qualificador que prova que nao ha divida nova e ignorado SEMPRE.

Caso de origem: conta 2499 (Smart Web, 16/11/2026). "Primeiro aviso de vencimento" reemitiu a
fatura 18689 da conta 2278 com juros e o Nº em outro formato; nenhuma impressao da dedup casou.

🔴 "aviso" SOZINHO nunca descarta: os assuntos legitimos abaixo foram a UNICA fonte de contas
PAGAS (medido em 2026-11-17 sobre os 3.579 e-mails de email_control).
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R  # noqa: E402

# ── Assuntos que NAO podem casar: cada um gerou conta legitima (id entre parenteses) ──
LEGITIMOS_REAIS = [
    "Aviso de vencimento",                                                    # PEGAMIL 3/181/261
    "Aviso de Vencimento: Boleto de cobranca emitido por COMPANHIA INDUSTRIAL CATAG",  # 5/18
    "Aviso de fatura a vencer - HB Transportes e Logística Ltda",            # 93
    "Aviso de Atraso Título 20107738626",                                     # 1792 (pago)
    "Aviso Automático - Nota Fiscal com Vencimento Próximo - NF: 489110 / RPS: 571854",  # 176
    "Boleto #18708 disponível para pagamento",
]


class AvisoCombinadoTest(unittest.TestCase):
    def test_reiteracao_ordinal_casa(self):
        for assunto in [
            "Primeiro aviso de vencimento — WHMCS-INVOICE-J1-18689",  # caso real (conta 2499)
            "Segundo aviso de vencimento — WHMCS-INVOICE-J1-18689",
            "Terceiro Aviso - Fatura 123",
            "ÚLTIMO AVISO: fatura em aberto",
            "1º aviso de cobrança",
            "2ª aviso fatura 555",
            "2o  aviso de vencimento",                                # espaco duplo do decode_str
            "Aviso final: 3 dias para salvar sua conta",
            "ENC: Primeiro aviso de vencimento",
            "Sexto aviso - fatura 77",
            "Décimo aviso de cobrança",
            "1.º aviso de cobrança",                                  # ordinal com ponto
            "2a. aviso fatura 555",
            "1ºaviso de vencimento",                                  # marcador colado na palavra
            "Último aviso: fatura em aberto",                    # NBSP nao cola as palavras
            "Aviso final",
        ]:
            self.assertTrue(R.subject_is_reminder(assunto), assunto)

    def test_aviso_pos_pagamento_casa(self):
        for assunto in [
            "Aviso de recebimento — Fatura 18689",
            "Aviso de Recebimento de pagamento",
            "Aviso de baixa do título 123",
            "Aviso de liquidação - boleto 99",
            "Aviso de quitação",
            "Aviso de crédito em conta",
            "Aviso de compensação do boleto",
        ]:
            self.assertTrue(R.subject_is_reminder(assunto), assunto)

    def test_legitimos_reais_nao_casam(self):
        for assunto in LEGITIMOS_REAIS:
            self.assertFalse(R.subject_is_reminder(assunto), assunto)

    def test_qualificadores_fora_de_proposito_nao_casam(self):
        for assunto in [
            "Aviso de pagamento",                # pode ser o envio do boleto
            "Aviso de débito 4455",              # nota de debito e pagavel
            "Aviso de fatura vencida",           # atraso ja foi unica fonte (1792)
            "Boleto vencimento dia 15 aviso",    # numero sem marcador ordinal
            "Fatura 18689 aviso de vencimento",  # numero longo nao e ordinal
            "Pedido 5 o aviso de vencimento",    # "o" separado do numero e artigo, nao ordinal
            "NF 12 a aviso",
            "NF12a aviso",                       # numero colado em palavra nao e ordinal
            "", None,
        ]:
            self.assertFalse(R.subject_is_reminder(assunto), assunto)

    def test_lembrete_segue_casando(self):
        self.assertTrue(R.subject_is_reminder("Lembrete de pagamento — Fatura WHMCS-INVOICE-J1-18708"))

    def test_sanidade_o_regex_casa_algo(self):
        # Anti-vacuidade: se o regex parar de casar, os negativos acima passariam por 0 === 0.
        self.assertIsNotNone(R._REMINDER_AVISO_RE.search("primeiro aviso de vencimento"))


def _header(uid, subject, sender):
    raw = (f"Subject: {subject}\r\nMessage-ID: <mid-{uid.decode()}>\r\nFrom: {sender}\r\n"
           "Date: Mon, 16 Nov 2026 10:00:00 -0300\r\n\r\n").encode("utf-8")
    return ("OK", [(uid + b' (INTERNALDATE "16-Nov-2026 10:00:00 -0300" BODY[HEADER])', raw)])


class RunReaderAvisoTest(unittest.TestCase):
    """Executa o CALL SITE: o aviso combinado e registrado 'ignorado' sem chegar a process_message."""

    def _run(self, emails):
        class Mail:
            def uid(self, cmd, uid, *a):
                return _header(uid, *emails[uid])

            def logout(self):
                pass

        ctrl = mock.MagicMock()
        ctrl._available = True
        ctrl.load_known_ids.return_value = {"<ja>"}
        process = mock.MagicMock()
        with mock.patch.object(R, "_connect_and_search", return_value=(Mail(), list(emails))), \
             mock.patch.object(R, "SupabaseControl", return_value=ctrl), \
             mock.patch.object(R, "process_message", process):
            R.run_reader(days=1)
        return ctrl, process

    def test_primeiro_aviso_e_ignorado_sem_extrair(self):
        ctrl, process = self._run({b"1": ("Primeiro aviso de vencimento - WHMCS-INVOICE-J1-18689",
                                          "boleto@smartwebservices.com.br")})
        process.assert_not_called()
        self.assertEqual(ctrl.register.call_args.args[0]["status"], "ignorado")

    def test_aviso_de_vencimento_segue_para_extracao(self):
        _, process = self._run({b"1": ("Aviso de vencimento", "boletoppf@itwconnect.onmicrosoft.com")})
        process.assert_called_once()


if __name__ == "__main__":
    unittest.main()
