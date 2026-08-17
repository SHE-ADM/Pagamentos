"""Wiring do .docx no `read_emails` — EXECUTADO, nao lido.

`test_docx_content.py` prova o modulo e `test_docx_extract.py` prova o roteamento do extrator.
Nenhum dos dois provaria que o reader SALVA o anexo: o defeito do e-mail 1516 estava justamente
aqui, no filtro de `save_attachments`, com `has_attachment=false` como sintoma.

CLAUDE.md §2 itens 5 e 6: a funcao pura nao cobre o call site, e guarda por TEXTO nao cobre o
call site EXECUTADO.
"""

import sys
import tempfile
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest import mock

_READER_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_READER_DIR))

import read_emails as R  # noqa: E402

from fixtures_docx import docx_com_linha_digitavel  # noqa: E402

_DOCX_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class AttachmentKindTest(unittest.TestCase):
    """A REGRA UNICA de selecao — consumida por save_attachments, varredura e reprocess."""

    def test_docx_por_mime_e_por_extensao(self):
        self.assertEqual(R.attachment_kind(_DOCX_CT, "boleto.docx", "attachment"), "docx")
        # Outlook/webmail mandam .docx como octet-stream, as vezes sem disposition — por isso
        # o .docx NAO exige `attachment`, ao contrario da imagem.
        self.assertEqual(R.attachment_kind("application/octet-stream", "boleto.docx", ""), "docx")

    def test_docx_vence_a_heuristica_de_pdf_no_nome(self):
        # 🔴 `is_pdf` casa "pdf" em QUALQUER lugar do nome. Sem a ordem correta, um anexo
        # `boleto_pdf.docx` seria salvo com extensao .pdf e morreria no pdfplumber.
        # Mutante: mover o ramo docx para depois do pdf.
        self.assertEqual(
            R.attachment_kind("application/octet-stream", "boleto_pdf.docx", "attachment"),
            "docx")

    def test_formatos_fora_do_escopo_continuam_recusados(self):
        for nome in ("contrato.doc", "planilha.xlsx", "texto.odt", "msg.eml", "arquivo.rtf"):
            self.assertIsNone(R.attachment_kind("application/octet-stream", nome, "attachment"),
                              nome)

    def test_pdf_e_imagem_nao_regridem(self):
        self.assertEqual(R.attachment_kind("application/pdf", "b.pdf", ""), "pdf")
        self.assertEqual(R.attachment_kind("image/png", "recibo.png", "attachment"), "image")
        self.assertIsNone(R.attachment_kind("image/png", "logo.png", "inline"))

    def test_extensao_e_imposta_pelo_pipeline(self):
        self.assertEqual(R.attachment_ext("docx", _DOCX_CT, "qualquer_nome.docx"), ".docx")
        self.assertEqual(R.attachment_ext("pdf", "application/pdf", "x.pdf"), ".pdf")


class SaveAttachmentsDocxTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self._orig_inbox = R.PDF_INBOX
        R.PDF_INBOX = Path(self._td.name)
        self.addCleanup(lambda: setattr(R, "PDF_INBOX", self._orig_inbox))

    @staticmethod
    def _msg(nome: str, ct: str = _DOCX_CT):
        m = EmailMessage()
        m["Subject"] = "BOLETO: 0003150-04.2023.8.26.0577"
        m.set_content("segue boleto")
        maintype, _, subtype = ct.partition("/")
        m.add_attachment(docx_com_linha_digitavel(), maintype=maintype, subtype=subtype,
                         filename=nome)
        return m

    def test_salva_o_docx(self):
        # 🔴 O defeito do 1516 invertido: antes, este anexo era descartado em silencio.
        # Mutante: remover o ramo docx de `attachment_kind` -> nada e salvo.
        salvos = R.save_attachments(self._msg("boleto.docx"), "barbara@otimotex.com.br",
                                    "BOLETO: 0003150", "2026-08-17T12:22:13+00:00")
        self.assertEqual(len(salvos), 1)
        self.assertEqual(salvos[0].suffix, ".docx")
        self.assertTrue(salvos[0].exists())

    def test_anexo_nao_suportado_DEIXA_RASTRO_no_log(self):
        # O `continue` era mudo, e o banco nao registra anexo rejeitado (`attachment_names`
        # fica NULL): este log e a UNICA fonte de "que formatos estamos perdendo".
        # Mutante: remover o log -> assertLogs levanta por ausencia de registro.
        msg = self._msg("contrato.doc", ct="application/msword")
        with self.assertLogs(R.log, level="INFO") as cap:
            salvos = R.save_attachments(msg, "x@y.com", "assunto", "2026-08-17T00:00:00+00:00")
        self.assertEqual(salvos, [])
        self.assertTrue(any("tipo não suportado" in linha and "contrato.doc" in linha
                            for linha in cap.output),
                        f"o descarte não apareceu no log: {cap.output}")


class AttachmentTextTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.tmp = Path(self._td.name)

    def test_le_o_texto_do_docx(self):
        # Alimenta a regra LEBIANCO e o gancho de documento fiscal. Mutante: usar `_pdf_text`
        # no lugar -> pdfplumber falha no ZIP e devolve "" (a chave fiscal ficaria invisivel).
        alvo = self.tmp / "b.docx"
        alvo.write_bytes(docx_com_linha_digitavel())
        self.assertIn("Prezado cliente", R._attachment_text(alvo))

    def test_pdf_continua_pelo_pdfplumber(self):
        alvo = self.tmp / "b.pdf"
        alvo.write_bytes(b"%PDF-1.4 nao e um pdf de verdade")
        with mock.patch.object(R, "_pdf_text", return_value="TEXTO DO PDF") as pdf_text:
            self.assertEqual(R._attachment_text(alvo), "TEXTO DO PDF")
        pdf_text.assert_called_once()


class ProcessMessageDocxTest(unittest.TestCase):
    """EXECUTA `process_message` com um anexo .docx — o caminho completo do e-mail 1516."""

    class _Ctrl:
        def __init__(self):
            self.registrados = []
            self.erros = []

        def register(self, rec):
            self.registrados.append(dict(rec))
            return True

        def register_error(self, rec, tipo, msg, raw_payload=None):
            self.erros.append((tipo, msg))
            return True

    class _Mail:
        def __init__(self, raw: bytes):
            self._raw = raw

        def uid(self, cmd, uid, spec=None):
            meta = b'1 (INTERNALDATE "17-Aug-2026 12:22:13 +0000" RFC822 {1}'
            return "OK", [(meta, self._raw)]

    @staticmethod
    def _mensagem() -> bytes:
        m = EmailMessage()
        m["Subject"] = "BOLETO: 0003150-04.2023.8.26.0577"
        m["From"] = "barbara@otimotex.com.br"
        m["Message-ID"] = "<guarda-docx@local>"
        m.set_content("De: JOSE RICARDO PRUDENTE\nAssunto: 0003150-04.2023.8.26.0577")
        m.add_attachment(
            docx_com_linha_digitavel(),
            maintype="application",
            subtype="vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename="boleto.docx")
        return m.as_bytes()

    def test_email_com_docx_registra_anexo_e_gera_conta(self):
        ctrl = self._Ctrl()
        mail = self._Mail(self._mensagem())
        # `extract_and_store_accounts` mockado: o alvo aqui e o RECONHECIMENTO do anexo pelo
        # reader (has_attachment), nao a extracao — que tem cobertura propria.
        with mock.patch.object(R, "extract_and_store_accounts",
                               return_value=(["boleto.csv"], 1, False, True)), \
             mock.patch.object(R, "append_log_csv", lambda rec: None):
            rec = R.process_message(mail, b"1", ["boleto"], False, False, ctrl)

        self.assertTrue(rec["has_attachment"],
                        "o .docx não foi reconhecido como anexo (defeito do e-mail 1516)")
        self.assertIn(".docx", rec["attachment_names"] or "")
        self.assertEqual(rec["status"], "extraído", f"notes={rec.get('notes')!r}")
        self.assertEqual(ctrl.erros, [])


if __name__ == "__main__":
    unittest.main()
