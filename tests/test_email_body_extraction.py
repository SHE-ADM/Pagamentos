"""
Testes de regressao para a extracao pelo corpo do e-mail (read_emails.py).

Cobre o bug em que notificacoes de NF-e/NFS-e (ex.: NFe da Editora Globo)
vazavam para financial_account_control como document_type='outro', porque o caminho de
corpo nao aplicava SKIP_ACCOUNT_TYPES nem a validacao de valor do caminho de PDF.
"""

import sys
import unittest
from pathlib import Path

# O modulo vive em skills/email-reader/scripts/ (diretorio com hifen — nao
# importavel como pacote). Adiciona o caminho ao sys.path, como server/app.py faz.
_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class FakeControl:
    """Stub de SupabaseControl — registra as chamadas em vez de tocar o banco."""

    def __init__(self):
        self.financial_calls = []
        self.error_calls = []
        self.duplicate = False  # simula documento ja existente em financial_account_control

    def register_financial(self, payload):
        self.financial_calls.append(payload)
        return True

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

    def unique_invoice_number(self, base):
        return base

    def financial_duplicate_exists(self, payload):
        return self.duplicate


# Corpo real (resumido) da notificacao de NF-e da Editora Globo S.A.
# Inclui a chave de acesso de 44 digitos — o que tornava o payload nao-nulo e
# fazia o registro vazar para financial_account_control antes da correcao.
NFE_BODY = (
    "A/C\nCHANG WON AHN,\n\n"
    "Voce esta recebendo, anexada a esta mensagem, a Nota Fiscal Eletronica "
    "numero 22427228, serie 2, emitida pela Editora Globo S.A.\n"
    "Junto com a mercadoria voce recebera tambem um DANFE correspondente a esta NF-e.\n"
    "Chave de acesso NFe 33260504067191000755550020224272281436319068"
)

NFSE_BODY = (
    "Prezado cliente,\n"
    "Segue a Nota Fiscal de Servico Eletronica referente ao mes vigente.\n"
    "NFS-e numero 12345."
)

PIX_BODY = (
    "Nome: Fornecedor Exemplo\n"
    "Valor: R$ 1.250,00\n"
    "Vencimento: 20/06/2026\n"
    "Chave Pix: exemplo@empresa.com.br"
)


class ClassifyBodyDocTypeTest(unittest.TestCase):
    def test_classifica_nfe(self):
        self.assertEqual(read_emails._classify_body_doc_type(NFE_BODY), "nfe")

    def test_classifica_nfse(self):
        # NFS-e (servico) deve ter precedencia sobre NF-e (mercadoria).
        self.assertEqual(read_emails._classify_body_doc_type(NFSE_BODY), "nfse")

    def test_corpo_sem_nota_fiscal_continua_outro(self):
        self.assertEqual(
            read_emails._classify_body_doc_type("Cobranca avulsa sem tipo definido"),
            "outro",
        )


class ExtractFromEmailBodyTest(unittest.TestCase):
    def test_nfe_e_classificada_como_nfe(self):
        payload = read_emails.extract_from_email_body(
            NFE_BODY, "2026-06-10T14:23:39+00:00", "<msg-nfe>", "nfe@edglobo.com.br"
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["document_type"], "nfe")


class TryExtractFromBodyTest(unittest.TestCase):
    def test_nfe_nao_gera_conta_a_pagar(self):
        """Regressao do bug: NF-e nao pode ser gravada em financial_account_control."""
        ctrl = FakeControl()
        gravou = read_emails.try_extract_from_body(
            {"message_id": "<msg-nfe>"}, NFE_BODY,
            "2026-06-10T14:23:39+00:00", "<msg-nfe>", ctrl,
            sender_email="nfe@edglobo.com.br",
        )
        self.assertFalse(gravou)
        self.assertEqual(ctrl.financial_calls, [])  # nada gravado
        self.assertEqual(ctrl.error_calls, [])      # skip silencioso, nao e erro

    def test_corpo_sem_valor_registra_erro_e_nao_grava(self):
        ctrl = FakeControl()
        # Corpo com numero de documento (sinal financeiro) mas sem valor R$.
        body = "Fatura n. 9876 referente ao servico prestado."
        gravou = read_emails.try_extract_from_body(
            {"message_id": "<msg-sem-valor>"}, body,
            "2026-06-10T00:00:00+00:00", "<msg-sem-valor>", ctrl,
        )
        self.assertFalse(gravou)
        self.assertEqual(ctrl.financial_calls, [])
        self.assertEqual(len(ctrl.error_calls), 1)
        self.assertEqual(ctrl.error_calls[0][0], "sem_valor")

    def test_pedido_pix_legitimo_continua_gravando(self):
        """Garante que a correcao nao quebrou o caminho feliz (pagamento PIX)."""
        ctrl = FakeControl()
        gravou = read_emails.try_extract_from_body(
            {"message_id": "<msg-pix>"}, PIX_BODY,
            "2026-06-10T00:00:00+00:00", "<msg-pix>", ctrl,
        )
        self.assertTrue(gravou)
        self.assertEqual(len(ctrl.financial_calls), 1)
        self.assertEqual(ctrl.financial_calls[0]["payment_method"], "pix")
        self.assertEqual(ctrl.error_calls, [])

    def test_documento_duplicado_e_ignorado(self):
        """Conteudo ja existente no banco (remetente reenviou) nao grava de novo."""
        ctrl = FakeControl()
        ctrl.duplicate = True  # financial_duplicate_exists -> True
        gravou = read_emails.try_extract_from_body(
            {"message_id": "<msg-pix-2>"}, PIX_BODY,
            "2026-06-10T00:00:00+00:00", "<msg-pix-2>", ctrl,
        )
        self.assertFalse(gravou)
        self.assertEqual(ctrl.financial_calls, [])  # nada gravado
        self.assertEqual(ctrl.error_calls, [])      # duplicata e skip, nao erro


if __name__ == "__main__":
    unittest.main()
