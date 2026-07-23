"""
Testes do guard de CONFIRMACAO DE PAGAMENTO ENCAMINHADA no corpo (read_emails.py).

Contexto (caso real id 627, 2026-07-22): um e-mail interno reencaminha um lembrete
externo reescrevendo o assunto visivel ("pagamento Sua Fatura"), de modo que o
"lembrete" original so aparece no corpo como "Assunto: Lembrete Sua Fatura". As
guardas do run_reader olham so o assunto RECEBIDO, entao o lembrete escapava e a
extracao do corpo gerava uma conta (id 627), hard-deletada apos o fix.

Revisado em 2026-07-23 (caso real id 668/e-mail 1004): o guard original bloqueava
INCONDICIONALMENTE qualquer lembrete encaminhado — mas um lembrete/aviso de
disponibilidade de fatura PODE ser a UNICA fonte de uma fatura ainda nao registrada
em nenhum outro canal (Contabil Esquema, fatura Nº 20879, R$ 2.950,00, vencendo em
2 dias, sem NENHUMA conta correspondente — perdida silenciosamente pelo guard
antigo). Por isso o guard foi restrito a CONFIRMACAO DE PAGAMENTO (nunca um pagavel,
com ou sem duplicata) — 'lembrete' encaminhado agora segue a extracao normal do
corpo, e reenvios PERIODICOS do MESMO lembrete sao suprimidos pela dedup de
conteudo (find_financial_duplicate), nao por este guard.

Cobre:
  - forwarded_subjects_from_body: extrai as linhas "Assunto:"/"Subject:" (com/sem ">").
  - body_forwards_payment_confirmation: dispara so em CONFIRMACAO encaminhada; NAO
    dispara para lembrete encaminhado nem para fatura/nota encaminhada normal.
  - try_extract_from_body: lembrete encaminhado (627) segue extraindo/gravando
    normalmente; confirmacao encaminhada continua BODY_IGNORED.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Corpo real (reconstruido) do e-mail que gerou a conta 627: encaminhamento interno
# cujo assunto ORIGINAL e um lembrete de disponibilidade de fatura.
BODY_627 = (
    "De: Contabil Esquema LTDA <lembrete@contabilesquema.com.br>\r\n"
    "Enviada em: terca-feira, 21 de julho de 2026 09:46\r\n"
    "Para: nelson@otimotex.com.br\r\n"
    "Assunto: Lembrete Sua Fatura\r\n"
    "\r\n"
    "Lembrete - Sua Fatura\r\n"
    "Este e um aviso de disponibilidade de fatura\r\n"
    "Para: TEXTIL E CONFECCOES OTIMOTEX LTDA\r\n"
    "Documento: 47.273.917/0001-23\r\n"
    "Fornecedor: Contabil Esquema LTDA\r\n"
    "Valor: R$ 22.655,00  Vencimento: 24/07/2026\r\n"
)

# Fatura encaminhada NORMAL (assunto original nao e lembrete/confirmacao) — nao deve
# ser bloqueada pelo guard; a extracao segue seu curso.
BODY_FATURA_NORMAL = (
    "De: Fornecedor XYZ <financeiro@xyz.com.br>\r\n"
    "Enviada em: 21 de julho de 2026\r\n"
    "Assunto: Fatura 12345 - vencimento 24/07\r\n"
    "\r\n"
    "Segue a fatura. Valor: R$ 1.000,00  Vencimento: 24/07/2026\r\n"
)


class ForwardedSubjectExtractionTest(unittest.TestCase):
    def test_extrai_assunto_encaminhado(self):
        self.assertEqual(
            read_emails.forwarded_subjects_from_body(BODY_627),
            ["Lembrete Sua Fatura"],
        )

    def test_ignora_marcador_de_citacao_e_subject_ingles(self):
        body = "> Subject: Payment reminder\r\ntexto qualquer\r\n"
        self.assertEqual(read_emails.forwarded_subjects_from_body(body), ["Payment reminder"])

    def test_corpo_vazio_ou_sem_assunto(self):
        self.assertEqual(read_emails.forwarded_subjects_from_body(None), [])
        self.assertEqual(read_emails.forwarded_subjects_from_body("corpo sem cabecalho"), [])


class BodyForwardsPaymentConfirmationTest(unittest.TestCase):
    def test_lembrete_encaminhado_NAO_dispara(self):
        # Revisao 2026-07-23 (caso 668): lembrete encaminhado NAO e mais bloqueado
        # incondicionalmente — pode ser a unica fonte de uma fatura real.
        self.assertIsNone(read_emails.body_forwards_payment_confirmation(BODY_627))

    def test_confirmacao_encaminhada_dispara(self):
        body = "De: X\r\nAssunto: Comprovante de pagamento - fatura 987\r\n\r\ntexto\r\n"
        self.assertIsNotNone(read_emails.body_forwards_payment_confirmation(body))

    def test_fatura_normal_nao_dispara(self):
        self.assertIsNone(read_emails.body_forwards_payment_confirmation(BODY_FATURA_NORMAL))

    def test_sem_bloco_encaminhado_nao_dispara(self):
        self.assertIsNone(
            read_emails.body_forwards_payment_confirmation("Boleto vencimento 10/07 R$ 50,00")
        )


class _FakeCtrl:
    """ctrl minimo para try_extract_from_body — sem rede (espelha tests/test_body_duplicate.py)."""

    def __init__(self, dup=None, registered=True):
        self._dup = dup
        self._registered = registered
        self.registered_payloads = []

    def find_financial_duplicate(self, payload):
        return self._dup

    def resolve_supplier(self, payload):
        return 1052  # sk_supplier fictício (CONTABIL ESQUEMA)

    def supplier_defaults(self, sk_supplier):
        return (0, 0)

    def unique_invoice_number(self, n):
        return n

    def register_financial(self, payload):
        self.registered_payloads.append(payload)
        return self._registered


class TryExtractFromBodyGuardTest(unittest.TestCase):
    def test_lembrete_encaminhado_gera_conta_quando_nao_e_duplicata(self):
        # Revisao 2026-07-23 (caso 668/e-mail 1004): lembrete encaminhado sem
        # duplicata correspondente AGORA gera conta (BODY_CREATED), nao mais
        # BODY_IGNORED — a fatura seria perdida silenciosamente.
        ctrl = _FakeCtrl(dup=None, registered=True)
        email_rec: dict = {"subject": "pagamento Sua Fatura"}
        outcome = read_emails.try_extract_from_body(
            email_rec, BODY_627, "2026-07-21T12:00:00+00:00", "<msg-627>", ctrl,
            sender_email="eunice@otimotex.com.br",
        )
        self.assertEqual(outcome, read_emails.BODY_CREATED)
        self.assertEqual(len(ctrl.registered_payloads), 1)

    def test_lembrete_encaminhado_repetido_vira_duplicata(self):
        # Reenvio periodico do MESMO lembrete: a dedup de conteudo (nao mais este
        # guard) suprime a recriacao — BODY_DUPLICATE, nao BODY_CREATED.
        ctrl = _FakeCtrl(dup={"id": 668}, registered=True)
        email_rec: dict = {"subject": "pagamento Sua Fatura"}
        outcome = read_emails.try_extract_from_body(
            email_rec, BODY_627, "2026-07-21T12:00:00+00:00", "<msg-627-dup>", ctrl,
            sender_email="eunice@otimotex.com.br",
        )
        self.assertEqual(outcome, read_emails.BODY_DUPLICATE)
        self.assertEqual(email_rec.get("duplicate_of"), 668)
        self.assertEqual(ctrl.registered_payloads, [])

    def test_confirmacao_encaminhada_vira_body_ignored_sem_tocar_ctrl(self):
        # O guard de confirmacao retorna ANTES de qualquer uso do ctrl → ctrl=None
        # e seguro aqui (unico caso que permanece um hard-stop incondicional).
        body = (
            "De: Fornecedor XYZ <financeiro@xyz.com.br>\r\n"
            "Assunto: Comprovante de pagamento - fatura 987\r\n\r\n"
            "Pagamento confirmado. Valor: R$ 500,00\r\n"
        )
        email_rec: dict = {"subject": "pagamento fatura 987"}
        outcome = read_emails.try_extract_from_body(
            email_rec, body, "2026-07-21", "<msg-conf>", None,
            sender_email="eunice@otimotex.com.br",
        )
        self.assertEqual(outcome, read_emails.BODY_IGNORED)
        self.assertIn("Confirmacao", email_rec["notes"])


if __name__ == "__main__":
    unittest.main()
