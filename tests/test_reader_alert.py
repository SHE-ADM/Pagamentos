"""
test_reader_alert.py — alerta ATIVO do leitor de e-mails (ressalva 1 do incidente de 18–21/11/2026).

O leitor saiu com exit 3 e gravou Event Log a cada 5 minutos, por dois dias, e ninguém viu.
O alerta manda um e-mail quando há e-mail financeiro PARADO. Garantias travadas aqui:

  1. QUANDO: só com e-mail adiado NESTE run que está parado há 60 min ou mais; adiado pela
     1ª vez não avisa; data ilegível conta como parado (o lado seguro de um alerta);
  2. CARÊNCIA: no máximo um aviso a cada 6 h — e um carimbo corrompido no futuro não o cala;
  3. INTERRUPTOR: sem `READER_ALERT_TO` nada é enviado (é o que protege o DEV);
  4. CARIMBO: em TODAS as linhas citadas, só depois de um envio aceito, preservando o contador
     de falhas isoladas (e vice-versa — os dois moram no mesmo objeto JSON);
  5. O LEITOR IGNORA O PRÓPRIO ALERTA e as respostas a ele, sem ler o corpo — mas só de
     remetente próprio/interno: externo não esconde e-mail escrevendo o marcador;
  6. ROBUSTEZ: módulo ausente, SMTP fora ou exceção no alerta não derrubam o run;
  7. ENVIO: um por destinatário, sem a imagem de assinatura da cobrança, com conteúdo de
     terceiros escapado, respeitando DEV_MODE.

Os casos de DECISÃO executam `run_reader` (função de topo), não só o módulo.
"""

import contextlib
import email
import json
import os
import smtplib
import ssl
import sys
import unittest
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R  # noqa: E402
import reader_alert as A  # noqa: E402

MARKER = R.READER_ALERT_SUBJECT_MARKER
# O carregador REAL, guardado antes de qualquer `mock.patch` sobre o atributo do módulo.
_LOAD_EMAIL_SENDER = A._load_email_sender
MAILBOX = "financeiro@otimotex.com.br"
FROM_ADDR = "financeiro@envio.otimotex.com.br"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

ENV = {
    "READER_ALERT_TO": "ti@otimotex.com.br",
    "DEV_MODE": "false",
    "DEV_OVERRIDE_EMAIL": "",
    "IMAP_USER": MAILBOX,
    "SMTP_FROM_ADDR": FROM_ADDR,
}


def _iso(minutes_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _pending(logged_minutes_ago=None, alerted_minutes_ago=None, **extra) -> dict:
    entry = {"id": 1, "received_at": "2020-11-19T18:25:56+00:00",
             "logged_at": None if logged_minutes_ago is None else _iso(logged_minutes_ago),
             R.ISOLATED_FAILURES_KEY: 0,
             R.ALERTED_AT_KEY: (None if alerted_minutes_ago is None
                                else _iso(alerted_minutes_ago))}
    entry.update(extra)
    return entry


@contextlib.contextmanager
def _env(overrides=None):
    """`os.environ` com ENV + `overrides`; valor None REMOVE a variável."""
    final = {**ENV, **(overrides or {})}
    with mock.patch.dict(os.environ, {k: v for k, v in final.items() if v is not None}):
        for key, value in final.items():
            if value is None:
                os.environ.pop(key, None)
        yield


class _FakeSession:
    """Dublê de `email_sender.SmtpSession` (mesma assinatura de `send`)."""

    def __init__(self, falha=None, antes_do_envio=None):
        self.envios = []
        self.falha = falha                    # exceção, ou {destinatário: exceção}
        self.antes_do_envio = antes_do_envio
        self.fechada = False

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.fechada = True

    def send(self, *, to_email, cc_email, subject, html_body, signature=True):
        if self.antes_do_envio:
            self.antes_do_envio()
        falha = self.falha.get(to_email) if isinstance(self.falha, dict) else self.falha
        if falha:
            raise falha
        self.envios.append({"to": to_email, "cc": cc_email, "subject": subject,
                            "html": html_body, "signature": signature})


def _header(uid: bytes, subject: str, sender: str) -> tuple:
    raw = (f"Subject: {subject}\r\nMessage-ID: <mid-{uid.decode()}>\r\n"
           f"From: {sender}\r\nDate: Thu, 19 Nov 2020 15:25:56 -0300\r\n\r\n").encode()
    return ("OK", [(uid + b' (INTERNALDATE "19-Nov-2020 15:25:56 -0300" BODY[HEADER])', raw)])


class _FakeMail:
    def __init__(self, mensagens: dict):
        self._mensagens = mensagens            # uid -> (assunto, remetente)
        self.logged_out = False

    def uid(self, _command, uid, *_args):
        return _header(uid, *self._mensagens[uid])

    def logout(self):
        self.logged_out = True


class _RunMixin(unittest.TestCase):
    """Roda `run_reader` com e-mails FINANCEIROS e a API recusando os de `falham`."""

    def _run(self, *, total=3, falham=(b"1",), sonda=(False, "529"), pendentes=None, env=None,
             sessao=None, dry_run=False, mensagens=None, patches=None):
        if mensagens is None:
            mensagens = {str(i).encode(): (f"Boleto {i}", "alguem@exemplo.com.br")
                         for i in range(1, total + 1)}
        mail = _FakeMail(mensagens)
        self.mail = mail                       # visível aos dublês DURANTE o run
        ctrl = mock.MagicMock()
        ctrl._available = True
        ctrl.load_known_ids.return_value = {"<ja-processado>"}
        ctrl.pending_api_errors.return_value = dict(pendentes or {})
        ctrl.latest_received_at.return_value = None
        ctrl.is_processed.return_value = False
        ctrl.bump_isolated_failures.return_value = 1
        ctrl.stamp_alerted.return_value = True

        def _process(_mail, uid, *_args, **_kwargs):
            if uid in falham:
                raise R.ApiUnavailableError(f"Error code: 529 - falha do uid {uid.decode()}")

        process = mock.MagicMock(side_effect=_process)
        sessao = sessao or _FakeSession()
        abrir = mock.MagicMock(return_value=sessao)
        with contextlib.ExitStack() as pilha:
            pilha.enter_context(_env(env))
            pilha.enter_context(mock.patch.object(
                R, "_connect_and_search", return_value=(mail, list(mensagens))))
            pilha.enter_context(mock.patch.object(R, "SupabaseControl", return_value=ctrl))
            pilha.enter_context(mock.patch.object(
                R, "_api_is_healthy", mock.MagicMock(return_value=sonda)))
            pilha.enter_context(mock.patch.object(R, "process_message", process))
            pilha.enter_context(mock.patch.object(A, "_open_session", abrir))
            for nome, substituto in (patches or {}).items():
                pilha.enter_context(mock.patch.object(R, nome, substituto))
            summary = R.run_reader(days=1, dry_run=dry_run)
        self.assertEqual(summary["crashed"], 0)
        return summary, ctrl, sessao, process, abrir

    @staticmethod
    def _carimbados(ctrl) -> list:
        return [chamada.args[0] for chamada in ctrl.stamp_alerted.call_args_list]


# ---------------------------------------------------------------------------
# 1 e 2 — quando avisa, e a carência
# ---------------------------------------------------------------------------
class QuandoAvisaTest(_RunMixin):
    def test_a_suite_roda_com_o_alerta_desligado(self):
        # Sanidade da rede de segurança (tests/conftest.py): sem ela, um READER_ALERT_TO no
        # .env do DEV faria os testes de outros arquivos falarem SMTP com o servidor real.
        self.assertNotIn("READER_ALERT_TO", os.environ)

    def test_avisa_com_61_minutos_parado_e_nao_com_59(self):
        summary, ctrl, sessao, _p, _a = self._run(pendentes={"<mid-1>": _pending(61)})
        self.assertEqual(summary["alert"], A.OUTCOME_SENT)
        self.assertEqual(len(sessao.envios), 1)
        self.assertEqual(summary["deferred"], 3)

        summary, ctrl, sessao, _p, abrir = self._run(pendentes={"<mid-1>": _pending(59)})
        self.assertEqual(summary["alert"], A.OUTCOME_NOT_DUE)
        self.assertEqual(sessao.envios, [])
        abrir.assert_not_called()
        ctrl.stamp_alerted.assert_not_called()

    def test_adiado_pela_primeira_vez_neste_run_nao_avisa(self):
        # API fora, três adiados, NENHUM tinha linha antes: o 1º falhou agora e os outros dois
        # acabaram de ganhar o marcador. Ninguém está "parado" — acabou de acontecer.
        summary, ctrl, sessao, _p, _a = self._run(pendentes={})
        self.assertEqual(summary["deferred"], 3)
        self.assertEqual(summary["alert"], A.OUTCOME_NOT_DUE)
        self.assertEqual(sessao.envios, [])

    def test_parado_adiado_pelo_breaker_tambem_dispara(self):
        # O e-mail parado é o 2º: nem chega a ser tentado, é adiado porque o 1º abriu o breaker.
        summary, _ctrl, sessao, process, _a = self._run(pendentes={"<mid-2>": _pending(90)})
        self.assertEqual([c.args[1] for c in process.call_args_list], [b"1"])
        self.assertEqual(summary["alert"], A.OUTCOME_SENT)
        self.assertEqual(len(sessao.envios), 1)

    def test_parado_em_falha_isolada_tambem_dispara(self):
        # API SAUDÁVEL: só o e-mail 1 falha, os outros são lidos. Ele está parado há 2 h.
        summary, _ctrl, sessao, _p, _a = self._run(
            sonda=(True, None), pendentes={"<mid-1>": _pending(120)})
        self.assertEqual((summary["deferred"], summary["isolated"], summary["processed"]),
                         (1, 1, 2))
        self.assertEqual(summary["alert"], A.OUTCOME_SENT)
        self.assertIn("1 e-mail financeiro aguardando", sessao.envios[0]["subject"])

    def test_linha_antiga_de_email_que_nao_foi_adiado_neste_run_nao_dispara(self):
        # Pendência velha de um e-mail que já saiu da janela: o run não o tentou, então não é
        # dele que este run pode falar. (Os adiados de agora são todos de 1ª vez.)
        summary, _ctrl, sessao, _p, _a = self._run(
            pendentes={"<fora-da-janela>": _pending(3 * 24 * 60)})
        self.assertEqual(summary["alert"], A.OUTCOME_NOT_DUE)
        self.assertEqual(sessao.envios, [])

    def test_run_sem_adiado_nem_avalia_o_alerta(self):
        summary, _ctrl, sessao, _p, abrir = self._run(
            falham=(), pendentes={"<fora-da-janela>": _pending(3 * 24 * 60)})
        self.assertEqual((summary["deferred"], summary["processed"]), (0, 3))
        self.assertIsNone(summary["alert"])
        abrir.assert_not_called()

    def test_data_ilegivel_ou_ausente_conta_como_parado(self):
        for logged_at in ("lixo", None, "2126-01-01T00:00:00+00:00"):
            with self.subTest(logged_at=logged_at):
                entrada = _pending(10)
                entrada["logged_at"] = logged_at
                summary, _ctrl, sessao, _p, _a = self._run(pendentes={"<mid-1>": entrada})
                self.assertEqual(summary["alert"], A.OUTCOME_SENT)
                self.assertEqual(len(sessao.envios), 1)

    def test_carencia_bloqueia_com_5h59_e_libera_com_6h01(self):
        parado = 8 * 60
        summary, ctrl, sessao, _p, abrir = self._run(
            pendentes={"<mid-1>": _pending(parado, alerted_minutes_ago=5 * 60 + 59)})
        self.assertEqual(summary["alert"], A.OUTCOME_COOLDOWN)
        self.assertEqual(sessao.envios, [])
        abrir.assert_not_called()
        ctrl.stamp_alerted.assert_not_called()

        summary, _ctrl, sessao, _p, _a = self._run(
            pendentes={"<mid-1>": _pending(parado, alerted_minutes_ago=6 * 60 + 1)})
        self.assertEqual(summary["alert"], A.OUTCOME_SENT)
        self.assertEqual(len(sessao.envios), 1)

    def test_carimbo_de_outra_pendencia_tambem_segura_o_alerta(self):
        # O carimbo vive em TODAS as linhas citadas: a mais antiga concluiu e sumiu, mas a de
        # outro e-mail do mesmo aviso ainda está lá — o alerta não repete dentro da carência.
        summary, _ctrl, sessao, _p, _a = self._run(pendentes={
            "<mid-1>": _pending(8 * 60),
            "<mid-3>": _pending(8 * 60, alerted_minutes_ago=30)})
        self.assertEqual(summary["alert"], A.OUTCOME_COOLDOWN)
        self.assertEqual(sessao.envios, [])

    def test_carimbo_no_futuro_ou_ilegivel_nao_cala_o_alerta(self):
        # 🔴 Um `alerted_at` corrompido (ano 2126) deixaria "agora − carimbo" negativo, logo
        # "dentro da carência", PARA SEMPRE: o alerta se calaria sozinho, sem erro.
        for carimbo in ("2126-01-01T00:00:00+00:00", "lixo", 123):
            with self.subTest(carimbo=carimbo):
                entrada = _pending(8 * 60)
                entrada[R.ALERTED_AT_KEY] = carimbo
                summary, _ctrl, sessao, _p, _a = self._run(pendentes={"<mid-1>": entrada})
                self.assertEqual(summary["alert"], A.OUTCOME_SENT)
                self.assertEqual(len(sessao.envios), 1)


# ---------------------------------------------------------------------------
# 3 — interruptor
# ---------------------------------------------------------------------------
class InterruptorTest(_RunMixin):
    def test_sem_destinatario_o_alerta_fica_desligado(self):
        for valor in (None, "", "  ,  ; "):
            with self.subTest(READER_ALERT_TO=valor):
                summary, ctrl, sessao, _p, abrir = self._run(
                    pendentes={"<mid-1>": _pending(8 * 60)}, env={"READER_ALERT_TO": valor})
                self.assertEqual(summary["alert"], A.OUTCOME_DISABLED)
                self.assertEqual(sessao.envios, [])
                abrir.assert_not_called()
                ctrl.stamp_alerted.assert_not_called()

    def test_dry_run_nao_avalia_nem_envia(self):
        summary, ctrl, sessao, _p, abrir = self._run(
            pendentes={"<mid-1>": _pending(8 * 60)}, dry_run=True)
        self.assertGreater(summary["deferred"], 0)      # havia o que alertar
        self.assertIsNone(summary["alert"])
        self.assertEqual(sessao.envios, [])
        abrir.assert_not_called()
        ctrl.stamp_alerted.assert_not_called()

    def test_dev_mode_sem_caixa_de_teste_nao_envia(self):
        summary, ctrl, sessao, _p, abrir = self._run(
            pendentes={"<mid-1>": _pending(8 * 60)},
            env={"DEV_MODE": "true", "DEV_OVERRIDE_EMAIL": ""})
        self.assertEqual(summary["alert"], A.OUTCOME_SEND_FAILED)
        abrir.assert_not_called()
        ctrl.stamp_alerted.assert_not_called()

    def test_dev_mode_envia_uma_vez_para_a_caixa_de_teste(self):
        summary, _ctrl, sessao, _p, abrir = self._run(
            pendentes={"<mid-1>": _pending(8 * 60)},
            env={"DEV_MODE": "true", "DEV_OVERRIDE_EMAIL": "teste@otimotex.com.br",
                 "READER_ALERT_TO": "a@otimotex.com.br, b@otimotex.com.br"})
        self.assertEqual(summary["alert"], A.OUTCOME_SENT)
        # A sessão é quem redireciona; o alerta só lhe entrega o modo e NÃO repete o envio.
        abrir.assert_called_once_with(True, "teste@otimotex.com.br")
        self.assertEqual(len(sessao.envios), 1)


# ---------------------------------------------------------------------------
# 4 — carimbo (pelo run_reader)
# ---------------------------------------------------------------------------
class CarimboNoRunTest(_RunMixin):
    def test_carimba_todas_as_linhas_citadas_com_o_mesmo_instante(self):
        antes = datetime.now(timezone.utc)
        summary, ctrl, sessao, _p, _a = self._run(pendentes={"<mid-2>": _pending(90)})
        self.assertEqual(summary["alert"], A.OUTCOME_SENT)
        # O parado primeiro; depois os demais adiados do run — TODOS, não só o parado.
        self.assertEqual(self._carimbados(ctrl), ["<mid-2>", "<mid-1>", "<mid-3>"])
        instantes = {chamada.args[1] for chamada in ctrl.stamp_alerted.call_args_list}
        self.assertEqual(len(instantes), 1)
        carimbo = datetime.fromisoformat(instantes.pop())
        self.assertIsNotNone(carimbo.tzinfo)
        self.assertLess(abs((carimbo - antes).total_seconds()), 60)
        self.assertIn("3 e-mails financeiros aguardando", sessao.envios[0]["subject"])

    def test_falha_de_smtp_nao_carimba(self):
        for falha in (smtplib.SMTPServerDisconnected("caiu"), OSError("timeout"),
                      smtplib.SMTPAuthenticationError(535, b"auth"), RuntimeError("bug")):
            with self.subTest(falha=type(falha).__name__):
                summary, ctrl, sessao, _p, _a = self._run(
                    pendentes={"<mid-1>": _pending(8 * 60)}, sessao=_FakeSession(falha=falha))
                self.assertEqual(summary["alert"], A.OUTCOME_SEND_FAILED)
                # Sem carimbo, o próximo run tenta avisar de novo.
                ctrl.stamp_alerted.assert_not_called()
                self.assertTrue(sessao.fechada)

    def test_o_envio_acontece_depois_do_logout_do_imap(self):
        # O envio fala SMTP (até 30 s por operação): não pode segurar a conexão IMAP aberta.
        estados = []
        sessao = _FakeSession(antes_do_envio=lambda: estados.append(self.mail.logged_out))
        self._run(pendentes={"<mid-1>": _pending(8 * 60)}, sessao=sessao)
        self.assertEqual(estados, [True])


# ---------------------------------------------------------------------------
# 4 — carimbo (contrato HTTP de SupabaseControl)
# ---------------------------------------------------------------------------
class CarimboHttpTest(unittest.TestCase):
    MID = "<abc+1@x.com.br>"
    QUANDO = "2026-11-24T12:00:00+00:00"

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

    def test_carimbo_grava_na_linha_mais_antiga_preservando_o_contador(self):
        linha = [{"id": 458, "raw_payload": {"source_file": "a.png",
                                             R.ISOLATED_FAILURES_KEY: 4}}]
        ctrl = self._ctrl()
        ok, reqs = self._capture(lambda: ctrl.stamp_alerted(self.MID, self.QUANDO),
                                 [json.dumps(linha).encode(), b""])
        self.assertIs(ok, True)
        self.assertEqual([r.get_method() for r in reqs], ["GET", "PATCH"])
        mid_enc = R.urllib.parse.quote(self.MID, safe="")
        self.assertIn(f"gmail_message_id=eq.{mid_enc}", reqs[0].full_url)
        self.assertIn("error_type=eq.erro_api", reqs[0].full_url)
        self.assertIn("order=id.asc", reqs[0].full_url)
        self.assertTrue(reqs[1].full_url.endswith("email_processing_errors?id=eq.458"))
        self.assertEqual(json.loads(reqs[1].data), {"raw_payload": {
            "source_file": "a.png", R.ISOLATED_FAILURES_KEY: 4,
            R.ALERTED_AT_KEY: self.QUANDO}})

    def test_contador_preserva_o_carimbo(self):
        # Os dois moram no MESMO objeto JSON e o PATCH substitui a coluna inteira: contar a
        # falha não pode apagar o carimbo (o alerta repetiria a cada run).
        linha = [{"id": 9, "raw_payload": {R.ALERTED_AT_KEY: self.QUANDO,
                                           R.ISOLATED_FAILURES_KEY: 2}}]
        ctrl = self._ctrl()
        novo, reqs = self._capture(lambda: ctrl.bump_isolated_failures(self.MID),
                                   [json.dumps(linha).encode(), b""])
        self.assertEqual(novo, 3)
        self.assertEqual(json.loads(reqs[1].data), {"raw_payload": {
            R.ALERTED_AT_KEY: self.QUANDO, R.ISOLATED_FAILURES_KEY: 3}})

    def test_payload_que_nao_e_objeto_vira_objeto_com_o_carimbo(self):
        for bruto in (None, "texto solto", ["lista"]):
            with self.subTest(raw_payload=bruto):
                linha = [{"id": 1, "raw_payload": bruto}]
                ok, reqs = self._capture(
                    lambda: self._ctrl().stamp_alerted(self.MID, self.QUANDO),
                    [json.dumps(linha).encode(), b""])
                self.assertIs(ok, True)
                self.assertEqual(json.loads(reqs[1].data),
                                 {"raw_payload": {R.ALERTED_AT_KEY: self.QUANDO}})

    def test_sem_linha_com_falha_ou_indisponivel_devolve_false_sem_levantar(self):
        ctrl = self._ctrl()
        ok, reqs = self._capture(lambda: ctrl.stamp_alerted(self.MID, self.QUANDO), [b"[]"])
        self.assertIs(ok, False)
        self.assertEqual([r.get_method() for r in reqs], ["GET"])        # nenhum PATCH
        with self.assertLogs(R.log, level="WARNING"):
            ok, _ = self._capture(lambda: ctrl.stamp_alerted(self.MID, self.QUANDO),
                                  error=OSError("timeout"))
        self.assertIs(ok, False)
        ok, reqs = self._capture(lambda: ctrl.stamp_alerted(None, self.QUANDO))
        self.assertEqual((ok, reqs), (False, []))
        ok, reqs = self._capture(
            lambda: self._ctrl(available=False).stamp_alerted(self.MID, self.QUANDO))
        self.assertEqual((ok, reqs), (False, []))

    def test_marcador_de_adiado_nasce_com_a_data_de_agora(self):
        # É o que impede o e-mail adiado pela 1ª vez de parecer "parado há tempos".
        ctrl, pendentes = mock.MagicMock(), {}
        R._mark_deferred(ctrl, pendentes, {"message_id": "<novo>", "received_at": None}, "529")
        entrada = pendentes["<novo>"]
        idade = datetime.now(timezone.utc) - A.parse_instant(entrada["logged_at"])
        self.assertLess(abs(idade.total_seconds()), 60)
        self.assertIsNone(entrada[R.ALERTED_AT_KEY])
        self.assertEqual(A.select_stuck({"<novo>": {}}, pendentes, datetime.now(timezone.utc)), [])

    def test_as_chaves_lidas_pelo_modulo_sao_as_gravadas_pelo_leitor(self):
        self.assertEqual(A.PENDING_ALERTED_AT_KEY, R.ALERTED_AT_KEY)
        entrada = _pending(5, alerted_minutes_ago=1)
        self.assertIn(A.PENDING_LOGGED_AT_KEY, entrada)
        self.assertIn(A.PENDING_ALERTED_AT_KEY, entrada)


# ---------------------------------------------------------------------------
# 5 — o leitor ignora o próprio alerta
# ---------------------------------------------------------------------------
class LeitorIgnoraOAlertaTest(_RunMixin):
    ASSUNTO = A.build_subject(MARKER, 3)

    def _run_um(self, assunto, remetente):
        forca = mock.MagicMock(return_value=False)
        summary, ctrl, _sessao, process, _a = self._run(
            mensagens={b"1": (assunto, remetente)}, falham=(),
            patches={"_message_forces_account": forca})
        return summary, ctrl, process, forca

    def _nota(self, ctrl) -> str:
        (registro,), _ = ctrl.register.call_args
        return f"{registro['status']}|{registro['notes']}"

    def test_resposta_interna_ao_alerta_e_ignorada_sem_ler_o_corpo(self):
        for assunto in (f"RES: {self.ASSUNTO}", f"ENC: Re: {self.ASSUNTO.lower()}"):
            with self.subTest(assunto=assunto):
                summary, ctrl, process, forca = self._run_um(
                    assunto, "Maria <maria@otimotex.com.br>")
                self.assertEqual(summary["skipped_keyword"], 1)
                process.assert_not_called()
                # 🔴 O corpo do alerta LISTA assuntos de terceiros (pode citar "honorários"):
                # o filtro tem de decidir ANTES de qualquer leitura do corpo.
                forca.assert_not_called()
                self.assertTrue(self._nota(ctrl).startswith("ignorado|Alerta do leitor"))

    def test_o_proprio_alerta_e_ignorado_pelo_remetente_de_envio_e_pelo_mailbox(self):
        for remetente in (FROM_ADDR, MAILBOX.upper()):
            with self.subTest(remetente=remetente):
                _summary, ctrl, process, forca = self._run_um(self.ASSUNTO, remetente)
                process.assert_not_called()
                forca.assert_not_called()
                self.assertTrue(self._nota(ctrl).startswith("ignorado|Alerta do leitor"))

    def test_marcador_vindo_de_externo_segue_o_fluxo_normal(self):
        # 🔴 Sem a condição de remetente, qualquer fornecedor esconderia um boleto do leitor
        # escrevendo o marcador no assunto.
        _summary, _ctrl, process, _forca = self._run_um(
            f"{MARKER} Boleto vencendo", "cobranca@fornecedor.com.br")
        process.assert_called_once()

        summary, ctrl, process, forca = self._run_um(self.ASSUNTO, "x@fornecedor.com.br")
        process.assert_not_called()
        forca.assert_called_once()                       # passou pelos filtros de sempre
        self.assertEqual(self._nota(ctrl), "ignorado|Fora do filtro de assunto (não-financeiro)")
        self.assertEqual(summary["skipped_keyword"], 1)

    def test_interno_sem_o_marcador_segue_o_fluxo_normal(self):
        _summary, _ctrl, process, _forca = self._run_um("Boleto 123", "maria@otimotex.com.br")
        process.assert_called_once()

    def test_o_assunto_do_alerta_nao_parece_financeiro(self):
        # Sanidade do parser da lista de produção de exemplo — sem ela, uma lista vazia
        # deixaria o laço abaixo verde para sempre.
        exemplo = next(linha.split("=", 1)[1].split(",")
                       for linha in (_ROOT / ".env.example").read_text(encoding="utf-8").splitlines()
                       if linha.startswith("EMAIL_KEYWORDS="))
        self.assertGreater(len(exemplo), 10)
        self.assertIn("boleto", exemplo)
        for total in (1, 3, 250):
            assunto = A.build_subject(MARKER, total)
            for prefixo in ("", "RES: ", "ENC: "):
                with self.subTest(assunto=prefixo + assunto):
                    self.assertIsNone(R.match_keyword(prefixo + assunto, R.KEYWORDS_DEFAULT))
                    self.assertIsNone(R.match_keyword(prefixo + assunto, exemplo))
                    self.assertFalse(R.subject_is_reminder(prefixo + assunto))
                    self.assertFalse(R.subject_is_payment_confirmation(prefixo + assunto))
            # ASCII puro: o cabeçalho não é codificado (RFC 2047) e o marcador chega literal.
            self.assertTrue(assunto.isascii())
            self.assertIn(MARKER, assunto)
        self.assertTrue(A.ALERT_FROM_NAME.isascii())


# ---------------------------------------------------------------------------
# 6 — robustez da ponte
# ---------------------------------------------------------------------------
class RobustezTest(_RunMixin):
    def test_modulo_ausente_avisa_no_log_e_o_run_termina(self):
        with mock.patch.object(R, "_READER_ALERT", None), \
                mock.patch.object(R, "_READER_ALERT_WARNED", False), \
                mock.patch.dict(sys.modules, {"reader_alert": None}), \
                self.assertLogs(R.log, level="WARNING") as logs:
            summary, _ctrl, sessao, _p, _a = self._run(pendentes={"<mid-1>": _pending(8 * 60)})
        self.assertIsNone(summary["alert"])
        self.assertEqual(summary["deferred"], 3)
        self.assertEqual(sessao.envios, [])
        self.assertTrue(any("reader_alert" in linha and "Deploy parcial" in linha
                            for linha in logs.output))

    def test_excecao_dentro_do_alerta_nao_derruba_o_run(self):
        with mock.patch.object(A, "notify_stuck", side_effect=RuntimeError("bug no alerta")), \
                self.assertLogs(R.log, level="ERROR"):
            summary, _ctrl, _sessao, _p, _a = self._run(
                sonda=(True, None), pendentes={"<mid-1>": _pending(8 * 60)})
        self.assertEqual(summary["alert"], "erro")
        self.assertEqual((summary["processed"], summary["deferred"]), (2, 1))

    def test_sessao_que_nao_abre_vira_falha_de_envio(self):
        with mock.patch.object(A, "_open_session", side_effect=FileNotFoundError("email_sender")), \
                self.assertLogs(A.log, level="ERROR") as logs:
            aceitos = A._send(["ti@otimotex.com.br"], "assunto", "<p>x</p>")
        self.assertEqual(aceitos, 0)
        self.assertTrue(any("Deploy parcial" in linha for linha in logs.output))


# ---------------------------------------------------------------------------
# 7 — envio e conteúdo
# ---------------------------------------------------------------------------
class EnvioTest(_RunMixin):
    def test_um_envio_por_destinatario_sem_assinatura_e_sem_copia(self):
        summary, _ctrl, sessao, _p, abrir = self._run(
            pendentes={"<mid-1>": _pending(8 * 60)},
            env={"READER_ALERT_TO": "a@otimotex.com.br, b@lebianco.com.br;a@OTIMOTEX.com.br"})
        self.assertEqual(summary["alert"], A.OUTCOME_SENT)
        abrir.assert_called_once_with(False, "")
        self.assertEqual([e["to"] for e in sessao.envios],
                         ["a@otimotex.com.br", "b@lebianco.com.br"])
        self.assertTrue(all(e["cc"] is None and e["signature"] is False for e in sessao.envios))
        self.assertTrue(all(e["subject"].startswith(MARKER) for e in sessao.envios))
        self.assertTrue(sessao.fechada)

    def test_conteudo_de_terceiros_sai_escapado(self):
        mensagens = {b"1": ("Boleto <script>alert(1)</script> & cia", "Ana <ana@exemplo.com.br>"),
                     b"2": ("Boleto 2", "ok@exemplo.com.br")}
        _summary, _ctrl, sessao, _p, _a = self._run(
            mensagens=mensagens, pendentes={"<mid-1>": _pending(8 * 60)})
        corpo = sessao.envios[0]["html"]
        self.assertNotIn("<script>", corpo)
        self.assertIn("Boleto &lt;script&gt;alert(1)&lt;/script&gt; &amp; cia", corpo)
        self.assertIn(">ana@exemplo.com.br<", corpo)
        self.assertIn("8 h 0 min", corpo)
        # O adiado de 1ª vez também é listado — e não como "parado há 0 min".
        self.assertIn("Boleto 2", corpo)
        self.assertEqual(corpo.count("adiado agora (1ª vez)"), 1)
        self.assertNotIn(">0 min<", corpo)
        self.assertIn("Error code: 529", corpo)          # o motivo da recusa da API
        # O assunto do alerta é texto FIXO: nada de terceiros vai para o cabeçalho.
        self.assertNotIn("script", sessao.envios[0]["subject"])

    def test_motivo_e_remetente_tambem_sao_escapados(self):
        agora = datetime.now(timezone.utc)
        corpo = A.render_alert(
            ["<m1>"], {"<m1>": {"subject": "x", "sender_email": "a<b>@x.com",
                                "received_at": "2026-11-24T12:00:00.5Z"}},
            {"<m1>": {"logged_at": (agora - timedelta(hours=2, minutes=15)).isoformat()}},
            agora, reason="<img src=x onerror=alert(1)>")
        self.assertNotIn("<img", corpo)
        self.assertIn("&lt;img src=x onerror=alert(1)&gt;", corpo)
        self.assertIn("a&lt;b&gt;@x.com", corpo)
        self.assertIn("2 h 15 min", corpo)
        self.assertRegex(corpo, r"24/11/2026 \d{2}:00")

    def test_lista_e_truncada_mas_o_total_e_declarado(self):
        agora = datetime.now(timezone.utc)
        total = A.ALERT_MAX_LISTED + 7
        ids = [f"<m{i}>" for i in range(total)]
        corpo = A.render_alert(ids, {mid: {"subject": f"Assunto {mid}"} for mid in ids},
                               {}, agora, reason=None)
        self.assertEqual(corpo.count("<tr>"), A.ALERT_MAX_LISTED)   # o cabeçalho é `<tr style…>`
        self.assertEqual(corpo.count("<tr"), A.ALERT_MAX_LISTED + 1)
        self.assertIn(f"não conseguiu ler {total} e-mails", corpo)
        self.assertIn("Mais 7 e-mails", corpo)
        self.assertIn("não informado", corpo)

    def test_recusa_de_um_destinatario_nao_impede_os_demais(self):
        sessao = _FakeSession(falha={"a@x.com": smtplib.SMTPRecipientsRefused({"a@x.com": (550, b"no")})})
        with _env(), mock.patch.object(A, "_open_session", return_value=sessao):
            aceitos = A._send(["a@x.com", "b@x.com"], "assunto", "<p>x</p>")
        self.assertEqual(aceitos, 1)
        self.assertEqual([e["to"] for e in sessao.envios], ["b@x.com"])

    def test_falha_do_servidor_nao_insiste_nos_demais(self):
        # Servidor fora: cada tentativa custaria um timeout inteiro, com o run esperando.
        tentados = []
        sessao = _FakeSession(falha=OSError("timed out"),
                              antes_do_envio=lambda: tentados.append(1))
        with _env(), mock.patch.object(A, "_open_session", return_value=sessao):
            aceitos = A._send(["a@x.com", "b@x.com", "c@x.com"], "assunto", "<p>x</p>")
        self.assertEqual((aceitos, len(tentados)), (0, 1))

    def test_email_sender_antigo_sem_o_parametro_ainda_envia(self):
        class _SessaoAntiga(_FakeSession):
            def send(self, *, to_email, cc_email, subject, html_body):  # sem `signature`
                self.envios.append({"to": to_email})

        sessao = _SessaoAntiga()
        with _env(), mock.patch.object(A, "_open_session", return_value=sessao), \
                self.assertLogs(A.log, level="WARNING") as logs:
            aceitos = A._send(["a@x.com"], "assunto", "<p>x</p>")
        self.assertEqual((aceitos, sessao.envios), (1, [{"to": "a@x.com"}]))
        self.assertTrue(any("Deploy parcial" in linha for linha in logs.output))

    def test_destinatarios_invalidos_sao_descartados(self):
        with self.assertLogs(A.log, level="WARNING"):
            lidos = A.parse_recipients(
                "a@x.com, B@Y.com ;a@X.com, sem-arroba, x@y, @x.com, a@@x.com, "
                "z@w.com\r\nBcc: evil@e.com, <b@x.com>, ok@d.com.br, "
                # Quebra de linha SEM um segundo "@": só a checagem de caractere a barra.
                "q@w.com\r\nX-Injetado: 1, com espaco@x.com")
        self.assertEqual(lidos, ["a@x.com", "B@Y.com", "ok@d.com.br"])
        self.assertEqual(A.parse_recipients(None), [])

    def test_carimbo_respeita_o_teto_de_tempo_e_sobrevive_a_excecao(self):
        chamados = []

        def _stamp(message_id, _when):
            chamados.append(message_id)
            if message_id == "<b>":
                raise RuntimeError("falha neste")
            return message_id != "<c>"

        with self.assertLogs(A.log, level="ERROR"):
            gravados = A._stamp_all(["<a>", "<b>", "<c>", "<d>"], _stamp, "2026-11-24T12:00:00+00:00")
        self.assertEqual((chamados, gravados), (["<a>", "<b>", "<c>", "<d>"], 2))

        # Relógio: prazo calculado em 0 s; 1ª linha em 1 s (dentro); 2ª já além do teto.
        relogio = [0.0, 1.0, A.ALERT_STAMP_BUDGET_SECONDS + 1.0]
        chamados.clear()
        with mock.patch.object(A.time, "monotonic", side_effect=relogio), \
                self.assertLogs(A.log, level="WARNING"):
            gravados = A._stamp_all(["<a>", "<d>", "<e>"], _stamp, "x")
        self.assertEqual((chamados, gravados), (["<a>"], 1))

    def test_instantes_em_varios_formatos(self):
        utc = timezone.utc
        casos = {
            "2026-11-24T10:30:00.5+00:00": datetime(2026, 11, 24, 10, 30, 0, 500000, utc),
            "2026-11-24T10:30:00.123456789Z": datetime(2026, 11, 24, 10, 30, 0, 123456, utc),
            "2026-11-24 10:30:00.12+00": datetime(2026, 11, 24, 10, 30, 0, 120000, utc),
            "2026-11-24T10:30:00": datetime(2026, 11, 24, 10, 30, tzinfo=utc),
            "2026-11-24": datetime(2026, 11, 24, tzinfo=utc),
        }
        for texto, esperado in casos.items():
            with self.subTest(texto=texto):
                self.assertEqual(A.parse_instant(texto), esperado)
        self.assertEqual(A.parse_instant("2026-11-24T10:30:00-03:00"),
                         datetime(2026, 11, 24, 13, 30, tzinfo=utc))
        for ilegivel in ("", None, "lixo", 12345, "2026-13-45T99:00:00"):
            with self.subTest(ilegivel=ilegivel):
                self.assertIsNone(A.parse_instant(ilegivel))


class TesteDoCanalTest(unittest.TestCase):
    """`reader_alert.py --test`: prova, depois de um deploy, que o aviso chega a alguém."""

    def _main(self, argv, env=None, sessao=None):
        sessao = sessao or _FakeSession()
        with _env(env), mock.patch.object(A, "_open_session", return_value=sessao) as abrir:
            codigo = A.main(argv)
        return codigo, sessao, abrir

    def test_envia_um_teste_por_destinatario_e_sai_com_zero(self):
        codigo, sessao, _abrir = self._main(
            ["--test"], env={"READER_ALERT_TO": "a@otimotex.com.br,b@otimotex.com.br"})
        self.assertEqual(codigo, 0)
        self.assertEqual([e["to"] for e in sessao.envios],
                         ["a@otimotex.com.br", "b@otimotex.com.br"])
        assunto = sessao.envios[0]["subject"]
        # Com o marcador: a resposta ao teste também é ignorada pelo leitor.
        self.assertTrue(assunto.startswith(MARKER))
        self.assertIn("TESTE", assunto)
        self.assertTrue(assunto.isascii())
        self.assertIsNone(R.match_keyword(assunto, R.KEYWORDS_DEFAULT))
        self.assertTrue(R._is_reader_alert_thread(f"RES: {assunto}", "maria@otimotex.com.br"))
        self.assertIn("Nenhum e-mail está parado", sessao.envios[0]["html"])
        self.assertIs(sessao.envios[0]["signature"], False)

    def test_sem_destinatario_ou_com_smtp_fora_sai_com_um(self):
        with self.assertLogs(A.log, level="ERROR") as logs:
            codigo, sessao, abrir = self._main(["--test"], env={"READER_ALERT_TO": None})
        self.assertEqual((codigo, sessao.envios), (1, []))
        abrir.assert_not_called()
        self.assertTrue(any("DESLIGADO" in linha for linha in logs.output))

        with self.assertLogs(A.log, level="ERROR"):
            codigo, sessao, _abrir = self._main(
                ["--test"], sessao=_FakeSession(falha=OSError("timed out")))
        self.assertEqual((codigo, sessao.envios), (1, []))

    def test_sem_argumento_so_mostra_o_uso(self):
        with mock.patch("sys.stdout"):
            codigo, sessao, abrir = self._main([])
        self.assertEqual((codigo, sessao.envios), (2, []))
        abrir.assert_not_called()


class _FakeSMTP:
    """Dublê de `smtplib.SMTP`: grava o que o `email_sender` REAL manda ao servidor."""
    instancias: list = []

    def __init__(self, host, port, timeout=None):
        self.host, self.port, self.timeout = host, port, timeout
        self.tls = None
        self.credenciais = None
        self.enviados = []
        _FakeSMTP.instancias.append(self)

    def ehlo(self):
        pass

    def starttls(self, context=None):
        self.tls = context

    def login(self, user, password):
        self.credenciais = (user, password)

    def sendmail(self, from_addr, to_addrs, raw):
        self.enviados.append((from_addr, list(to_addrs), raw))

    def quit(self):
        pass


class EnvioRealAteOSmtpTest(unittest.TestCase):
    """`reader_alert` → `email_sender.SmtpSession` REAL, com só o socket dublado."""

    ENV_SMTP = {"SMTP_HOST": "smtp.teste.local", "SMTP_PORT": "587", "SMTP_PASSWORD": "segredo",
                "SMTP_USER": None, "SMTP_FROM_NAME": None}

    def setUp(self):
        _FakeSMTP.instancias = []

    @staticmethod
    def _sender_com_assinatura():
        modulo = _LOAD_EMAIL_SENDER()
        modulo._SIGNATURE_BYTES = PNG          # não depende do arquivo de assinatura existir
        return modulo

    def _tipos(self, raw: str) -> list:
        return [parte.get_content_type() for parte in email.message_from_string(raw).walk()]

    def test_alerta_sai_sem_a_imagem_com_from_de_envio_e_reply_to_no_mailbox(self):
        with _env(self.ENV_SMTP), mock.patch.object(smtplib, "SMTP", _FakeSMTP), \
                mock.patch.object(A, "_load_email_sender", self._sender_com_assinatura):
            aceitos = A._send(["ti@otimotex.com.br"], A.build_subject(MARKER, 2),
                              "<p>corpo do alerta</p>")
        self.assertEqual(aceitos, 1)
        (smtp,) = _FakeSMTP.instancias
        self.assertEqual((smtp.host, smtp.port), ("smtp.teste.local", 587))
        self.assertIsNotNone(smtp.timeout)
        self.assertEqual(smtp.tls.minimum_version, ssl.TLSVersion.TLSv1_2)
        self.assertEqual(smtp.credenciais, (FROM_ADDR, "segredo"))
        ((from_addr, to_addrs, raw),) = smtp.enviados
        self.assertEqual((from_addr, to_addrs), (FROM_ADDR, ["ti@otimotex.com.br"]))
        msg = email.message_from_string(raw)
        self.assertEqual(str(make_header(decode_header(msg["Subject"]))),
                         f"{MARKER} 2 e-mails financeiros aguardando leitura")
        self.assertEqual(msg["From"], f"{A.ALERT_FROM_NAME} <{FROM_ADDR}>")
        # A resposta de quem recebe o alerta volta para o mailbox real — que é a caixa que o
        # leitor lê; daí o leitor precisar ignorar as respostas (LeitorIgnoraOAlertaTest).
        self.assertEqual(msg["Reply-To"], MAILBOX)
        self.assertEqual(msg["To"], "ti@otimotex.com.br")
        self.assertNotIn("image/png", self._tipos(raw))
        self.assertIn("text/html", self._tipos(raw))

    def test_a_cobranca_continua_saindo_com_a_assinatura(self):
        # Contraprova: é o parâmetro que tira a imagem, e o DEFAULT dele preserva a cobrança.
        with _env(self.ENV_SMTP), mock.patch.object(smtplib, "SMTP", _FakeSMTP):
            modulo = self._sender_com_assinatura()
            with modulo.SmtpSession({"email": MAILBOX}) as sessao:
                sessao.send(to_email="cliente@x.com", cc_email=None, subject="Cobranca",
                            html_body="<p>x</p>")
                sessao.send(to_email="cliente@x.com", cc_email=None, subject="Cobranca",
                            html_body="<p>x</p>", signature=False)
        (smtp,) = _FakeSMTP.instancias
        com, sem = (self._tipos(raw) for _from, _to, raw in smtp.enviados)
        self.assertIn("image/png", com)
        self.assertNotIn("image/png", sem)

    def test_o_caminho_do_email_sender_existe(self):
        # O módulo é carregado por CAMINHO; um rename da pasta da cobrança calaria o alerta.
        self.assertTrue(A.EMAIL_SENDER_PATH.is_file(), A.EMAIL_SENDER_PATH)
        self.assertTrue(hasattr(A._load_email_sender(), "SmtpSession"))


if __name__ == "__main__":
    unittest.main()
