"""
Testes do guard de LEMBRETE/CONFIRMACAO ENCAMINHADO no corpo (read_emails.py).

Contexto (caso real id 627): um e-mail interno reencaminha um lembrete externo
reescrevendo o assunto visivel ("pagamento Sua Fatura"), de modo que o "lembrete"
original so aparece no corpo como "Assunto: Lembrete Sua Fatura". As guardas do
run_reader olham so o assunto RECEBIDO, entao o lembrete escapava e a extracao do
corpo gerava uma conta indevida.

Cobre:
  - forwarded_subjects_from_body: extrai as linhas "Assunto:"/"Subject:" (com/sem ">").
  - body_forwards_ignorable_subject: dispara em lembrete/confirmacao encaminhados,
    e NAO dispara em fatura/nota encaminhada normal nem sem bloco encaminhado.
  - try_extract_from_body: retorna BODY_IGNORED (nao gera conta) para o corpo do 627.
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


class BodyForwardsIgnorableSubjectTest(unittest.TestCase):
    def test_lembrete_encaminhado_dispara(self):
        self.assertIsNotNone(read_emails.body_forwards_ignorable_subject(BODY_627))

    def test_confirmacao_encaminhada_dispara(self):
        body = "De: X\r\nAssunto: Comprovante de pagamento - fatura 987\r\n\r\ntexto\r\n"
        self.assertIsNotNone(read_emails.body_forwards_ignorable_subject(body))

    def test_fatura_normal_nao_dispara(self):
        self.assertIsNone(read_emails.body_forwards_ignorable_subject(BODY_FATURA_NORMAL))

    def test_sem_bloco_encaminhado_nao_dispara(self):
        self.assertIsNone(read_emails.body_forwards_ignorable_subject("Boleto vencimento 10/07 R$ 50,00"))


class TryExtractFromBodyGuardTest(unittest.TestCase):
    def test_corpo_627_vira_body_ignored_sem_tocar_ctrl(self):
        # O guard retorna ANTES de qualquer uso do ctrl → ctrl=None e seguro aqui.
        email_rec: dict = {"subject": "pagamento Sua Fatura"}
        outcome = read_emails.try_extract_from_body(
            email_rec, BODY_627, "2026-07-21", "<msg-627>", None,
            sender_email="eunice@otimotex.com.br",
        )
        self.assertEqual(outcome, read_emails.BODY_IGNORED)
        self.assertIn("Lembrete", email_rec["notes"])


if __name__ == "__main__":
    unittest.main()
