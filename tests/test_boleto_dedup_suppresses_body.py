"""
Regra "o boleto sempre vence o corpo" — cobre a lacuna do dedup (id 510):

Um boleto ANEXADO que casa uma conta JA existente (mesmo documento chegado por
outro e-mail) e tratado por dedup e NAO gera conta nova (accounts_saved == 0).
Antes, o gate do corpo usava so accounts_saved, entao o fallback do corpo rodava
e criava uma conta ESPURIA com dados divergentes (ex.: vencimento lido do texto do
corpo, sem o barcode) — foi o que gerou id 510 (OBER, venc. 11/07) duplicando o
boleto id 159 (venc. 18/07 pelo fator do codigo de barras).

`extract_and_store_accounts` agora retorna `attachment_account` = True tambem quando
o boleto casa por dedup; `process_message` so roda o corpo quando ele e False.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Codigo de barras real do id 159 (OBER, R$ 5.576,66, Itau 341, fator 1511 = 18/07/2026).
BOLETO_OBER = "34199151100005576661122536149631295445629000"

REC = {
    "received_at":  "2026-07-11T04:48:31+00:00",
    "subject":      "OPHIR FUNDO DE INVEST EM DIR. CRED. - Confirmacao de Recebimento de Boletos - OBER",
    "sender_email": "controladoria@ophir.com.br",
}


class FakeControl:
    """Stub de SupabaseControl com dedup configuravel."""

    def __init__(self, dup=None):
        self.financial_calls = []
        self.attachment_calls = []
        self.error_calls = []
        self.update_calls = []
        self.update_nullable = []
        self._dup = dup

    def upload_attachment(self, pdf_path):
        return True

    def company_cnpj(self):
        return None

    def register_financial(self, payload):
        self.financial_calls.append(payload)
        return len(self.financial_calls)  # id da conta (migration 079) — truthy, como o real

    def register_attachment(self, account_id, file_name, size_bytes=0, uploaded_by=None):
        self.attachment_calls.append((account_id, file_name))
        return True

    def resolve_user(self, sender_email):
        # Dono da conta pelo remetente (migration 076) — o anexo do pipeline o herda.
        return f"uuid-de-{sender_email}" if sender_email else None

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

    def unique_invoice_number(self, base):
        return base

    def find_financial_duplicate(self, payload):
        return self._dup

    def resolve_supplier(self, payload):
        return 249  # OBER

    def supplier_defaults(self, sk_supplier):
        return (0, 0)

    def update_financial(self, dup_id, patch, nullable=()):
        self.update_calls.append((dup_id, patch))
        self.update_nullable.append(tuple(nullable))
        return True


def _boleto_row():
    return {
        "source_file": "boleto_ober.pdf",
        "document_type": "boleto",
        "barcode": BOLETO_OBER,
        "amount": "5576.66",
        "supplier_name": "OBER SA INDUSTRIA E COMERCIO",
        "invoice_number": "112/25361496-3",
        "due_date": "2026-07-18",
        "extraction_source": "pdf_text",
    }


def _nfe_row():
    return {
        "source_file": "nota.pdf",
        "document_type": "nfe",
        "barcode": "",
        "amount": "1000.00",
        "supplier_name": "FORNEC X",
        "invoice_number": "",
        "due_date": "2026-07-18",
        "extraction_source": "pdf_text",
    }


def _run(ctrl, row):
    saved = [Path(row["source_file"])]

    def fake_run_extraction(pdf_path, pdf_passwords=None):
        return (pdf_path.name, None)

    def fake_read_rows(csv_path):
        return [row]

    with patch.object(read_emails, "run_extraction", fake_run_extraction), \
         patch.object(read_emails, "read_extracted_rows", fake_read_rows):
        return read_emails.extract_and_store_accounts(saved, "<MID>", ctrl, email_rec=dict(REC))


class BoletoDedupSuppressesBodyTest(unittest.TestCase):
    def test_boleto_deduplicado_sinaliza_conta_do_anexo(self):
        # Boleto casa conta existente (mesmo vencimento) → dedup "mantido" → nenhuma
        # conta nova, mas attachment_account True (corpo NAO deve rodar).
        ctrl = FakeControl(dup={"id": 159, "due_date": "2026-07-18"})
        _csvs, accounts_saved, _nonpayable, attachment_account = _run(ctrl, _boleto_row())
        self.assertEqual(accounts_saved, 0)
        self.assertTrue(attachment_account)
        self.assertEqual(ctrl.financial_calls, [])   # nao gravou conta nova
        # O PDF ja foi upado no Passo 1 (Storage); dedup sem vincular o anexo a conta
        # existente deixava o comprovante ausente em silencio (achado real: contas
        # 1238/1239/1240 do fornecedor ALKO, dedup em 28/08 sem anexo registrado).
        self.assertEqual(ctrl.attachment_calls, [(159, "boleto_ober.pdf")])

    def test_reemissao_atualiza_e_sinaliza_conta_do_anexo(self):
        # Boleto com vencimento mais novo → atualiza a conta existente; ainda conta
        # do anexo (attachment_account True).
        ctrl = FakeControl(dup={"id": 159, "due_date": "2026-07-01"})
        _csvs, accounts_saved, _nonpayable, attachment_account = _run(ctrl, _boleto_row())
        self.assertEqual(accounts_saved, 0)
        self.assertTrue(attachment_account)
        self.assertEqual(len(ctrl.update_calls), 1)   # atualizou o vencimento
        self.assertEqual(ctrl.attachment_calls, [(159, "boleto_ober.pdf")])

    def test_boleto_enriquece_conta_existente_sem_barcode(self):
        # dup do corpo SEM barcode + vencimento igual → o boleto grava a linha
        # digitavel na conta existente (o boleto vence o corpo), sem duplicar.
        ctrl = FakeControl(dup={"id": 159, "due_date": "2026-07-18", "barcode": None})
        _csvs, accounts_saved, _nonpayable, attachment_account = _run(ctrl, _boleto_row())
        self.assertEqual(accounts_saved, 0)
        self.assertTrue(attachment_account)
        self.assertEqual(len(ctrl.update_calls), 1)
        dup_id, patch = ctrl.update_calls[0]
        self.assertEqual(dup_id, 159)
        self.assertEqual(patch.get("barcode"), BOLETO_OBER)
        self.assertNotIn("processing_notes", patch, "nota sem marca de presumido não é tocada")
        self.assertEqual(ctrl.attachment_calls, [(159, "boleto_ober.pdf")])

    def test_reemissao_em_conta_presumida_retira_a_marca(self):
        # Conta do CORPO com vencimento PRESUMIDO: o boleto traz a data do documento. A marca tem
        # de sair, senão um lembrete posterior moveria um vencimento lido (apply_due_date_reminder).
        notas = f"{read_emails.DUE_DATE_PRESUMED_NOTE} | Outra nota"
        ctrl = FakeControl(dup={"id": 159, "due_date": "2026-07-01", "processing_notes": notas})
        _run(ctrl, _boleto_row())
        (dup_id, campos), = ctrl.update_calls
        self.assertEqual((dup_id, campos["due_date"]), (159, "2026-07-18"))
        self.assertEqual(campos["processing_notes"], "Outra nota")
        # Mesmo call site da marca que vira None: o campo vai declarado anulável.
        self.assertEqual(ctrl.update_nullable, [("processing_notes",)])

    def test_boleto_que_enriquece_conta_presumida_retira_a_marca(self):
        ctrl = FakeControl(dup={"id": 159, "due_date": "2026-07-18", "barcode": None,
                                "processing_notes": read_emails.DUE_DATE_PRESUMED_NOTE})
        _run(ctrl, _boleto_row())
        (dup_id, campos), = ctrl.update_calls
        self.assertEqual((dup_id, campos.get("barcode")), (159, BOLETO_OBER))
        self.assertIsNone(campos["processing_notes"])
        # 🔴 O None só chega ao banco se declarado anulável — update_financial DESCARTA None
        # (ver test_update_financial_envia_null_so_para_campo_anulavel, que executa o filtro real).
        self.assertEqual(ctrl.update_nullable, [("processing_notes",)])

    def test_boleto_nao_reescreve_barcode_de_conta_existente(self):
        # dup já COM barcode e vencimento igual → nada a fazer (não sobrescreve
        # o boleto existente nem duplica) — mas o anexo ainda e vinculado.
        ctrl = FakeControl(dup={"id": 159, "due_date": "2026-07-18", "barcode": "JA_TEM"})
        _csvs, accounts_saved, _nonpayable, attachment_account = _run(ctrl, _boleto_row())
        self.assertEqual(accounts_saved, 0)
        self.assertTrue(attachment_account)
        self.assertEqual(ctrl.update_calls, [])
        self.assertEqual(ctrl.attachment_calls, [(159, "boleto_ober.pdf")])

    def test_boleto_novo_tambem_sinaliza_conta_do_anexo(self):
        # Sem dedup: grava conta nova → attachment_account True.
        ctrl = FakeControl(dup=None)
        _csvs, accounts_saved, _nonpayable, attachment_account = _run(ctrl, _boleto_row())
        self.assertEqual(accounts_saved, 1)
        self.assertTrue(attachment_account)

    def test_anexo_sem_pagavel_nao_sinaliza_conta_do_anexo(self):
        # NF-e (SKIP) — nenhum pagavel do anexo → attachment_account False (corpo pode rodar).
        ctrl = FakeControl(dup=None)
        _csvs, accounts_saved, _nonpayable, attachment_account = _run(ctrl, _nfe_row())
        self.assertEqual(accounts_saved, 0)
        self.assertFalse(attachment_account)


class DedupSelectTrazAsNotasTest(unittest.TestCase):
    """🔴 Sem `processing_notes` no SELECT da dedup, a conta devolvida nunca traz a marca de
    vencimento presumido e a retirada acima fica INERTE em produção — o FakeControl não o vê."""

    def test_toda_consulta_da_dedup_seleciona_processing_notes(self):
        ctrl = read_emails.SupabaseControl.__new__(read_emails.SupabaseControl)
        ctrl.base, ctrl.headers, ctrl._available = "https://x", {}, True
        resposta = MagicMock()
        resposta.read.return_value = b"[]"
        cm = MagicMock()
        cm.__enter__.return_value = resposta
        payload = {"barcode": BOLETO_OBER, "sk_supplier": 249, "nosso_numero": "25361496",
                   "amount": "5576.66", "due_date": "2026-07-18"}
        with patch.object(read_emails.urllib.request, "urlopen", return_value=cm) as m:
            self.assertIsNone(read_emails.SupabaseControl.find_financial_duplicate(ctrl, payload))
        urls = [c.args[0].full_url for c in m.call_args_list]
        # Sanidade: barcode, nosso número e valor+vencimento — as três consultas exercitadas.
        self.assertEqual(len(urls), 3, urls)
        for url in urls:
            self.assertRegex(url, r"select=[^&]*processing_notes")

    def test_update_financial_envia_null_so_para_campo_anulavel(self):
        # A marca que era a ÚNICA nota vira None; sem `nullable` o filtro real a descartaria e
        # o PATCH sairia sem processing_notes — a marca ficaria na conta, sem erro nenhum.
        ctrl = read_emails.SupabaseControl.__new__(read_emails.SupabaseControl)
        ctrl.base, ctrl.headers, ctrl._available = "https://x", {}, True
        with patch.object(read_emails.urllib.request, "urlopen") as m:
            self.assertTrue(read_emails.SupabaseControl.update_financial(
                ctrl, 159, {"barcode": None, "processing_notes": None},
                nullable=("processing_notes",)))
        self.assertEqual(json.loads(m.call_args.args[0].data), {"processing_notes": None})


if __name__ == "__main__":
    unittest.main()
