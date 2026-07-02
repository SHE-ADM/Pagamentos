"""
Testes da resolucao de fornecedor pelo REMETENTE no caminho de PDF
(extract_and_store_accounts, read_emails.py).

Regra: quando o PDF nao traz CNPJ/CPF/nome do fornecedor, o e-mail do remetente
e chave valida — a RPC resolve_supplier_for_account casa por e-mail (passo 3,
email/2/3/4) ou cria o fornecedor a partir dele. So vira erro 'sem_fornecedor'
quando NAO ha identificador algum (nem cnpj, cpf, nome, nem sender_email),
espelhando a guarda da propria RPC e o comportamento do caminho de corpo.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

# O modulo vive em skills/email-reader/scripts/ (diretorio com hifen — nao
# importavel como pacote). Adiciona o caminho ao sys.path, como server/app.py faz.
_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


def _make_ctrl(resolved_sk=249):
    """SupabaseControl falso cobrindo so os metodos usados no caminho de PDF."""
    ctrl = mock.MagicMock()
    ctrl._available = True
    ctrl.resolve_supplier.return_value = resolved_sk
    ctrl.supplier_defaults.return_value = (0, 0)
    ctrl.find_financial_duplicate.return_value = None
    ctrl.unique_invoice_number.side_effect = lambda n: n
    ctrl.register_financial.return_value = True
    return ctrl


class ExtractAndStoreSupplierFromSenderTest(unittest.TestCase):
    """Validacao 2 (sem_fornecedor) passa a considerar o sender_email."""

    def setUp(self):
        # Isola a leitura de CSV e a montagem do payload — o foco e a validacao 2.
        self._run = mock.patch.object(
            read_emails, "run_extraction", return_value=("fake.csv", None)
        ).start()
        # Uma linha extraida sem nenhum identificador de fornecedor, com valor.
        self._rows = mock.patch.object(
            read_emails, "read_extracted_rows",
            return_value=[{"source_file": "boleto.pdf", "document_type": "boleto"}],
        ).start()
        # Payload sem supplier_*, mas com amount (passa a validacao de valor).
        self._payload = mock.patch.object(
            read_emails, "build_financial_payload",
            return_value={"amount": 100.0},
        ).start()
        self.addCleanup(mock.patch.stopall)

    def _run_store(self, sender_email):
        ctrl = _make_ctrl()
        email_rec = {
            "received_at":  "2026-06-23T00:00:00",
            "sender_email": sender_email,
            "subject":      "Boleto",
        }
        _, accounts_saved, _nonpayable = read_emails.extract_and_store_accounts(
            [Path("boleto.pdf")], "msg-1", ctrl, email_rec=email_rec
        )
        return ctrl, accounts_saved

    def test_sem_id_mas_com_remetente_resolve_e_grava(self):
        """Sem CNPJ/CPF/nome, mas com sender_email → resolve pelo e-mail e grava."""
        ctrl, accounts_saved = self._run_store("nao-responder@info.ober.com.br")

        # Nao registrou 'sem_fornecedor'
        error_types = [c.args[1] for c in ctrl.register_error.call_args_list]
        self.assertNotIn("sem_fornecedor", error_types)
        # Resolveu o fornecedor pela RPC (que recebe sender_email) e gravou a conta
        ctrl.resolve_supplier.assert_called_once()
        ctrl.register_financial.assert_called_once()
        self.assertEqual(accounts_saved, 1)

    def test_sem_id_e_sem_remetente_vira_sem_fornecedor(self):
        """Sem CNPJ/CPF/nome e sem sender_email → erro 'sem_fornecedor', nao grava."""
        ctrl, accounts_saved = self._run_store(None)

        error_types = [c.args[1] for c in ctrl.register_error.call_args_list]
        self.assertIn("sem_fornecedor", error_types)
        ctrl.register_financial.assert_not_called()
        self.assertEqual(accounts_saved, 0)


if __name__ == "__main__":
    unittest.main()
