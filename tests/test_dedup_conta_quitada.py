"""
Dedup que casa conta QUITADA com documento de vencimento POSTERIOR = divida NOVA (conta 417).

Caso real (AMIL, e-mail 2382, 23/09/2026): o "Nº do Documento" do boleto Amil e o numero do
CONTRATO (003071000), igual todo mes, e o valor do plano e fixo (R$ 7.217,91). A impressao 2
(Nº + valor) casou o boleto de OUTUBRO com a conta 417 — a de JULHO, lancada a mao, sem nosso
numero e ja PAGA — e a "reemissao" reescreveu vencimento (07/07 -> 07/10) e barcode dela. O
boleto de outubro nasceu pago; o e-mail ficou `duplicidade`; nada em /erros.

Os testes EXECUTAM `extract_and_store_accounts` (o call site), nao so a funcao pura.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import read_emails  # noqa: E402
from test_boleto_dedup_suppresses_body import FakeControl  # noqa: E402

# Boleto AMIL real de outubro/2026 (Itau 341, fator 1592 = 07/10/2026, R$ 7.217,91).
BOLETO_AMIL_OUT = "34193159200007217911092732273892938395767000"
STATUS_PAGO = read_emails._STATUS_NAME_TO_ID["pago"]
STATUS_BAIXADO = read_emails._STATUS_NAME_TO_ID["baixado"]
STATUS_CANCELADO = read_emails._STATUS_NAME_TO_ID["cancelado"]
STATUS_A_VENCER = read_emails.STATUS_ID_A_VENCER

# Conta 417 como estava ANTES do e-mail (audit_log): julho, paga, sem barcode.
CONTA_417 = {"id": 417, "due_date": "2026-07-07", "barcode": None,
             "status_id": STATUS_PAGO, "invoice_number": "003071000", "nosso_numero": None}


def _amil_row():
    return {
        "source_file": "Boleto_eFaturamento_.pdf",
        "document_type": "boleto",
        "barcode": BOLETO_AMIL_OUT,
        "amount": "7217.91",
        "supplier_name": "AMIL ASSISTENCIA MEDICA INTERNACIONAL SA",
        "invoice_number": "003071000",
        "nosso_numero": "109-27322738-9",
        "due_date": "2026-10-07",
        "extraction_source": "pdf_text",
    }


def _run(ctrl, row):
    with patch.object(read_emails, "run_extraction", lambda p, pdf_passwords=None: (p.name, None)), \
         patch.object(read_emails, "read_extracted_rows", lambda csv_path: [row]):
        return read_emails.extract_and_store_accounts(
            [Path(row["source_file"])], "<MID>", ctrl,
            email_rec={"received_at": "2026-09-23T11:40:15+00:00",
                       "subject": "boleto digital Amil", "sender_email": "eunice@otimotex.com.br"})


class RefazBuscaFake(FakeControl):
    """Espelha o veto real: com `skip_settled`, a quitada sai e a busca segue ate `fallback`."""

    def __init__(self, dup, fallback=None):
        super().__init__(dup=dup)
        self._fallback = fallback
        self.skip_calls = []

    def find_financial_duplicate(self, payload, skip_settled=False):
        self.skip_calls.append(skip_settled)
        return self._fallback if skip_settled else self._dup


class ContaQuitadaNaoEReemitidaTest(unittest.TestCase):
    def test_caso_amil_grava_conta_nova_e_nao_toca_a_quitada(self):
        ctrl = RefazBuscaFake(dup=dict(CONTA_417))
        _csvs, accounts_saved, _nonpayable, attachment_account = _run(ctrl, _amil_row())
        self.assertEqual(accounts_saved, 1, "o boleto de outubro tem de virar conta propria")
        self.assertTrue(attachment_account)
        self.assertEqual(ctrl.update_calls, [], "a conta paga de julho NAO pode ser reescrita")
        (gravado,) = ctrl.financial_calls
        self.assertEqual((gravado["due_date"], gravado["barcode"]), ("2026-10-07", BOLETO_AMIL_OUT))
        # O anexo vai para a conta NOVA (id 1 no FakeControl), nunca para a 417.
        self.assertEqual(ctrl.attachment_calls, [(1, "Boleto_eFaturamento_.pdf")])
        # Rastro para o operador em "Observações".
        self.assertIn("conta 417", gravado.get("processing_notes") or "")

    def test_baixado_tambem_e_quitada(self):
        ctrl = RefazBuscaFake(dup={**CONTA_417, "status_id": STATUS_BAIXADO})
        _run(ctrl, _amil_row())
        self.assertEqual((len(ctrl.financial_calls), ctrl.update_calls), (1, []))

    def test_status_id_como_texto_numerico_ainda_e_reconhecido(self):
        ctrl = RefazBuscaFake(dup={**CONTA_417, "status_id": str(STATUS_PAGO)})
        _run(ctrl, _amil_row())
        self.assertEqual(len(ctrl.financial_calls), 1)

    def test_nota_preserva_as_anteriores(self):
        row = {**_amil_row(), "processing_notes": "nota do extrator"}
        ctrl = RefazBuscaFake(dup=dict(CONTA_417))
        _run(ctrl, row)
        notas = ctrl.financial_calls[0]["processing_notes"]
        self.assertTrue(notas.startswith("nota do extrator | "), notas)


class ComportamentoAnteriorPreservadoTest(unittest.TestCase):
    """Fora do caso quitada + vencimento posterior, a dedup segue como antes."""

    def test_conta_em_aberto_com_vencimento_posterior_segue_sendo_reemissao(self):
        ctrl = FakeControl(dup={**CONTA_417, "status_id": STATUS_A_VENCER})
        _run(ctrl, _amil_row())
        self.assertEqual(ctrl.financial_calls, [])
        ((dup_id, campos),) = ctrl.update_calls
        self.assertEqual((dup_id, campos["due_date"]), (417, "2026-10-07"))

    def test_cancelada_segue_sendo_reemissao(self):
        # Padrao medido: lembretes repetidos de seguradora sobre conta cancelada (483, 547...).
        ctrl = FakeControl(dup={**CONTA_417, "status_id": STATUS_CANCELADO})
        _run(ctrl, _amil_row())
        self.assertEqual((ctrl.financial_calls, len(ctrl.update_calls)), ([], 1))

    def test_quitada_com_mesmo_vencimento_segue_deduplicada(self):
        # Reenvio do MESMO boleto ja pago: nao cria conta nova.
        ctrl = FakeControl(dup={**CONTA_417, "due_date": "2026-10-07"})
        _csvs, accounts_saved, _n, attachment_account = _run(ctrl, _amil_row())
        self.assertEqual((accounts_saved, attachment_account), (0, True))

    def test_quitada_com_mesmo_barcode_segue_deduplicada(self):
        # Mesmo codigo = mesmo titulo (impressao 1), mesmo lendo data impressa posterior: nao
        # nasce conta nova — segue o caminho de reemissao de sempre.
        ctrl = FakeControl(dup={**CONTA_417, "barcode": BOLETO_AMIL_OUT, "due_date": "2026-10-01"})
        _run(ctrl, _amil_row())
        self.assertEqual((ctrl.financial_calls, len(ctrl.update_calls)), ([], 1))

    def test_sem_status_id_mantem_o_comportamento_anterior(self):
        dup = {k: v for k, v in CONTA_417.items() if k != "status_id"}
        ctrl = FakeControl(dup=dup)
        _run(ctrl, _amil_row())
        self.assertEqual((ctrl.financial_calls, len(ctrl.update_calls)), ([], 1))


class QuitadaNaoEscondeContaDaMesmaDividaTest(unittest.TestCase):
    """🔴 Parar a busca na quitada fazia nascer uma 2a conta de outubro EM ABERTO ao lado da
    conta do corpo da mesma divida (review max 2026-09-24) — risco de pagamento em dobro."""

    CONTA_CORPO_OUT = {"id": 1700, "due_date": "2026-10-07", "barcode": None,
                       "status_id": STATUS_A_VENCER, "processing_notes": None}

    def test_refaz_a_busca_e_enriquece_a_conta_do_corpo(self):
        ctrl = RefazBuscaFake(dup=dict(CONTA_417), fallback=dict(self.CONTA_CORPO_OUT))
        _csvs, accounts_saved, _n, attachment_account = _run(ctrl, _amil_row())
        self.assertEqual(ctrl.skip_calls, [False, True])
        self.assertEqual((accounts_saved, attachment_account, ctrl.financial_calls), (0, True, []))
        ((dup_id, campos),) = ctrl.update_calls
        self.assertEqual((dup_id, campos["barcode"]), (1700, BOLETO_AMIL_OUT))
        self.assertEqual(ctrl.attachment_calls, [(1700, "Boleto_eFaturamento_.pdf")])

    def test_sem_outra_candidata_grava_conta_nova_com_nota(self):
        ctrl = RefazBuscaFake(dup=dict(CONTA_417), fallback=None)
        _run(ctrl, _amil_row())
        self.assertEqual((ctrl.skip_calls, ctrl.update_calls), ([False, True], []))
        self.assertIn("conta 417", ctrl.financial_calls[0]["processing_notes"])


class VetoDentroDaDedupRealTest(unittest.TestCase):
    """Executa `find_financial_duplicate` real: a impressao 2 devolve a quitada; com o veto a
    busca SEGUE ate a impressao 3 (conta do corpo); sem ele, para na quitada."""

    def _dedup(self, skip_settled):
        ctrl = read_emails.SupabaseControl.__new__(read_emails.SupabaseControl)
        ctrl.base, ctrl.headers, ctrl._available = "https://x", {}, True
        corpo = QuitadaNaoEscondeContaDaMesmaDividaTest.CONTA_CORPO_OUT
        urls = []

        def _urlopen(req, timeout=None):
            url = req.full_url
            urls.append(url)
            if "invoice_number=eq." in url:
                rows = [dict(CONTA_417)]
            elif "barcode=is.null" in url:
                rows = [dict(corpo)]
            else:
                rows = []
            cm = MagicMock()
            cm.__enter__.return_value.read.return_value = read_emails.json.dumps(rows).encode()
            return cm

        payload = {"barcode": BOLETO_AMIL_OUT, "sk_supplier": 141, "invoice_number": "003071000",
                   "amount": "7217.91", "due_date": "2026-10-07"}
        with patch.object(read_emails.urllib.request, "urlopen", _urlopen):
            m = read_emails.SupabaseControl.find_financial_duplicate(
                ctrl, payload, skip_settled=skip_settled)
        return m, urls

    def test_com_veto_segue_ate_a_impressao_3(self):
        m, urls = self._dedup(skip_settled=True)
        self.assertTrue(any("invoice_number=eq." in u for u in urls), urls)  # sanidade: 2 rodou
        self.assertEqual(m["id"], 1700)

    def test_sem_veto_para_na_quitada(self):
        m, _urls = self._dedup(skip_settled=False)
        self.assertEqual(m["id"], 417)


class FuncaoPuraBordasTest(unittest.TestCase):
    def test_bordas(self):
        f = read_emails._dup_is_settled_earlier_debt
        novo = {"due_date": "2026-10-07", "barcode": BOLETO_AMIL_OUT}
        self.assertTrue(f(dict(CONTA_417), novo))
        self.assertFalse(f({**CONTA_417, "status_id": None}, novo))
        self.assertFalse(f({**CONTA_417, "status_id": "x"}, novo))
        self.assertFalse(f({**CONTA_417, "due_date": None}, novo))
        self.assertFalse(f(dict(CONTA_417), {**novo, "due_date": None}))
        self.assertFalse(f(dict(CONTA_417), {**novo, "due_date": "2026-07-01"}))
        # Documento sem barcode (corpo) com vencimento posterior a conta paga: divida nova.
        self.assertTrue(f(dict(CONTA_417), {**novo, "barcode": ""}))


class DedupSelecionaStatusIdTest(unittest.TestCase):
    """🔴 Sem `status_id` no SELECT a conta devolvida nunca parece quitada e a guarda fica INERTE
    em producao — o FakeControl nao o veria. Executa `find_financial_duplicate` real."""

    def test_as_quatro_consultas_selecionam_status_id(self):
        ctrl = read_emails.SupabaseControl.__new__(read_emails.SupabaseControl)
        ctrl.base, ctrl.headers, ctrl._available = "https://x", {}, True
        resposta = MagicMock()
        resposta.read.return_value = b"[]"
        cm = MagicMock()
        cm.__enter__.return_value = resposta
        payload = {"barcode": BOLETO_AMIL_OUT, "sk_supplier": 141, "nosso_numero": "109-27322738-9",
                   "invoice_number": "003071000", "amount": "7217.91", "due_date": "2026-10-07"}
        with patch.object(read_emails.urllib.request, "urlopen", return_value=cm) as m:
            self.assertIsNone(read_emails.SupabaseControl.find_financial_duplicate(ctrl, payload))
        urls = [c.args[0].full_url for c in m.call_args_list]
        # Sanidade: barcode, nosso numero, Nº+valor e valor+vencimento — as quatro exercitadas.
        self.assertEqual(len(urls), 4, urls)
        for url in urls:
            self.assertRegex(url, r"select=[^&]*status_id")


if __name__ == "__main__":
    unittest.main()
