"""
test_poison_email_isolation.py — um E-MAIL não pode capturar a fila, e adiado não some.

CASO REAL (18 a 21/11/2026). O e-mail cuja extração falhava com erro de API nunca era
registrado: voltava a cada 5 min, era o primeiro na ordem de UID e religava o circuit breaker.
A fila de financeiros ficou parada por dois dias. A tarefa lê com `--days 1`; quando o e-mail
saiu da janela a fila andou, e os 14 adiados que também tinham saído nunca mais foram lidos —
sem linha em /erros (só o e-mail TENTADO ganhava uma).

`test_poison_attachment.py` trava a causa (classificação do erro e tipo da imagem). Aqui se
trava a ESTRUTURA, que vale para qualquer erro futuro que a classificação não conheça:

  1. sonda de saúde: com a API respondendo, só o e-mail que falhou é adiado;
  2. com a API fora, o comportamento de 2026-09-29 é preservado (adia e sai com exit 3);
  3. teto de isolamentos por run;
  4. quarentena: após N falhas confirmadas por sonda saudável, o e-mail é lido em modo
     tolerante — decidido ANTES de processar, uma por run;
  5. modo tolerante: a falha vira erro do ANEXO, os outros anexos geram conta, e um CSV só de
     falha não faz o e-mail sair `extraído`;
  6. todo adiado ganha marcador, uma vez;
  7. a janela `SINCE` nunca é menor que o que está pendente;
  8. exit 3 sempre que há e-mail adiado.

Tudo executando as funções de topo (`run_reader`, `process_message`,
`extract_and_store_accounts`, `api_health_probe`), com dublês de IMAP e Supabase.
"""

import base64
import json
import struct
import sys
import unittest
import zlib
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import anthropic
import httpx

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import extract_pdf as E  # noqa: E402
import read_emails as R  # noqa: E402
from test_fatura_boleto import BOLETO_REAL, REC, FakeControl, _row  # noqa: E402

N = R.POISON_ISOLATED_FAILURES


def _header(uid: bytes, subject: str) -> tuple:
    raw = (f"Subject: {subject}\r\nMessage-ID: <mid-{uid.decode()}>\r\n"
           f"From: alguem@exemplo.com.br\r\nDate: Thu, 19 Nov 2020 15:25:56 -0300\r\n\r\n").encode()
    return ("OK", [(uid + b' (INTERNALDATE "19-Nov-2020 15:25:56 -0300" BODY[HEADER])', raw)])


class _FakeMail:
    def __init__(self, subjects: dict):
        self._subjects = subjects

    def uid(self, _command, uid, *_args):
        return _header(uid, self._subjects[uid])

    def logout(self):
        pass


def _pending(failures: int, received_at: str = "2020-11-19T18:25:56+00:00") -> dict:
    return {"id": 1, "received_at": received_at, R.ISOLATED_FAILURES_KEY: failures}


class _ReaderMixin(unittest.TestCase):
    """Roda `run_reader` com N e-mails FINANCEIROS (assunto com keyword)."""

    def _run(self, total: int, falham=(), sonda=(True, None), pendentes=None, dry_run=False):
        uids = [str(i).encode() for i in range(1, total + 1)]
        mail = _FakeMail({uid: f"Boleto {uid.decode()}" for uid in uids})
        ctrl = mock.MagicMock()
        ctrl._available = True
        ctrl.load_known_ids.return_value = {"<ja-processado>"}
        ctrl.pending_api_errors.return_value = dict(pendentes or {})
        ctrl.latest_received_at.return_value = None
        ctrl.is_processed.return_value = False
        ctrl.bump_isolated_failures.return_value = 1

        def _process(_mail, uid, *_args, **_kwargs):
            if uid in falham:
                raise R.ApiUnavailableError(f"Error code: 500 - falha do uid {uid.decode()}")

        process = mock.MagicMock(side_effect=_process)
        probe = mock.MagicMock(return_value=sonda)
        with mock.patch.object(R, "_connect_and_search", return_value=(mail, uids)), \
                mock.patch.object(R, "SupabaseControl", return_value=ctrl), \
                mock.patch.object(R, "_api_is_healthy", probe), \
                mock.patch.object(R, "process_message", process):
            summary = R.run_reader(days=1, dry_run=dry_run)
        # O laço isola exceção por e-mail: sem isto, um dublê mal montado passaria por "adiado".
        self.assertEqual(summary["crashed"], 0)
        return summary, ctrl, process, probe

    @staticmethod
    def _uids_processados(process) -> list:
        return [chamada.args[1] for chamada in process.call_args_list]

    @staticmethod
    def _marcadores(ctrl) -> list:
        """message_id de cada linha erro_api 'Adiado' gravada pelo run_reader."""
        return [c.args[0]["message_id"] for c in ctrl.register_error.call_args_list
                if c.args[1] == R.API_ERROR_TYPE and c.args[2].startswith("Adiado")]


class IsolamentoTest(_ReaderMixin):
    def test_api_saudavel_isola_so_o_email_que_falhou(self):
        summary, ctrl, process, probe = self._run(3, falham=[b"1"], sonda=(True, None))

        # Os e-mails POSTERIORES ao que falhou foram tentados — antes, eram adiados em bloco.
        self.assertEqual(self._uids_processados(process), [b"1", b"2", b"3"])
        self.assertEqual(summary["processed"], 2)
        self.assertEqual((summary["deferred"], summary["isolated"]), (1, 1))
        self.assertFalse(summary["api_aborted"])
        probe.assert_called_once()
        # A falha isolada é CONTADA (base da quarentena) — e só a do e-mail que falhou.
        ctrl.bump_isolated_failures.assert_called_once_with("<mid-1>")
        self.assertEqual(self._marcadores(ctrl), [])

    def test_api_fora_preserva_o_breaker_e_marca_todo_adiado(self):
        summary, ctrl, process, _probe = self._run(3, falham=[b"1"], sonda=(False, "529"))

        self.assertEqual(self._uids_processados(process), [b"1"])     # uma recusa por run basta
        self.assertTrue(summary["api_aborted"])
        self.assertEqual((summary["deferred"], summary["isolated"]), (3, 0))
        # Falha durante parada REAL não conta para a quarentena.
        ctrl.bump_isolated_failures.assert_not_called()
        # 🔴 Os adiados ATRÁS do que falhou ganham marcador: é o que os mantém em /erros e
        # dentro da janela. (O que falhou tem a linha gravada pela própria extração.)
        self.assertEqual(self._marcadores(ctrl), ["<mid-2>", "<mid-3>"])

    def test_adiado_que_ja_tem_linha_nao_ganha_outra(self):
        _summary, ctrl, _process, _probe = self._run(
            3, falham=[b"1"], sonda=(False, "529"), pendentes={"<mid-3>": _pending(0)})
        self.assertEqual(self._marcadores(ctrl), ["<mid-2>"])

    def test_teto_de_isolamentos_por_run_abre_o_breaker(self):
        total = R.MAX_ISOLATED_PER_RUN + 2
        summary, _ctrl, process, probe = self._run(
            total, falham=[str(i).encode() for i in range(1, total + 1)], sonda=(True, None))

        # MAX isolados + 1 tentativa que abre o breaker; o último nem é tentado.
        self.assertEqual(process.call_count, R.MAX_ISOLATED_PER_RUN + 1)
        self.assertEqual(probe.call_count, R.MAX_ISOLATED_PER_RUN)
        self.assertEqual(summary["isolated"], R.MAX_ISOLATED_PER_RUN)
        self.assertTrue(summary["api_aborted"])
        self.assertEqual(summary["deferred"], total)

    def test_email_registrado_por_outro_processo_nao_e_reprocessado(self):
        uids = [b"1", b"2"]
        mail = _FakeMail({uid: f"Boleto {uid.decode()}" for uid in uids})
        ctrl = mock.MagicMock()
        ctrl.load_known_ids.return_value = {"<ja-processado>"}
        ctrl.pending_api_errors.return_value = {}
        ctrl.latest_received_at.return_value = None
        ctrl.is_processed.side_effect = lambda mid: mid == "<mid-1>"
        process = mock.MagicMock()
        with mock.patch.object(R, "_connect_and_search", return_value=(mail, uids)), \
                mock.patch.object(R, "SupabaseControl", return_value=ctrl), \
                mock.patch.object(R, "process_message", process):
            summary = R.run_reader(days=1)
        self.assertEqual(self._uids_processados(process), [b"2"])
        self.assertEqual(summary["skipped_dup"], 1)


class QuarentenaTest(_ReaderMixin):
    @staticmethod
    def _tolerancias(process) -> dict:
        return {c.args[1]: c.kwargs.get("tolerate_api_failure") for c in process.call_args_list}

    def test_apos_n_falhas_isoladas_o_email_e_lido_em_modo_tolerante(self):
        summary, _ctrl, process, probe = self._run(2, pendentes={"<mid-1>": _pending(N)})
        self.assertEqual(self._tolerancias(process), {b"1": True, b"2": False})
        self.assertEqual(summary["quarantined"], 1)
        probe.assert_called_once()                    # a saúde é confirmada ANTES de tolerar

    def test_abaixo_do_limiar_a_leitura_e_normal_e_nao_ha_sonda(self):
        summary, _ctrl, process, probe = self._run(1, pendentes={"<mid-1>": _pending(N - 1)})
        self.assertEqual(self._tolerancias(process), {b"1": False})
        self.assertEqual(summary["quarantined"], 0)
        probe.assert_not_called()

    def test_no_maximo_uma_quarentena_por_run(self):
        pendentes = {"<mid-1>": _pending(N), "<mid-2>": _pending(N + 5)}
        summary, _ctrl, process, _probe = self._run(2, pendentes=pendentes)
        self.assertEqual(self._tolerancias(process), {b"1": True, b"2": False})
        self.assertEqual(summary["quarantined"], 1)

    def test_sonda_falha_na_quarentena_abre_o_breaker_sem_processar(self):
        summary, ctrl, process, _probe = self._run(
            2, sonda=(False, "credit balance is too low"), pendentes={"<mid-1>": _pending(N)})
        process.assert_not_called()                   # nem tolerante, nem normal
        self.assertTrue(summary["api_aborted"])
        self.assertEqual(summary["deferred"], 2)
        self.assertEqual(summary["api_error"], "credit balance is too low")
        self.assertEqual(self._marcadores(ctrl), ["<mid-2>"])   # o 1º já tinha a sua linha

    def test_dry_run_nao_sonda_nao_marca_e_nao_tolera(self):
        summary, ctrl, process, probe = self._run(
            2, pendentes={"<mid-1>": _pending(N)}, dry_run=True)
        probe.assert_not_called()
        ctrl.register_error.assert_not_called()
        ctrl.is_processed.assert_not_called()
        self.assertEqual(self._tolerancias(process), {b"1": False, b"2": False})
        self.assertEqual(summary["quarantined"], 0)


class _Controle(FakeControl):
    def has_error(self, message_id, error_type):
        return False


_ERRO_API = {"source_file": "assinatura.png", "extraction_source": "erro_api",
             "processing_notes": "ERRO_API: Error code: 500 - Internal server error"}


class ModoToleranteTest(unittest.TestCase):
    def _store(self, tolerate: bool):
        rows = {"assinatura.png": _ERRO_API, "boleto.pdf": _row("boleto.pdf", BOLETO_REAL)}
        ctrl = _Controle()
        with mock.patch.object(R, "run_extraction", lambda p, pdf_passwords=None: (p.name, None)), \
                mock.patch.object(R, "read_extracted_rows", lambda csv: [rows[Path(csv).name]]):
            resultado = R.extract_and_store_accounts(
                [Path("assinatura.png"), Path("boleto.pdf")], "<mid>", ctrl,
                email_rec={**REC, "message_id": "<mid>"}, tolerate_api_failure=tolerate)
        return ctrl, resultado

    def test_falha_tolerada_vira_erro_do_anexo_e_o_boleto_vira_conta(self):
        ctrl, (csvs_ok, accounts_saved, _nonpayable, attachment_account) = self._store(True)
        self.assertEqual(accounts_saved, 1)
        self.assertTrue(attachment_account)
        self.assertEqual([c["barcode"] for c in ctrl.financial_calls], [BOLETO_REAL])
        # 🔴 O CSV que só trouxe a falha NÃO conta como extraído.
        self.assertEqual(csvs_ok, ["boleto.pdf"])
        tipos = [tipo for tipo, _msg in ctrl.error_calls]
        self.assertEqual(tipos, ["extracao_falhou"])                # e NÃO erro_api
        self.assertIn("assinatura.png", ctrl.error_calls[0][1])
        self.assertIn("Internal server error", ctrl.error_calls[0][1])   # o motivo da API

    def test_sem_tolerancia_o_email_inteiro_continua_adiado(self):
        # Contraprova do opt-in: fora da quarentena, erro de API tem de levantar.
        with self.assertRaises(R.ApiUnavailableError):
            self._store(False)

    def test_email_cujo_unico_anexo_falhou_nao_sai_extraido(self):
        """`process_message` de ponta a ponta: sem conta, o status não pode declarar conta."""
        raw = (b"Subject: Boleto\r\nMessage-ID: <mid-9>\r\nFrom: a@b.com.br\r\n"
               b"Date: Thu, 19 Nov 2020 15:25:56 -0300\r\n\r\ncorpo")
        mail = mock.MagicMock()
        mail.uid.return_value = ("OK", [(b'9 (INTERNALDATE "19-Nov-2020 15:25:56 -0300" RFC822)', raw)])
        ctrl = mock.MagicMock()
        with mock.patch.object(R, "save_attachments", return_value=[Path("assinatura.png")]), \
                mock.patch.object(R, "_attachment_text", return_value=""), \
                mock.patch.object(R, "run_extraction",
                                  lambda p, pdf_passwords=None: (p.name, None)), \
                mock.patch.object(R, "read_extracted_rows", return_value=[_ERRO_API]), \
                mock.patch.object(R, "try_extract_from_body", return_value=R.BODY_NONE), \
                mock.patch.object(R, "apply_due_date_reminder", return_value=None), \
                mock.patch.object(R, "append_log_csv"):
            rec = R.process_message(mail, b"9", ["boleto"], False, False, ctrl,
                                    tolerate_api_failure=True)
        self.assertEqual(rec["status"], "pendente")       # anexo salvo, nenhuma conta
        self.assertFalse(rec["pdf_extracted"])
        ctrl.register.assert_called_once()                 # o e-mail FOI registrado
        # ...e a linha erro_api (com o contador) é limpa: ele deixou a fila de retentativa.
        ctrl.delete_errors.assert_called_once_with("<mid-9>", R.API_ERROR_TYPE)


HOJE = date(2026, 11, 24)
# Meio-dia UTC: a data local é a mesma em qualquer fuso de -11 a +11 (o teste não depende do
# relógio nem do fuso da máquina).
DIA_19 = "2026-11-19T12:00:00+00:00"


class JanelaTest(unittest.TestCase):
    def _since(self, days=1, pendentes=None, conhecidos=(), marca=None):
        return R._search_since(days, pendentes or {}, set(conhecidos), marca, today=HOJE)

    def test_sem_pendencia_a_janela_e_a_pedida(self):
        self.assertEqual(self._since(), date(2026, 11, 23))
        self.assertEqual(self._since(days=7), date(2026, 11, 17))

    def test_pendencia_nao_registrada_amplia_a_janela(self):
        # E-mail de 19/11 ainda pendente em 24/11: com `--days 1` ele estaria fora do SINCE.
        since = self._since(pendentes={"<adiado>": _pending(0, DIA_19)})
        self.assertEqual(since, date(2026, 11, 18))          # o dia do e-mail, menos a margem

    def test_pendencia_de_email_ja_registrado_e_ignorada(self):
        # Linha órfã (o e-mail concluiu por outro caminho): não pode prender a janela.
        since = self._since(pendentes={"<orfa>": _pending(0, DIA_19)}, conhecidos=["<orfa>"])
        self.assertEqual(since, date(2026, 11, 23))

    def test_pendencia_alem_do_piso_e_descartada_e_nao_limitada_ao_piso(self):
        # As linhas de 16/07 existem de verdade no banco. Limitar ao piso faria todo run varrer
        # MAX_LOOKBACK_DAYS para sempre; o certo é a pendência irrecuperável sair do cálculo.
        since = self._since(pendentes={"<julho>": _pending(0, "2026-07-16T12:00:00+00:00")})
        self.assertEqual(since, date(2026, 11, 23))

    def test_a_mais_antiga_dentro_do_piso_vence(self):
        pendentes = {"<a>": _pending(0, DIA_19), "<b>": _pending(0, "2026-11-21T12:00:00+00:00"),
                     "<julho>": _pending(0, "2026-07-16T12:00:00+00:00")}
        self.assertEqual(self._since(pendentes=pendentes), date(2026, 11, 18))

    def test_leitura_em_atraso_amplia_a_janela(self):
        # Máquina parada desde 20/11: o que chegou de 20 a 22 ficaria fora de `--days 1`.
        self.assertEqual(self._since(marca="2026-11-20T12:00:00+00:00"), date(2026, 11, 19))

    def test_leitura_em_dia_nao_muda_a_janela(self):
        self.assertEqual(self._since(marca="2026-11-24T12:00:00+00:00"), date(2026, 11, 23))

    def test_days_maior_que_o_piso_pedido_a_mao_e_respeitado(self):
        self.assertEqual(self._since(days=30), HOJE - timedelta(days=30))

    def test_dado_ilegivel_nao_derruba_nem_amplia(self):
        pendentes = {"<a>": _pending(0, None), "<b>": _pending(0, "lixo"), "<c>": "nao sou dict"}
        self.assertEqual(self._since(pendentes=pendentes, marca=object()), date(2026, 11, 23))

    def test_data_do_criterio_nao_depende_do_locale(self):
        self.assertEqual(R._imap_date(date(2026, 2, 1)), "01-Feb-2026")
        self.assertEqual([R._imap_date(date(2026, mes, 15))[3:6] for mes in range(1, 13)],
                         list(R._IMAP_MONTHS))

    def _criterio_do_run(self, *, pendentes=None, conhecidos=("<ja-processado>",), marca=None):
        """Executa `run_reader(days=1)` com a caixa vazia e devolve o critério dado ao IMAP."""
        ctrl = mock.MagicMock()
        ctrl.load_known_ids.return_value = set(conhecidos)
        ctrl.pending_api_errors.return_value = pendentes or {}
        ctrl.latest_received_at.return_value = marca
        connect = mock.MagicMock(return_value=(mock.MagicMock(), []))
        with mock.patch.object(R, "_connect_and_search", connect), \
                mock.patch.object(R, "SupabaseControl", return_value=ctrl):
            summary = R.run_reader(days=1)
        connect.assert_called_once_with(summary["criteria"])
        return summary["criteria"]

    @staticmethod
    def _ha_cinco_dias():
        """Instante de 5 dias atrás (meio-dia UTC) e o `SINCE` que ele produz."""
        recebido = (datetime.now(timezone.utc) - timedelta(days=5)).replace(hour=12, minute=0)
        dia = R._local_day(recebido.isoformat()) - timedelta(days=R.SINCE_MARGIN_DAYS)
        return recebido.isoformat(), f'SINCE "{R._imap_date(dia)}"'

    @staticmethod
    def _janela_pedida():
        return f'SINCE "{R._imap_date(datetime.now().date() - timedelta(days=1))}"'

    def test_run_reader_busca_com_a_janela_ampliada(self):
        """O call site: o critério entregue ao IMAP é o calculado, não o `--days` cru."""
        recebido, ampliado = self._ha_cinco_dias()
        self.assertNotEqual(ampliado, self._janela_pedida())                   # sanidade
        criterio = self._criterio_do_run(pendentes={"<adiado>": _pending(0, recebido)})
        self.assertEqual(criterio, ampliado)

    def test_run_reader_entrega_a_marca_dagua_ao_calculo(self):
        """O call site passa `latest_received_at()`: sem pendência, só ela amplia a janela."""
        recebido, ampliado = self._ha_cinco_dias()
        self.assertNotEqual(ampliado, self._janela_pedida())                   # sanidade
        self.assertEqual(self._criterio_do_run(marca=recebido), ampliado)

    def test_run_reader_entrega_os_ids_conhecidos_ao_calculo(self):
        """O call site passa `known_ids`: a pendência de e-mail já registrado não amplia."""
        recebido, ampliado = self._ha_cinco_dias()
        pendentes = {"<orfa>": _pending(0, recebido)}
        # Sanidade: a MESMA pendência amplia quando o e-mail não é conhecido — sem isto, o
        # "não ampliou" abaixo passaria também com a pendência ignorada por outro motivo.
        self.assertEqual(self._criterio_do_run(pendentes=pendentes), ampliado)
        criterio = self._criterio_do_run(pendentes=pendentes, conhecidos=("<orfa>",))
        self.assertEqual(criterio, self._janela_pedida())


class ExitCodeTest(unittest.TestCase):
    def test_email_isolado_tambem_sai_com_exit_3(self):
        resumo = {"api_aborted": False, "deferred": 1, "api_error": "Error code: 500"}
        with self.assertLogs(R.log, level="ERROR") as logs:
            self.assertEqual(R.exit_code_for(resumo), R.EXIT_API_UNAVAILABLE)
        self.assertTrue(any("a API respondeu" in linha and "Error code: 500" in linha
                            for linha in logs.output))

    def test_sem_adiado_sai_com_zero(self):
        self.assertEqual(R.exit_code_for({"api_aborted": False, "deferred": 0}), 0)
        self.assertEqual(R.exit_code_for({"api_aborted": False, "deferred": None}), 0)


class ControleHttpTest(unittest.TestCase):
    """Métodos REAIS de SupabaseControl, com `urlopen` interceptado — trava o contrato HTTP."""

    MID = "<abc+1@x.com.br>"

    def _ctrl(self, available=True):
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl._available = available
        ctrl.base = "https://fake.supabase.co"
        ctrl.headers = {"apikey": "x"}
        return ctrl

    def _capture(self, call, responses=(b"[]",), error=None):
        reqs, fila = [], list(responses)

        def _fake_urlopen(req, *_args, **_kwargs):
            reqs.append(req)
            if error:
                raise error
            resp = mock.MagicMock()
            resp.read.return_value = fila.pop(0) if fila else b"[]"
            resp.__enter__.return_value = resp
            return resp

        with mock.patch.object(R.urllib.request, "urlopen", _fake_urlopen):
            result = call()
        return result, reqs

    def test_pendencias_filtra_por_tipo_e_devolve_o_mapa(self):
        linhas = [
            {"id": 5, "gmail_message_id": "<a>", "received_at": "2026-11-19T18:25:56+00:00",
             "logged_at": "2026-11-19T18:30:00+00:00",
             "raw_payload": {"source_file": "x.png", R.ISOLATED_FAILURES_KEY: 4,
                             R.ALERTED_AT_KEY: "2026-11-19T20:00:00+00:00"}},
            {"id": 6, "gmail_message_id": "<a>", "received_at": "2026-11-20T00:00:00+00:00",
             "logged_at": "2026-11-20T00:05:00+00:00",                # duplicata mais nova
             "raw_payload": {R.ISOLATED_FAILURES_KEY: "7",
                             R.ALERTED_AT_KEY: "2026-11-20T02:00:00+00:00"}},
            {"id": 7, "gmail_message_id": "<b>", "received_at": None, "raw_payload": None},
            {"id": 8, "gmail_message_id": "<c>", "received_at": None,
             "raw_payload": {R.ISOLATED_FAILURES_KEY: "lixo", R.ALERTED_AT_KEY: 123}},
            {"id": 9, "gmail_message_id": None, "received_at": None, "raw_payload": {}},
        ]
        ctrl = self._ctrl()
        mapa, reqs = self._capture(ctrl.pending_api_errors, [json.dumps(linhas).encode()])
        url = reqs[0].full_url
        self.assertIn("/rest/v1/email_processing_errors?", url)
        self.assertIn("error_type=eq.erro_api", url)
        self.assertIn("order=id.asc", url)
        # `logged_at` é a base do alerta ativo (há quanto tempo o e-mail está parado).
        self.assertIn("logged_at", url.split("select=")[1].split("&")[0].split(","))
        self.assertEqual(reqs[0].get_method(), "GET")
        # A linha mais ANTIGA dá id e datas; o contador é o MAIOR e o carimbo do alerta, o MAIS
        # RECENTE. Lixo e None valem 0 / None.
        self.assertEqual(mapa["<a>"], {"id": 5, "received_at": "2026-11-19T18:25:56+00:00",
                                       "logged_at": "2026-11-19T18:30:00+00:00",
                                       R.ISOLATED_FAILURES_KEY: 7,
                                       R.ALERTED_AT_KEY: "2026-11-20T02:00:00+00:00"})
        self.assertEqual(mapa["<b>"][R.ISOLATED_FAILURES_KEY], 0)
        self.assertEqual(mapa["<c>"][R.ISOLATED_FAILURES_KEY], 0)
        self.assertIsNone(mapa["<b>"][R.ALERTED_AT_KEY])
        self.assertIsNone(mapa["<c>"][R.ALERTED_AT_KEY])     # carimbo que não é texto não conta
        self.assertIsNone(mapa["<b>"]["logged_at"])
        self.assertEqual(set(mapa), {"<a>", "<b>", "<c>"})

    def test_pendencias_paginam_alem_do_teto_do_supabase(self):
        # O Supabase corta em 1000 linhas com HTTP 200. Um mapa truncado faria os adiados que
        # ficaram de fora ganharem marcador NOVO a cada run (as 83 linhas de 2026-09-29).
        cheia = json.dumps([{"id": i, "gmail_message_id": f"<{i}>", "received_at": None,
                             "raw_payload": None} for i in range(1000)]).encode()
        ultima = json.dumps([{"id": 1000, "gmail_message_id": "<ultimo>", "received_at": None,
                              "raw_payload": None}]).encode()
        mapa, reqs = self._capture(self._ctrl().pending_api_errors, [cheia, ultima])
        self.assertEqual(len(mapa), 1001)
        self.assertIn("<ultimo>", mapa)
        self.assertEqual(len(reqs), 2)
        self.assertIn("offset=0", reqs[0].full_url)
        self.assertIn("offset=1000", reqs[1].full_url)

    def test_pendencias_e_fail_open(self):
        with self.assertLogs(R.log, level="WARNING"):
            mapa, _ = self._capture(self._ctrl().pending_api_errors, error=OSError("timeout"))
        self.assertEqual(mapa, {})
        mapa, reqs = self._capture(self._ctrl(available=False).pending_api_errors)
        self.assertEqual((mapa, reqs), ({}, []))

    def test_contador_le_soma_e_grava_preservando_o_payload(self):
        linha = [{"id": 458, "raw_payload": {"source_file": "a66c1adb.png",
                                             R.ISOLATED_FAILURES_KEY: 2}}]
        ctrl = self._ctrl()
        novo, reqs = self._capture(lambda: ctrl.bump_isolated_failures(self.MID),
                                   [json.dumps(linha).encode(), b""])
        self.assertEqual(novo, 3)
        self.assertEqual([r.get_method() for r in reqs], ["GET", "PATCH"])
        mid_enc = R.urllib.parse.quote(self.MID, safe="")
        self.assertIn(f"gmail_message_id=eq.{mid_enc}", reqs[0].full_url)
        self.assertIn("error_type=eq.erro_api", reqs[0].full_url)
        self.assertTrue(reqs[1].full_url.endswith("email_processing_errors?id=eq.458"))
        self.assertEqual(json.loads(reqs[1].data), {"raw_payload": {
            "source_file": "a66c1adb.png", R.ISOLATED_FAILURES_KEY: 3}})

    def test_contador_sem_linha_ou_com_falha_devolve_none_sem_gravar(self):
        ctrl = self._ctrl()
        novo, reqs = self._capture(lambda: ctrl.bump_isolated_failures(self.MID), [b"[]"])
        self.assertIsNone(novo)
        self.assertEqual([r.get_method() for r in reqs], ["GET"])     # nenhum PATCH
        with self.assertLogs(R.log, level="WARNING"):
            novo, _ = self._capture(lambda: ctrl.bump_isolated_failures(self.MID),
                                    error=OSError("timeout"))
        self.assertIsNone(novo)
        novo, reqs = self._capture(lambda: ctrl.bump_isolated_failures(None))
        self.assertEqual((novo, reqs), (None, []))

    def test_ultima_leitura(self):
        ctrl = self._ctrl()
        valor, reqs = self._capture(ctrl.latest_received_at,
                                    [b'[{"received_at": "2026-11-24T12:35:21+00:00"}]'])
        self.assertEqual(valor, "2026-11-24T12:35:21+00:00")
        self.assertIn("order=received_at.desc", reqs[0].full_url)
        self.assertIn("limit=1", reqs[0].full_url)
        valor, _ = self._capture(ctrl.latest_received_at, [b"[]"])
        self.assertIsNone(valor)
        with self.assertLogs(R.log, level="WARNING"):
            valor, _ = self._capture(ctrl.latest_received_at, error=OSError("timeout"))
        self.assertIsNone(valor)

    def test_ids_conhecidos_paginam_com_ordem_fixa(self):
        # Sem ORDER BY o offset pode pular linhas, e um e-mail já registrado pareceria novo.
        pagina_cheia = json.dumps([{"message_id": f"<{i}>"} for i in range(1000)]).encode()
        ids, reqs = self._capture(self._ctrl().load_known_ids,
                                  [pagina_cheia, b'[{"message_id": "<ultimo>"}]'])
        self.assertEqual(len(ids), 1001)
        self.assertEqual(len(reqs), 2)                                # sanidade: paginou
        for req in reqs:
            self.assertIn("order=id.asc", req.full_url)
        self.assertIn("offset=1000", reqs[1].full_url)


def _png_chunks(data: bytes) -> list:
    """(tipo, payload) de cada chunk de um PNG, conferindo o CRC de todos."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "assinatura PNG ausente"
    chunks, pos = [], 8
    while pos < len(data):
        (size,) = struct.unpack(">I", data[pos:pos + 4])
        tipo, payload = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + size]
        (crc,) = struct.unpack(">I", data[pos + 8 + size:pos + 12 + size])
        assert crc == zlib.crc32(tipo + payload) & 0xFFFFFFFF, f"CRC inválido em {tipo!r}"
        chunks.append((tipo, payload))
        pos += 12 + size
    return chunks


class SondaTest(unittest.TestCase):
    def test_a_imagem_da_sonda_e_um_png_valido(self):
        png = E._probe_png_bytes()
        self.assertEqual(E._sniff_image_media_type(png), "image/png")
        chunks = _png_chunks(png)                                     # confere os CRCs
        self.assertEqual([tipo for tipo, _ in chunks], [b"IHDR", b"IDAT", b"IEND"])
        largura, altura = struct.unpack(">II", chunks[0][1][:8])
        self.assertEqual((largura, altura), (E._PROBE_IMAGE_SIDE, E._PROBE_IMAGE_SIDE))
        self.assertEqual(len(zlib.decompress(chunks[1][1])), altura * (largura + 1))

    def test_a_sonda_espelha_a_requisicao_real_e_nao_retenta(self):
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as cliente:
            resultado = E.api_health_probe()
        self.assertEqual(resultado, (True, None))
        self.assertEqual(cliente.call_args.kwargs["max_retries"], 0)
        self.assertEqual(cliente.call_args.kwargs["timeout"], E.API_PROBE_TIMEOUT_SECONDS)
        pedido = cliente.return_value.messages.create.call_args.kwargs
        # Mesmo modelo e mesma temperature da extração: um 400 sistêmico falha aqui também.
        self.assertEqual((pedido["model"], pedido["temperature"], pedido["max_tokens"]),
                         (E.CLAUDE_MODEL, 0, 1))
        bloco = pedido["messages"][0]["content"][0]
        self.assertEqual((bloco["type"], bloco["source"]["media_type"]), ("image", "image/png"))
        self.assertEqual(base64.standard_b64decode(bloco["source"]["data"]), E._probe_png_bytes())

    def test_a_sonda_nunca_levanta(self):
        request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as cliente:
            cliente.return_value.messages.create.side_effect = anthropic.APITimeoutError(
                request=request)
            ok, motivo = E.api_health_probe()
        self.assertFalse(ok)
        self.assertTrue(motivo)
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": ""}), \
                mock.patch("anthropic.Anthropic") as cliente:
            ok, motivo = E.api_health_probe()
        self.assertFalse(ok)
        self.assertIn("ANTHROPIC_API_KEY", motivo)
        cliente.assert_not_called()

    def test_o_reader_trata_sonda_ausente_ou_quebrada_como_api_fora(self):
        with mock.patch.object(E, "api_health_probe", return_value=(True, None)):
            self.assertEqual(R._api_is_healthy(), (True, None))
        # Deploy parcial: read_emails.py novo com extract_pdf.py antigo (sem a função).
        with mock.patch.object(E, "api_health_probe", None), \
                self.assertLogs(R.log, level="WARNING") as logs:
            ok, motivo = R._api_is_healthy()
        self.assertFalse(ok)
        self.assertTrue(any("Deploy parcial" in linha for linha in logs.output))
        with mock.patch.object(E, "api_health_probe", side_effect=RuntimeError("boom")), \
                self.assertLogs(R.log, level="ERROR"):
            ok, motivo = R._api_is_healthy()
        self.assertFalse(ok)
        self.assertIn("boom", motivo)


if __name__ == "__main__":
    unittest.main()
