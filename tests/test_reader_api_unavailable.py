"""
Leitura de e-mails com a API Anthropic INDISPONÍVEL (crédito esgotado, auth, limite).

Caso real 2026-09-29: o crédito acabou às 06:26. Cada run de 5 min abria o 1º e-mail
financeiro, recebia a recusa e fazia `break` — os e-mails SEGUINTES, inclusive os
não-financeiros, nunca eram registrados; o CLI saía com 0 (Agendador "sucesso", sem Event
Log) e o mesmo erro_api era gravado 83 vezes em /erros. Travas:

  1. o lote NÃO para: financeiro é ADIADO (sem registro, volta no próximo run) e o
     não-financeiro segue registrado; a API é sondada UMA vez por run;
  2. o CLI sai com EXIT_API_UNAVAILABLE (≠ 0);
  3. erro_api é gravado UMA vez por e-mail e limpo quando o e-mail conclui;
  4. importar o módulo não cria crash_*.log.

Tudo executando as funções de topo (run_reader / main / extract_and_store_accounts /
process_message), com dublês de IMAP e Supabase.
"""

import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


def _header(uid: bytes, subject: str) -> tuple:
    raw = (f"Subject: {subject}\r\nMessage-ID: <mid-{uid.decode()}>\r\n"
           f"From: alguem@exemplo.com.br\r\nDate: Tue, 29 Sep 2026 10:00:00 -0300\r\n\r\n").encode()
    return ("OK", [(uid + b' (INTERNALDATE "29-Sep-2026 10:00:00 -0300" BODY[HEADER])', raw)])


class _FakeMail:
    """IMAP mínimo: devolve o header do UID pedido."""

    def __init__(self, subjects: dict):
        self._subjects = subjects
        self.logged_out = False

    def uid(self, command, uid, *_args):
        return _header(uid, self._subjects[uid])

    def logout(self):
        self.logged_out = True


class RunReaderApiIndisponivelTest(unittest.TestCase):
    # UID 1 e 2 casam keyword (financeiros); 3 é não-financeiro.
    SUBJECTS = {
        b"1": "Arquivos de Conhecimento de Transporte Eletrônico",
        b"2": "ENC: DAS-SET/2026",
        b"3": "Sob pressão, condições financeiras reforçam freio à economia",
    }

    def _run(self, process_side_effect):
        mail = _FakeMail(self.SUBJECTS)
        ctrl = mock.MagicMock()
        ctrl._available = True
        ctrl.load_known_ids.return_value = {"<ja-processado>"}
        process = mock.MagicMock(side_effect=process_side_effect)
        with mock.patch.object(read_emails, "_connect_and_search",
                               return_value=(mail, [b"1", b"2", b"3"])), \
             mock.patch.object(read_emails, "SupabaseControl", return_value=ctrl), \
             mock.patch.object(read_emails, "process_message", process):
            summary = read_emails.run_reader(days=1)
        return summary, ctrl, process, mail

    def test_api_fora_adia_financeiros_e_registra_os_demais(self):
        summary, ctrl, process, mail = self._run(
            read_emails.ApiUnavailableError("credit balance is too low"))

        # A API é sondada UMA vez: o 2º financeiro é adiado sem nova chamada.
        self.assertEqual(process.call_count, 1)
        self.assertTrue(summary["api_aborted"])
        self.assertEqual(summary["deferred"], 2)
        self.assertEqual(summary["processed"], 0)
        # O não-financeiro POSTERIOR ao erro é registrado (com `break` ele sumia).
        registrados = [c.args[0]["message_id"] for c in ctrl.register.call_args_list]
        self.assertEqual(registrados, ["<mid-3>"])
        self.assertEqual(ctrl.register.call_args_list[0].args[0]["status"], "ignorado")
        self.assertTrue(mail.logged_out)

    def test_motivo_literal_da_recusa_chega_ao_exit(self):
        # 529/500 são transitórios; crédito exige ação. A mensagem do exit 3 carrega o motivo
        # REAL em vez de mandar "verificar os créditos" num soluço da API.
        summary, *_ = self._run(read_emails.ApiUnavailableError("Error code: 529 - overloaded"))
        self.assertEqual(summary["api_error"], "Error code: 529 - overloaded")
        with self.assertLogs(read_emails.log, level="ERROR") as logs:
            self.assertEqual(read_emails.exit_code_for(summary), read_emails.EXIT_API_UNAVAILABLE)
        self.assertTrue(any("529 - overloaded" in m for m in logs.output))

    def test_api_ok_processa_todos(self):
        summary, ctrl, process, _mail = self._run(lambda *a, **k: None)
        self.assertEqual(process.call_count, 2)
        self.assertFalse(summary["api_aborted"])
        self.assertEqual(summary["deferred"], 0)
        self.assertEqual(summary["processed"], 2)
        self.assertIsNone(summary["api_error"])


class ExitCodeTest(unittest.TestCase):
    def test_exit_code_for(self):
        self.assertEqual(read_emails.exit_code_for({"api_aborted": False}), 0)
        self.assertEqual(read_emails.exit_code_for({}), 0)
        self.assertEqual(read_emails.exit_code_for({"api_aborted": True, "deferred": 4}),
                         read_emails.EXIT_API_UNAVAILABLE)
        # Distinto do exit 1 (falha IMAP/crash) — o run_reader.ps1 separa as mensagens.
        self.assertNotIn(read_emails.EXIT_API_UNAVAILABLE, (0, 1))

    def _main_exit(self, summary):
        with mock.patch.object(sys, "argv", ["read_emails.py", "--days", "1"]), \
             mock.patch.object(read_emails, "run_reader", return_value=summary), \
             self.assertRaises(SystemExit) as cm:
            read_emails.main()
        return cm.exception.code

    def test_main_sai_com_codigo_de_api_indisponivel(self):
        self.assertEqual(self._main_exit({"api_aborted": True, "deferred": 7}),
                         read_emails.EXIT_API_UNAVAILABLE)

    def test_main_sai_com_zero_no_run_completo(self):
        self.assertEqual(self._main_exit({"api_aborted": False, "deferred": 0}), 0)

    def test_wrapper_do_agendador_trata_o_mesmo_codigo(self):
        # Sanidade do contrato entre as duas camadas: o .ps1 declara o MESMO valor.
        ps1 = (Path(__file__).resolve().parents[1] / "scheduler" / "run_reader.ps1").read_text(
            encoding="utf-8")
        self.assertIn(f"$EXIT_API_UNAVAILABLE = {read_emails.EXIT_API_UNAVAILABLE}", ps1)
        self.assertIn("-eq $EXIT_API_UNAVAILABLE", ps1)


class _Ctrl:
    """Dublê de SupabaseControl para extract_and_store_accounts."""

    def __init__(self, existing_error: bool):
        self._existing = existing_error
        self.errors = []
        self.has_error_calls = []

    def has_error(self, message_id, error_type):
        self.has_error_calls.append((message_id, error_type))
        return self._existing

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.errors.append(error_type)
        return True

    def __getattr__(self, name):  # demais métodos do pipeline: inertes
        return mock.MagicMock(return_value=None)


class ErroApiGravadoUmaVezTest(unittest.TestCase):
    def _run(self, existing_error: bool):
        ctrl = _Ctrl(existing_error)
        row = {"source_file": "cte.pdf", "extraction_source": "erro_api",
               "processing_notes": "ERRO_API: credit balance is too low"}
        with mock.patch.object(read_emails, "run_extraction",
                               lambda p, pdf_passwords=None: (p.name, None)), \
             mock.patch.object(read_emails, "read_extracted_rows", return_value=[row]), \
             self.assertRaises(read_emails.ApiUnavailableError):
            read_emails.extract_and_store_accounts(
                [Path("cte.pdf")], "<mid-1>", ctrl,
                email_rec={"message_id": "<mid-1>", "subject": "CT-e"})
        return ctrl

    def test_primeira_falha_grava_erro_api(self):
        ctrl = self._run(existing_error=False)
        self.assertEqual(ctrl.errors, [read_emails.API_ERROR_TYPE])
        self.assertEqual(ctrl.has_error_calls, [("<mid-1>", "erro_api")])

    def test_falha_repetida_nao_duplica_a_linha(self):
        ctrl = self._run(existing_error=True)
        self.assertEqual(ctrl.errors, [])


class ErroApiLimpoAoConcluirTest(unittest.TestCase):
    def test_process_message_concluido_limpa_erro_api(self):
        raw = (b"Subject: Boleto\r\nMessage-ID: <mid-9>\r\nFrom: a@b.com.br\r\n"
               b"Date: Tue, 29 Sep 2026 10:00:00 -0300\r\n\r\ncorpo")
        mail = mock.MagicMock()
        mail.uid.return_value = ("OK", [(b'9 (INTERNALDATE "29-Sep-2026 10:00:00 -0300" RFC822)', raw)])
        ctrl = mock.MagicMock()
        with mock.patch.object(read_emails, "save_attachments", return_value=[]), \
             mock.patch.object(read_emails, "extract_and_store_accounts",
                               return_value=([], 0, False, False)), \
             mock.patch.object(read_emails, "try_extract_from_body",
                               return_value=read_emails.BODY_NONE), \
             mock.patch.object(read_emails, "apply_due_date_reminder", return_value=None), \
             mock.patch.object(read_emails, "append_log_csv"):
            read_emails.process_message(mail, b"9", ["boleto"], False, False, ctrl)
        ctrl.delete_errors.assert_called_once_with("<mid-9>", "erro_api")

    def test_api_indisponivel_nao_limpa_nem_registra(self):
        raw = b"Subject: Boleto\r\nMessage-ID: <mid-9>\r\nFrom: a@b.com.br\r\n\r\ncorpo"
        mail = mock.MagicMock()
        mail.uid.return_value = ("OK", [(b'9 (INTERNALDATE "29-Sep-2026 10:00:00 -0300" RFC822)', raw)])
        ctrl = mock.MagicMock()
        with mock.patch.object(read_emails, "save_attachments", return_value=[]), \
             mock.patch.object(read_emails, "extract_and_store_accounts",
                               side_effect=read_emails.ApiUnavailableError("x")), \
             self.assertRaises(read_emails.ApiUnavailableError):
            read_emails.process_message(mail, b"9", ["boleto"], False, False, ctrl)
        ctrl.register.assert_not_called()
        ctrl.delete_errors.assert_not_called()


class ErroApiHttpRealTest(unittest.TestCase):
    """Executa os métodos REAIS has_error/delete_errors com `urlopen` interceptado.

    Os dublês acima provam o wiring; aqui se trava o contrato HTTP. Sem o filtro de
    error_type, o DELETE apagaria TODO o histórico do e-mail em /erros (falha_processamento
    inclusive) a cada leitura concluída — e nenhum outro teste ficaria vermelho.
    """

    MID = "<abc+1@x.com.br>"

    def _ctrl(self, available=True):
        ctrl = read_emails.SupabaseControl.__new__(read_emails.SupabaseControl)
        ctrl._available = available
        ctrl.base = "https://fake.supabase.co"
        ctrl.headers = {"apikey": "x"}
        return ctrl

    def _capture(self, call, response=b"[]", error=None):
        reqs = []

        def _fake_urlopen(req, *_args, **_kwargs):
            reqs.append(req)
            if error:
                raise error
            resp = mock.MagicMock()
            resp.read.return_value = response
            resp.__enter__.return_value = resp
            return resp

        with mock.patch.object(read_emails.urllib.request, "urlopen", _fake_urlopen):
            result = call()
        return result, reqs

    def _assert_filters(self, url):
        mid_enc = read_emails.urllib.parse.quote(self.MID, safe="")
        self.assertIn("/rest/v1/email_processing_errors?", url)
        self.assertIn(f"gmail_message_id=eq.{mid_enc}", url)
        self.assertIn("error_type=eq.erro_api", url)
        self.assertNotIn(self.MID, url)                       # id sempre codificado

    def test_delete_filtra_por_email_e_por_tipo(self):
        ctrl = self._ctrl()
        _, reqs = self._capture(lambda: ctrl.delete_errors(self.MID, "erro_api"))
        self.assertEqual(len(reqs), 1)
        self.assertEqual(reqs[0].get_method(), "DELETE")
        self._assert_filters(reqs[0].full_url)

    def test_has_error_consulta_com_os_mesmos_filtros(self):
        ctrl = self._ctrl()
        found, reqs = self._capture(lambda: ctrl.has_error(self.MID, "erro_api"),
                                    response=b'[{"id": 1}]')
        self.assertTrue(found)
        self.assertEqual(reqs[0].get_method(), "GET")
        self._assert_filters(reqs[0].full_url)
        found, _ = self._capture(lambda: ctrl.has_error(self.MID, "erro_api"), response=b"[]")
        self.assertFalse(found)

    def test_falha_de_rede_e_fail_open_e_best_effort(self):
        ctrl = self._ctrl()
        with self.assertLogs(read_emails.log, level="WARNING"):
            found, _ = self._capture(lambda: ctrl.has_error(self.MID, "erro_api"),
                                     error=OSError("timeout"))
            self._capture(lambda: ctrl.delete_errors(self.MID, "erro_api"),
                          error=OSError("timeout"))
        self.assertFalse(found)

    def test_sem_supabase_ou_sem_id_nao_chama_a_rede(self):
        for ctrl, mid in ((self._ctrl(available=False), self.MID), (self._ctrl(), None)):
            _, reqs = self._capture(lambda: (ctrl.has_error(mid, "erro_api"),
                                             ctrl.delete_errors(mid, "erro_api")))
            self.assertEqual(reqs, [])


class ImportSemCrashLogTest(unittest.TestCase):
    def test_importar_o_modulo_nao_cria_crash_log(self):
        crash_dir = Path(__file__).resolve().parents[1] / "logs" / "scheduler"
        antes = set(crash_dir.glob("crash_*.log")) if crash_dir.exists() else set()
        # Processo novo: o import em ESTE processo já aconteceu no topo do arquivo.
        subprocess.run(
            [sys.executable, "-c", f"import sys; sys.path.insert(0, r'{_SCRIPTS_DIR}'); import read_emails"],
            check=True, capture_output=True, timeout=120,
        )
        depois = set(crash_dir.glob("crash_*.log")) if crash_dir.exists() else set()
        self.assertEqual(depois - antes, set())
        self.assertIsNone(read_emails._CRASH_LOG)


if __name__ == "__main__":
    unittest.main()
