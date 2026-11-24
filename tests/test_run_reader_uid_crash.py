"""
test_run_reader_uid_crash.py — uma exceção ao tratar UM e-mail não derruba o run.

Era a outra porta do incidente de 18–21/11/2026. O trecho do laço de `run_reader` que vai da
deduplicação até `process_message` não tinha `try`: uma exceção em qualquer filtro propagava,
o run morria naquele UID e TODO e-mail depois dele — financeiro ou não — ficava sem leitura,
em todo run, até o e-mail sair da janela. E um cabeçalho que quebrasse o parser era `[SKIP]`
eterno, sem registro nenhum.

Garantias:
  1. a exceção é isolada: o e-mail vira `falha` + `processamento_erro`, e o seguinte é lido;
  2. o registro não repete a linha de erro, não roda em `dry_run` e nunca derruba o run;
  3. o tratamento da falha não chama o que acabou de quebrar (`decode_str`);
  4. falha de IMAP no fetch do header continua transitória: `[SKIP]`, sem registro;
  5. e-mail sem Message-ID é registrado como `no-id-<uid>`, como em `process_message`.

A garantia do logout (e a de que `BaseException` ainda propaga) está em
`tests/test_run_reader_logout.py`.
"""

import contextlib
import socket
import sys
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402


def _header(uid: bytes, subject: str, message_id: str | None, sender: str) -> tuple:
    linhas = [f"Subject: {subject}", f"From: Fornecedor <{sender}>",
              "Date: Thu, 19 Nov 2020 15:25:56 -0300"]
    if message_id:
        linhas.append(f"Message-ID: {message_id}")
    raw = ("\r\n".join(linhas) + "\r\n\r\n").encode()
    return ("OK", [(uid + b' (INTERNALDATE "19-Nov-2020 15:25:56 -0300" BODY[HEADER])', raw)])


class _FakeMail:
    def __init__(self, mensagens: dict, fetch_quebrado=()):
        self._mensagens = mensagens          # uid -> (assunto, message_id, remetente)
        self._fetch_quebrado = set(fetch_quebrado)
        self.logged_out = False

    def uid(self, _command, uid, *_args):
        if uid in self._fetch_quebrado:
            raise socket.timeout("timed out")
        return _header(uid, *self._mensagens[uid])

    def logout(self):
        self.logged_out = True


MENSAGENS = {
    b"1": ("Boleto do envenenado", "<mid-1>", "veneno@fornecedor.com.br"),
    b"2": ("Boleto seguinte", "<mid-2>", "ok@fornecedor.com.br"),
}


class _RunMixin(unittest.TestCase):
    def _ctrl(self, has_error=False):
        ctrl = mock.MagicMock()
        ctrl._available = True
        ctrl.load_known_ids.return_value = {"<ja-processado>"}
        ctrl.pending_api_errors.return_value = {}
        ctrl.latest_received_at.return_value = None
        ctrl.is_processed.return_value = False
        ctrl.has_error.return_value = has_error
        return ctrl

    def _run(self, patches: dict, mensagens=None, ctrl=None, dry_run=False, fetch_quebrado=(),
             process_side_effect=None):
        mensagens = MENSAGENS if mensagens is None else mensagens
        mail = _FakeMail(mensagens, fetch_quebrado)
        ctrl = ctrl or self._ctrl()
        process = mock.MagicMock(side_effect=process_side_effect)
        with contextlib.ExitStack() as pilha:
            pilha.enter_context(mock.patch.object(
                R, "_connect_and_search", return_value=(mail, list(mensagens))))
            pilha.enter_context(mock.patch.object(R, "SupabaseControl", return_value=ctrl))
            pilha.enter_context(mock.patch.object(R, "process_message", process))
            for nome, substituto in patches.items():
                pilha.enter_context(mock.patch.object(R, nome, substituto))
            summary = R.run_reader(days=1, dry_run=dry_run)
        return summary, ctrl, process, mail

    @staticmethod
    def _quebra_no_remetente(alvo: str, original=R.is_ignored_sender):
        """`is_ignored_sender` que levanta só para UM remetente — o resto segue o real."""
        def _filtro(sender_email):
            if sender_email == alvo:
                raise RuntimeError("regex explodiu neste remetente")
            return original(sender_email)
        return mock.MagicMock(side_effect=_filtro)


class ExcecaoNoFiltroTest(_RunMixin):
    def test_o_email_vira_falha_e_o_seguinte_e_lido(self):
        filtro = self._quebra_no_remetente("veneno@fornecedor.com.br")
        summary, ctrl, process, mail = self._run({"is_ignored_sender": filtro})

        self.assertEqual((summary["crashed"], summary["processed"]), (1, 1))
        # 🔴 O e-mail POSTERIOR ao que quebrou foi tratado — antes, o run morria ali.
        self.assertEqual([c.args[1] for c in process.call_args_list], [b"2"])
        self.assertTrue(mail.logged_out)

        (registro,), _ = ctrl.register.call_args
        self.assertEqual((registro["message_id"], registro["status"]), ("<mid-1>", "falha"))
        self.assertEqual(registro["subject"], "Boleto do envenenado")
        self.assertEqual(registro["sender_email"], "veneno@fornecedor.com.br")
        self.assertIn("RuntimeError", registro["notes"])
        self.assertIn("regex explodiu", registro["notes"])
        # Data de CHEGADA (INTERNALDATE), não a do processamento — /emails ordena por ela.
        self.assertTrue(registro["received_at"].startswith("2020-11-19"))

        ctrl.register_error.assert_called_once()
        _rec, tipo, mensagem = ctrl.register_error.call_args.args
        self.assertEqual(tipo, "processamento_erro")
        self.assertIn("regex explodiu", mensagem)

    def test_falha_ja_registrada_nao_repete_a_linha_de_erro(self):
        filtro = self._quebra_no_remetente("veneno@fornecedor.com.br")
        _summary, ctrl, _process, _mail = self._run({"is_ignored_sender": filtro},
                                                    ctrl=self._ctrl(has_error=True))
        ctrl.has_error.assert_called_once_with("<mid-1>", "processamento_erro")
        ctrl.register_error.assert_not_called()
        ctrl.register.assert_called_once()           # o registro é idempotente no banco

    def test_dry_run_conta_mas_nao_grava(self):
        filtro = self._quebra_no_remetente("veneno@fornecedor.com.br")
        summary, ctrl, _process, _mail = self._run({"is_ignored_sender": filtro}, dry_run=True)
        self.assertEqual(summary["crashed"], 1)
        ctrl.register.assert_not_called()
        ctrl.register_error.assert_not_called()

    def test_o_proprio_registro_falhando_nao_derruba_o_run(self):
        filtro = self._quebra_no_remetente("veneno@fornecedor.com.br")
        ctrl = self._ctrl()
        ctrl.register.side_effect = OSError("supabase fora")
        with self.assertLogs(R.log, level="ERROR"):
            summary, _ctrl, process, mail = self._run({"is_ignored_sender": filtro}, ctrl=ctrl)
        self.assertEqual((summary["crashed"], summary["processed"]), (1, 1))
        self.assertEqual([c.args[1] for c in process.call_args_list], [b"2"])
        self.assertTrue(mail.logged_out)

    def test_sem_defeito_nada_e_contado_como_erro(self):
        # Sanidade do dublê: se o próprio cenário de teste levantasse, os casos acima
        # contariam essa exceção como "o defeito isolado" e passariam pelo motivo errado.
        summary, ctrl, process, _mail = self._run({})
        self.assertEqual((summary["crashed"], summary["processed"]), (0, 2))
        ctrl.register.assert_not_called()             # quem registra é o process_message real
        self.assertEqual(process.call_count, 2)

    def test_excecao_que_escapa_de_process_message_tambem_e_isolada(self):
        summary, ctrl, _process, _mail = self._run(
            {}, process_side_effect=[ValueError("append_log_csv quebrou"), None])
        self.assertEqual((summary["crashed"], summary["processed"]), (1, 1))
        registro = ctrl.register.call_args.args[0]
        self.assertEqual((registro["message_id"], registro["status"]), ("<mid-1>", "falha"))


class CabecalhoQueQuebraOParserTest(_RunMixin):
    def test_vira_falha_sem_chamar_de_novo_o_que_quebrou(self):
        # Antes: `decode_str` ficava no `try` do fetch, e o e-mail era [SKIP] em todo run.
        original = R.decode_str

        def _decode(valor):
            if "envenenado" in str(valor):
                raise UnicodeError("charset desconhecido")
            return original(valor)

        decode = mock.MagicMock(side_effect=_decode)
        summary, ctrl, process, _mail = self._run({"decode_str": decode})

        self.assertEqual((summary["crashed"], summary["processed"]), (1, 1))
        registro = ctrl.register.call_args.args[0]
        self.assertEqual((registro["message_id"], registro["status"]), ("<mid-1>", "falha"))
        # O assunto CRU, sem decodificar: o handler não pode chamar o que acabou de quebrar.
        self.assertEqual(registro["subject"], "Boleto do envenenado")
        chamadas_no_envenenado = [c for c in decode.call_args_list
                                  if "envenenado" in str(c.args[0])]
        self.assertEqual(len(chamadas_no_envenenado), 1)
        self.assertEqual([c.args[1] for c in process.call_args_list], [b"2"])

    def test_email_sem_message_id_e_registrado_como_no_id_uid(self):
        mensagens = {b"7": ("Boleto sem id", None, "veneno@fornecedor.com.br")}
        filtro = self._quebra_no_remetente("veneno@fornecedor.com.br")
        _summary, ctrl, _process, _mail = self._run({"is_ignored_sender": filtro},
                                                    mensagens=mensagens)
        self.assertEqual(ctrl.register.call_args.args[0]["message_id"], "no-id-7")
        ctrl.has_error.assert_called_once_with("no-id-7", "processamento_erro")


class FalhaDeImapNoHeaderTest(_RunMixin):
    def test_timeout_no_fetch_segue_skip_sem_registro(self):
        # Falha de IMAP é transitória: registrar `falha` tiraria o e-mail da fila para sempre.
        with self.assertLogs(R.log, level="WARNING") as logs:
            summary, ctrl, process, _mail = self._run({}, fetch_quebrado=[b"1"])
        self.assertTrue(any("[SKIP] UID" in linha for linha in logs.output))
        self.assertEqual((summary["crashed"], summary["skipped_keyword"]), (0, 1))
        ctrl.register.assert_not_called()
        ctrl.register_error.assert_not_called()
        self.assertEqual([c.args[1] for c in process.call_args_list], [b"2"])


if __name__ == "__main__":
    unittest.main()
