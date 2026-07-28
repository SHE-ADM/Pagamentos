"""
Regra de SEGURADORA no caminho do CORPO (try_extract_from_body).

E-mail de seguradora so vira conta a pagar com BOLETO de linha digitavel valida:

  - corpo SEM sinal financeiro (caso da SURA, que so anuncia "Clique aqui para baixar
    o documento") → BODY_IGNORED, ou seja 'ignorado' em vez de 'falha'. E o desfecho
    quando o download do boleto por link nao acontece (rede/portal fora do ar);
  - corpo COM valor mas SEM linha digitavel → BODY_IGNORED (nao e pagavel pela regra);
  - corpo COM linha digitavel valida → BODY_CREATED (ha boleto valido) e a conta sai
    rotulada document_type='seguro'.

Anti-regressao: o contexto e detectado SO PELO ASSUNTO. A conta 58 nasceu exatamente
deste caminho (Porto Seguro "Rastreador", sem barcode) — se a deteccao usasse o
remetente/fornecedor, ela deixaria de existir.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

ASSUNTO_SURA = "SEGUROS SURA VID_G_002_930_2011924_15"
ASSUNTO_RASTREADOR = "Rastreador - Demonstrativo fatura - 06/2026"   # conta 58
BOLETO_REAL = "23797150300020100800165090000000182600836500"

# Corpo real da SURA (so anuncia os documentos por link — sem valor nem numero).
BODY_SURA = (
    "Para garantir a maxima qualidade no atendimento e eficiencia nos processos de "
    "cotacao e emissao de apolices, a Seguros SURA disponibilizara a sua apolice em "
    "formato eletronico agora.\r\n"
    "  - Boleto\r\n  Clique aqui para baixar o documento\r\n"
    "  - Conjunto Faturamento\r\n  Clique aqui para baixar o documento\r\n"
)

BODY_COM_VALOR = (
    "Prezados, segue a cobranca.\r\n"
    "Fornecedor: SEGUROS SURA S/A\r\n"
    "Vencimento: 10/08/2026\r\n"
    "Valor: R$ 133,94\r\n"
)

BODY_COM_LINHA_DIGITAVEL = BODY_COM_VALOR + f"Linha digitavel: {BOLETO_REAL}\r\n"

BODY_RASTREADOR = (
    "Segue o demonstrativo do rastreador.\r\n"
    "Fornecedor: PORTO SEGURO PROTECAO E MONITORAMENTO\r\n"
    "Vencimento: 06/07/2026\r\n"
    "Valor: R$ 987,66\r\n"
)


class FakeCtrl:
    """ctrl minimo para try_extract_from_body — sem rede."""

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
        self.registered_payloads.append(payload)
        return len(self.registered_payloads)


def _run(subject, body):
    ctrl = FakeCtrl()
    rec = {"subject": subject}
    outcome = R.try_extract_from_body(
        rec, body, "2026-07-25T14:39:52+00:00", "<msg-1082>", ctrl,
        sender_email="noreply@segurossuradireto.com.br")
    return outcome, rec, ctrl


class SeguradoraBodyTest(unittest.TestCase):
    def test_corpo_sem_sinal_financeiro_vira_ignorado(self):
        outcome, rec, ctrl = _run(ASSUNTO_SURA, BODY_SURA)
        self.assertEqual(outcome, R.BODY_IGNORED)      # → 'ignorado', nao 'falha'
        self.assertEqual(ctrl.registered_payloads, [])
        self.assertIn("seguradora", rec["notes"].lower())

    def test_corpo_com_valor_mas_sem_linha_digitavel_vira_ignorado(self):
        outcome, _, ctrl = _run(ASSUNTO_SURA, BODY_COM_VALOR)
        self.assertEqual(outcome, R.BODY_IGNORED)
        self.assertEqual(ctrl.registered_payloads, [])

    def test_corpo_com_linha_digitavel_valida_gera_conta_seguro(self):
        # Ha boleto valido → a conta EXISTE (a guarda nao pode ser um bloqueio cego
        # de todo e-mail de seguradora) e sai rotulada 'seguro'.
        outcome, _, ctrl = _run(ASSUNTO_SURA, BODY_COM_LINHA_DIGITAVEL)
        self.assertEqual(outcome, R.BODY_CREATED)
        self.assertEqual(len(ctrl.registered_payloads), 1)
        payload = ctrl.registered_payloads[0]
        self.assertEqual(payload["barcode"], BOLETO_REAL)
        self.assertEqual(payload["document_type"], "seguro")


class NaoRegredirContasExistentesTest(unittest.TestCase):
    def test_rastreador_da_porto_seguro_continua_gerando_conta(self):
        # Anti-regressao da conta 58: assunto SEM o termo → nao e contexto de
        # seguradora, mesmo com "PORTO SEGURO" no fornecedor e no remetente.
        outcome, _, ctrl = _run(ASSUNTO_RASTREADOR, BODY_RASTREADOR)
        self.assertEqual(outcome, R.BODY_CREATED)
        self.assertEqual(len(ctrl.registered_payloads), 1)

    def test_corpo_sem_sinal_e_assunto_comum_mantem_a_nota_historica(self):
        # A string e usada nos relatorios/`/erros` — nao pode mudar para quem nao e
        # seguradora.
        outcome, rec, _ = _run("Cobranca mensal", BODY_SURA)
        self.assertEqual(outcome, R.BODY_NONE)
        self.assertEqual(rec["notes"],
                         "Corpo sem sinal financeiro (sem valor nem documento)")


if __name__ == "__main__":
    unittest.main()
