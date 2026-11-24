"""
test_check_inbox_coverage.py — conferência caixa × email_control (`scripts/check_inbox_coverage.py`).

O script existe porque e-mail NÃO LIDO não deixa rastro no banco: a única forma de achar a perda
é comparar a caixa com o controle (incidente de 18 a 21/11/2026, 14 e-mails). Travas:

  1. é SOMENTE LEITURA na caixa — pasta em EXAMINE e todo FETCH com PEEK (a caixa é operada por
     pessoas; marcar \\Seen numa conferência seria um efeito colateral invisível);
  2. não importa nenhuma função de escrita do Supabase;
  3. o exit code separa "há perda" (1) de "não consegui conferir" (2) — uma conferência que não
     leu a caixa ou o controle NUNCA sai com 0 nem com uma lista falsa de perdas;
  4. mensagem recém-chegada (ainda na cadência do reader) não conta como perda.

Tudo executando `main()`, com dublê no nível do `imaplib` (abaixo da classe `Caixa`).
"""

import ast
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "scripts"))

import check_inbox_coverage as C  # noqa: E402

_SCRIPT = _ROOT / "scripts" / "check_inbox_coverage.py"


def _internaldate(when: datetime) -> str:
    """INTERNALDATE do IMAP em UTC, sem depender do locale."""
    return (f"{when.day:02d}-{C._IMAP_MONTHS[when.month - 1]}-{when.year} "
            f"{when:%H:%M:%S} +0000")


ANTIGA = datetime(2020, 11, 19, 18, 25, 56, tzinfo=timezone.utc)   # sempre no passado


class _FakeImap:
    """`imaplib` mínimo que REGISTRA cada comando recebido."""

    def __init__(self, mensagens: dict, quebradas=()):
        self._mensagens = mensagens          # uid -> (message_id, assunto, quando)
        self._quebradas = set(quebradas)
        self.selects = []
        self.comandos = []
        self.logged_out = False

    def select(self, mailbox, readonly=False):
        self.selects.append(readonly)
        return "OK", [b"1"]

    def response(self, _code):
        return "UIDVALIDITY", [b"42"]

    def uid(self, comando, uid, *args):
        self.comandos.append((comando, uid, args))
        if uid in self._quebradas:
            raise ValueError("resposta IMAP ilegivel")
        message_id, assunto, quando = self._mensagens[uid]
        raw = (f"Subject: {assunto}\r\nMessage-ID: {message_id}\r\n"
               f"From: Fornecedor <adm@fornecedor.com.br>\r\n\r\n").encode()
        meta = uid + f' (INTERNALDATE "{_internaldate(quando)}" RFC822.SIZE 1234 BODY[HEADER])'.encode()
        return "OK", [(meta, raw)]

    def logout(self):
        self.logged_out = True


class _RunMixin(unittest.TestCase):
    MENSAGENS = {
        b"1": ("<registrada@x>", "Boleto registrado", ANTIGA),
        b"2": ("<perdida@x>", "FATURA OTIMOTEX (14080) - Vencimento 24/11/26", ANTIGA),
    }

    def _run(self, conhecidos, mensagens=None, quebradas=(), argv=(),
             imap_error=None, rest_error=None):
        mensagens = self.MENSAGENS if mensagens is None else mensagens
        imap = _FakeImap(mensagens, quebradas)
        connect = mock.MagicMock(return_value=(imap, list(mensagens)))
        if imap_error:
            connect.side_effect = imap_error
        rest = mock.MagicMock(return_value=[{"message_id": m} for m in conhecidos])
        if rest_error:
            rest.side_effect = rest_error
        with mock.patch.object(C.V.R, "_connect_and_search", connect), \
                mock.patch.object(C, "rest_get", rest), \
                self.assertLogs(C.log, level="INFO") as logs:
            C.log.info("inicio")   # garante ao menos uma linha para o assertLogs
            exit_code = C.main(list(argv))
        return exit_code, imap, connect, "\n".join(logs.output)


class ExitCodeTest(_RunMixin):
    def test_tudo_registrado_sai_com_zero(self):
        exit_code, imap, _connect, _saida = self._run({"<registrada@x>", "<perdida@x>"})
        self.assertEqual(exit_code, C.EXIT_OK)
        self.assertTrue(imap.logged_out)

    def test_mensagem_sem_registro_sai_com_um_e_e_listada(self):
        exit_code, _imap, _connect, saida = self._run({"<registrada@x>"})
        self.assertEqual(exit_code, C.EXIT_MISSING)
        self.assertIn("FATURA OTIMOTEX (14080)", saida)
        self.assertIn("<perdida@x>", saida)
        self.assertNotIn("Boleto registrado", saida)

    def test_mensagem_recem_chegada_nao_conta_como_perda(self):
        agora = datetime.now(timezone.utc)
        mensagens = {b"7": ("<nova@x>", "Boleto que acabou de chegar", agora - timedelta(minutes=2))}
        exit_code, *_ = self._run({"<outra@x>"}, mensagens)
        self.assertEqual(exit_code, C.EXIT_OK)
        # Contraprova: a MESMA mensagem, com a tolerância zerada, é perda. Sem isto o caso
        # acima passaria também se o script nunca listasse nada.
        exit_code, *_ = self._run({"<outra@x>"}, mensagens, argv=["--min-age-minutes", "0"])
        self.assertEqual(exit_code, C.EXIT_MISSING)


class NaoConferidoTest(_RunMixin):
    """Não conseguir conferir NUNCA pode sair como 'cobertura completa' nem como lista de perdas."""

    def test_controle_vazio_nao_vira_lista_de_perdas(self):
        exit_code, imap, connect, saida = self._run(set())
        self.assertEqual(exit_code, C.EXIT_UNVERIFIED)
        connect.assert_not_called()                  # nem abriu a caixa
        self.assertNotIn("FATURA OTIMOTEX", saida)
        self.assertEqual(imap.comandos, [])

    def test_falha_do_supabase(self):
        exit_code, _imap, connect, _saida = self._run(
            {"<registrada@x>"}, rest_error=C.RestError("email_control: HTTP 503"))
        self.assertEqual(exit_code, C.EXIT_UNVERIFIED)
        connect.assert_not_called()

    def test_falha_do_imap(self):
        exit_code, *_ = self._run({"<registrada@x>"},
                                  imap_error=RuntimeError("Falha na conexão IMAP"))
        self.assertEqual(exit_code, C.EXIT_UNVERIFIED)

    def test_mensagem_ilegivel_nao_sai_como_cobertura_completa(self):
        exit_code, imap, _connect, saida = self._run(
            {"<registrada@x>", "<perdida@x>"}, quebradas=[b"2"])
        self.assertEqual(exit_code, C.EXIT_UNVERIFIED)
        self.assertIn("NAO conferida", saida)
        self.assertTrue(imap.logged_out)             # a conexão é fechada mesmo assim

    def test_perda_vence_o_nao_conferido(self):
        mensagens = {**self.MENSAGENS, b"3": ("<x@x>", "ilegivel", ANTIGA)}
        exit_code, *_ = self._run({"<registrada@x>"}, mensagens, quebradas=[b"3"])
        self.assertEqual(exit_code, C.EXIT_MISSING)


class SomenteLeituraTest(_RunMixin):
    def test_caixa_em_examine_e_todo_fetch_com_peek(self):
        _exit, imap, _connect, _saida = self._run({"<registrada@x>"})
        # Anti-vacuidade: houve comando a inspecionar.
        self.assertEqual(len(imap.comandos), len(self.MENSAGENS))
        self.assertTrue(imap.selects, "a pasta nunca foi selecionada")
        self.assertTrue(imap.selects[-1], "a pasta não ficou em EXAMINE (readonly=True)")
        for comando, _uid, args in imap.comandos:
            self.assertEqual(comando, "fetch")
            self.assertIn("BODY.PEEK[", args[0])
            self.assertNotIn("RFC822)", args[0])     # RFC822 sem PEEK marca \Seen

    def test_o_script_so_importa_leitura_do_supabase(self):
        arvore = ast.parse(_SCRIPT.read_text(encoding="utf-8"))
        importados = {alias.name for no in ast.walk(arvore)
                      if isinstance(no, ast.ImportFrom) and no.module == "supabase_rest"
                      for alias in no.names}
        self.assertEqual(importados, {"RestError", "rest_get"})   # sanidade + ausência de escrita
        chamadas = {no.func.attr for no in ast.walk(arvore)
                    if isinstance(no, ast.Call) and isinstance(no.func, ast.Attribute)}
        self.assertIn("previa", chamadas)                          # sanidade do parser
        self.assertEqual(chamadas & {"store", "rest_write", "storage_upload", "register",
                                     "register_error", "register_financial", "mensagem"}, set())


class EntradaTest(unittest.TestCase):
    def test_since_usa_os_meses_do_imap_e_nao_o_locale(self):
        self.assertEqual(C.imap_since(1, date(2026, 2, 1)), 'SINCE "31-Jan-2026"')
        self.assertEqual(C.imap_since(7, date(2026, 11, 24)), 'SINCE "17-Nov-2026"')
        meses = [C.imap_since(0, date(2026, mes, 15)).split("-")[1] for mes in range(1, 13)]
        self.assertEqual(meses, ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])

    def test_argumentos_fora_da_faixa_sao_recusados(self):
        for argv in (["--days", "0"], ["--days", str(C.MAX_DAYS + 1)],
                     ["--min-age-minutes", "-1"], ["--days", "abc"]):
            with self.subTest(argv=argv), self.assertRaises(SystemExit) as saida, \
                    mock.patch("sys.stderr"):
                C.main(argv)
            self.assertEqual(saida.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
