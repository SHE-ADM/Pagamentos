"""
test_status_anexo_respondeu.py — o ANEXO que respondeu por um pagável decide o status,
não o assunto do e-mail.

CASO REAL (e-mail 3865, 18/11/2026): "ENVIO DE NOTA FISCAL (00021851/1)", da 4R Ambiental, com
`Boleto_18454-117.pdf` em anexo. O boleto casou por dedup a conta 2594, criada dias antes pelo
encaminhamento do mesmo documento. O assunto é de NF-e pura (`subject_is_pure_nfe`), e
`status_for_result` avalia `pure_nfe` ANTES de `duplicate`: o e-mail saiu `ignorado`, sem nota —
o card de /emails que significa "não-financeiro, nada a fazer" — quando o honesto é
`duplicidade`.

A correção fica no CALL SITE (`process_message`), e não na ordem de `status_for_result`:
`pure_nfe` e `nonpayable` só são informados quando o anexo NÃO respondeu por pagável nenhum.
Reordenar a função moveria também a duplicata vinda do CORPO de "Ignorados" para
"Duplicidades", mudança de regra que ninguém pediu.

Por que executar `process_message`: `tests/test_status_for_result.py` cobre a função pura
passando os sinais na mão — continuaria verde com o call site informando o sinal errado.
"""

import sys
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402
from test_boleto_dedup_suppresses_body import (  # noqa: E402
    REC, FakeControl, _boleto_row, _nfe_row)

ASSUNTO_NFE_PURA = "ENVIO DE NOTA FISCAL (00021851/1)"
ASSUNTO_COMUM = "Documentos do frete de novembro"


class _Ctrl:
    def __init__(self):
        self.registrados = []
        self.erros = []

    def register(self, rec):
        self.registrados.append(dict(rec))
        return True

    def delete_errors(self, message_id, error_type):
        """Limpeza do erro transitório ao concluir — inerte no dublê."""

    def register_error(self, rec, tipo, msg, raw_payload=None):
        self.erros.append((tipo, msg))
        return True


class _Mail:
    def __init__(self, raw: bytes):
        self._raw = raw

    def uid(self, _cmd, _uid, _spec=None):
        return "OK", [(b'1 (INTERNALDATE "18-Nov-2026 19:55:53 -0300" RFC822 {1}', self._raw)]


def _mensagem(assunto: str) -> bytes:
    msg = EmailMessage()
    msg["Subject"] = assunto
    msg["From"] = "faturamento@4rambiental.com.br"
    msg["Message-ID"] = "<E1xToZ2-teste@message-id.smtpcorp.com>"
    msg.set_content("Segue o(s) boleto(s) em anexo referente(s) a prestação de serviço.")
    msg.add_attachment(b"%PDF-1.4 fake", maintype="application", subtype="pdf",
                       filename="Boleto_18454-117.pdf")
    return msg.as_bytes()


class ProcessMessageStatusTest(unittest.TestCase):
    """Executa `process_message` com o resultado da extração do anexo controlado."""

    def _status(self, assunto: str, extract_ret: tuple, body_outcome=None) -> dict:
        ctrl = _Ctrl()
        body = read_emails.BODY_NONE if body_outcome is None else body_outcome
        with patch.object(read_emails, "save_attachments",
                          lambda *a, **k: [Path("Boleto_18454-117.pdf")]), \
                patch.object(read_emails, "save_inline_images", lambda *a, **k: []), \
                patch.object(read_emails, "extract_and_store_accounts",
                             lambda *a, **k: extract_ret), \
                patch.object(read_emails, "try_extract_from_body", lambda *a, **k: body), \
                patch.object(read_emails, "apply_due_date_reminder", lambda *a, **k: None), \
                patch.object(read_emails, "append_log_csv", lambda rec: None):
            rec = read_emails.process_message(
                _Mail(_mensagem(assunto)), b"1", ["nota fiscal", "frete"], False, False, ctrl)
        self.assertEqual(ctrl.registrados[-1]["status"], rec["status"])
        return rec

    def test_sanidade_dos_assuntos(self):
        # Anti-vacuidade: se o primeiro deixar de ser "NF-e pura", os casos abaixo passam a
        # exercitar outro ramo sem ficar vermelhos.
        self.assertTrue(read_emails.subject_is_pure_nfe(ASSUNTO_NFE_PURA))
        self.assertFalse(read_emails.subject_is_pure_nfe(ASSUNTO_COMUM))

    def test_assunto_de_nfe_com_boleto_deduplicado_e_duplicidade(self):
        #   (csvs_ok, accounts_saved, nonpayable_only, attachment_account)
        rec = self._status(ASSUNTO_NFE_PURA, (["boleto.csv"], 0, False, True))
        self.assertEqual(rec["status"], "duplicidade")

    def test_assunto_de_nfe_sem_resposta_do_anexo_segue_ignorado(self):
        # NÃO REGREDIR: NF-e pura de verdade (o anexo é a nota, nenhum pagável) continua
        # 'ignorado'. Sem este caso, o teste acima passaria com `pure_nfe=False` fixo.
        # `nonpayable_only=False` de propósito: com True o ramo `nonpayable` daria 'ignorado'
        # sozinho e este caso não observaria `pure_nfe` (medido por mutante).
        rec = self._status(ASSUNTO_NFE_PURA, (["nf.csv"], 0, False, False))
        self.assertEqual(rec["status"], "ignorado")
        # Contraprova do isolamento: o MESMO resultado, com assunto comum, não é 'ignorado'.
        rec = self._status(ASSUNTO_COMUM, (["nf.csv"], 0, False, False))
        self.assertNotEqual(rec["status"], "ignorado")

    def test_assunto_de_nfe_com_conta_nova_segue_extraido(self):
        rec = self._status(ASSUNTO_NFE_PURA, (["boleto.csv"], 1, False, True))
        self.assertEqual(rec["status"], "extraído")

    def test_nao_pagavel_nao_esconde_o_boleto_deduplicado(self):
        # A porta irmã: `nonpayable` também é avaliado antes de `duplicate`. Hoje os dois
        # sinais não coexistem, mas só por ordem de incremento em extract_and_store_accounts.
        rec = self._status(ASSUNTO_COMUM, (["cte.csv", "boleto.csv"], 0, True, True))
        self.assertEqual(rec["status"], "duplicidade")

    def test_nao_pagavel_sem_resposta_do_anexo_segue_ignorado(self):
        rec = self._status(ASSUNTO_COMUM, (["cte.csv"], 0, True, False),
                           body_outcome=read_emails.BODY_IGNORED)
        self.assertEqual(rec["status"], "ignorado")


class SinaisDoAnexoTest(unittest.TestCase):
    """`extract_and_store_accounts` real: NF pulada + boleto deduplicado no MESMO e-mail."""

    def test_nf_pulada_mais_boleto_deduplicado_nao_e_so_nao_pagavel(self):
        rows = {"nota.pdf": _nfe_row(), "boleto_ober.pdf": _boleto_row()}
        ctrl = FakeControl(dup={"id": 159, "due_date": "2026-07-18"})
        with patch.object(read_emails, "run_extraction",
                          lambda p, pdf_passwords=None: (p.name, None)), \
                patch.object(read_emails, "read_extracted_rows",
                             lambda csv: [rows[Path(csv).name]]):
            _csvs, accounts_saved, nonpayable_only, attachment_account = \
                read_emails.extract_and_store_accounts(
                    [Path("nota.pdf"), Path("boleto_ober.pdf")], "<MID>", ctrl,
                    email_rec=dict(REC))
        self.assertEqual(accounts_saved, 0)
        self.assertTrue(attachment_account)          # o boleto casou a conta 159
        # Se isto virasse True, `nonpayable` venceria `duplicate` no status — é a garantia
        # que o `and not attachment_account` do call site torna explícita.
        self.assertFalse(nonpayable_only)


if __name__ == "__main__":
    unittest.main()
