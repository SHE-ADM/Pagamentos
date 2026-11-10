"""Conversa da NOSSA cobranca nunca vira conta a pagar — salvo honorarios em resposta interna.

Caso real: resposta do cliente a "COBRANCA OTIMOTEX TECIDO" cita titulo e valor, casa a keyword
"cobranca" e o corpo gravava conta falsa (2247, "Me envia o boleto por favor"). Foram 17 contas.
Excecao decidida pelo usuario: Rose responde com a BAIXA e os honorarios (161, 166, 182).
"""

import sys
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "cobranca-vencidos" / "scripts"))

import read_emails as R  # noqa: E402

CORPO_2247 = (
    "Me envia o boleto por favor ,m??\r\n\r\n"
    "Em sex., 23 de out. de 2026 às 10:15, OTIMOTEX TECIDOS <\r\n"
    "financeiro@envio.otimotex.com.br> escreveu:\r\n\r\n"
    "> Bom dia,\r\n> *LABUGE INDUSTRIA ( FAT )*\r\n>\r\n"
    "> O(s) título(s) abaixo consta(m) em aberto em nosso sistema, favor\r\n"
    "> verificar.\r\n>\r\n"
    "> Título *(251646)* no valor de *(R$ 1.607,00)* vencido no dia\r\n> *(20/10/2026)*\r\n"
)


class AssuntoTest(unittest.TestCase):
    def test_respostas_reais_casam(self):
        for subject in ("Re: COBRANÇA OTIMOTEX TECIDO", "RES: COBRANÇA LEBIANCO",
                        "RE: COBRANÇA LEBIANCO", "ENC: RES: COBRANÇA OTIMOTEX TECIDO",
                        "ENC: COBRANÇA OTIMOTEX TECIDO  /  TITULO  BAIXADO  E O CLIENTE RECEBEU",
                        "RES: Cobranças não enviadas — ação necessária (1 título)",
                        "Cobranças não enviadas — ação necessária (2 títulos)"):
            self.assertTrue(R._is_own_collection_subject(subject), subject)

    def test_cobranca_de_fornecedor_nao_casa(self):
        # Assuntos reais de terceiros, medidos no banco. O ultimo prova a exigencia de prefixo.
        for subject in ("Lançamento de Cobrança | Vencimento:  14/11/2026",
                        "COBRANÇA REGISTROBR - Última notificação",
                        "RE: cobrança: CT-e 64007102-1 e CT-e 64007103-1",
                        "Cobrança disponível   Locaweb",
                        "COBRANÇA OTIMOTEX TECIDO",
                        "COBRANÇA OTIMOTEX"):
            self.assertFalse(R._is_own_collection_subject(subject), subject)

    def test_receivable_notice_nao_descarta_cobranca_de_fornecedor(self):
        # Antes era substring: o boleto real sumia em silencio no Passo 2.
        self.assertFalse(R._is_receivable_notice("COBRANÇA OTIMOTEX", None))
        self.assertTrue(R._is_receivable_notice("RES: COBRANÇA OTIMOTEX TECIDO", None))

    def test_espacos_duplos_do_cabecalho_decodificado(self):
        self.assertTrue(R._is_own_collection_subject("RES:  COBRANÇA  OTIMOTEX TECIDO"))

    def test_paridade_com_o_que_a_cobranca_envia(self):
        # Guarda contra a rotina de cobranca mudar o texto e a resposta voltar a virar conta.
        import failure_notify
        self.assertTrue(R._is_own_collection_subject(failure_notify.build_subject(1)))
        self.assertTrue(R._is_own_collection_subject(failure_notify.build_subject(3)))
        fonte = (_ROOT / "skills/cobranca-vencidos/scripts/db_firebird.py").read_text(encoding="utf-8")
        self.assertIn("'COBRANÇA' || ' ' || PK.EMP_NO", fonte)

    def test_paridade_com_a_frase_do_template(self):
        # Sem isto, mudar o modelo desliga a deteccao de resposta com assunto reescrito.
        fonte = (_ROOT / "skills/cobranca-vencidos/scripts/template.py").read_text(encoding="utf-8")
        self.assertTrue(R._body_quotes_own_collection(fonte))


class RemetenteInternoTest(unittest.TestCase):
    def test_dominio_por_igualdade(self):
        self.assertTrue(R._is_internal_sender("rose@otimotex.com.br"))
        self.assertTrue(R._is_internal_sender("ESTELA@LEBIANCO.COM.BR"))
        self.assertFalse(R._is_internal_sender("x@naootimotex.com.br"))
        self.assertFalse(R._is_internal_sender("x@otimotex.com.br.golpe.com"))
        self.assertFalse(R._is_internal_sender(None))


class MotivoTest(unittest.TestCase):
    def test_modelo_citado_com_assunto_reescrito_e_detectado(self):
        self.assertIsNotNone(R.own_collection_ignore_reason(
            "Boleto por favor", "financeiro@labuge.com.br", CORPO_2247))

    def test_email_comum_nao_tem_motivo(self):
        self.assertIsNone(R.own_collection_ignore_reason(
            "PAGAMENTO BOLETO MODART", "ester@otimotex.com.br", "Segue boleto."))


class _Ctrl:
    def __init__(self):
        self.registrados, self.erros, self.uploads, self.contas = [], [], [], []

    def register(self, rec):
        self.registrados.append(dict(rec))
        return True

    def delete_errors(self, *a):
        pass

    def register_error(self, rec, tipo, msg, raw_payload=None):
        self.erros.append((tipo, msg))
        return True

    def upload_attachment(self, path):
        self.uploads.append(path)
        return True

    def company_cnpj(self):
        return "47273917000123"

    def resolve_supplier(self, payload):
        return 900

    def supplier_defaults(self, sk):
        return (0, 0)

    def find_financial_duplicate(self, payload, skip_settled=False):
        return None

    def unique_invoice_number(self, base):
        return base

    def register_financial(self, payload):
        self.contas.append(dict(payload))
        return len(self.contas)

    def register_attachment(self, *a, **k):
        return True

    def resolve_user(self, email):
        return None


class _Mail:
    def __init__(self, raw):
        self._raw = raw

    def uid(self, cmd, uid, spec=None, flags=None):
        return "OK", [(b'1 (INTERNALDATE "28-Oct-2026 22:28:19 +0000" RFC822 {1}', self._raw)]


def _processa(subject, sender, corpo, anexos=(), texto_anexo="", linhas=()):
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["Message-ID"] = subject, sender, "<mid-own@local>"
    msg.set_content(corpo)
    ctrl = _Ctrl()
    with mock.patch.object(R, "save_attachments", lambda *a, **k: list(anexos)), \
         mock.patch.object(R, "save_inline_images", lambda *a, **k: []), \
         mock.patch.object(R, "extract_pdf_links", lambda *a, **k: []), \
         mock.patch.object(R, "_attachment_text", lambda p: texto_anexo), \
         mock.patch.object(R, "run_extraction", lambda p, pw=None: (str(p), None)) as _run, \
         mock.patch.object(R, "read_extracted_rows", lambda c: list(linhas)), \
         mock.patch.object(R, "append_log_csv", lambda rec: None):
        rec = R.process_message(_Mail(msg.as_bytes()), b"1", ["cobrança"], False, False, ctrl)
    return rec, ctrl


class ProcessMessageTest(unittest.TestCase):
    def test_resposta_interna_sem_honorarios_e_ignorada_sem_upload(self):
        rec, ctrl = _processa("RES: COBRANÇA OTIMOTEX TECIDO", "rose@otimotex.com.br",
                              "Os boletos vao sempre grampeados c/ a nf R$ 1.607,00",
                              anexos=[Path("251646.pdf")], texto_anexo="Boleto R$ 1.607,00")
        self.assertEqual(rec["status"], "ignorado")
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(ctrl.uploads, [], "sem conta a extrair, o anexo nao vai ao Storage")
        self.assertEqual(ctrl.registrados[-1]["status"], "ignorado")

    def test_resposta_de_cliente_que_escapou_do_run_reader_nao_gera_conta(self):
        rec, ctrl = _processa("Sobre o boleto", "financeiro@labuge.com.br", CORPO_2247)
        self.assertEqual(rec["status"], "ignorado")
        self.assertEqual(ctrl.contas, [])

    def test_honorarios_no_corpo_seguem_e_gravam_conta(self):
        rec, ctrl = _processa(
            "RES: COBRANÇA OTIMOTEX TECIDO", "rose@otimotex.com.br",
            "Favor pagar os honorários do Dr. Wesley.\r\nFavorecido: Wesley S. Paixao\r\n"
            "Valor: R$ 855,40\r\nVencimento: 15/06/2026\r\n")
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")
        self.assertEqual(rec["status"], "recebido")

    def test_honorarios_so_no_pdf_seguem_ate_o_corpo(self):
        # 🔴 Sem a marca _OWN_THREAD_CLEARED_KEY o guard do corpo, que nao ve o anexo, ignoraria.
        rec, ctrl = _processa(
            "RES: COBRANÇA OTIMOTEX TECIDO", "rose@otimotex.com.br",
            "Segue a baixa.\r\nFavorecido: Wesley S. Paixao\r\nValor: R$ 855,40\r\n",
            anexos=[Path("BAIXA.pdf")], texto_anexo="Honorários advocatícios",
            linhas=[{"source_file": "BAIXA.pdf", "document_type": "outro", "amount": "855.40"}])
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")
        self.assertTrue(ctrl.uploads)

    def test_honorarios_e_valor_so_no_pdf_gravam_a_conta_do_anexo(self):
        # 🔴 O Passo 2 descartava pelo assunto a linha que a excecao acabou de liberar.
        boleto = {"document_type": "boleto", "payment_method": "boleto",
                  "barcode": "34191790010104351004791020150008291070026000"}
        for subject in ("RES: COBRANÇA LEBIANCO", "RES: COBRANÇA OTIMOTEX TECIDO"):
            for extra in ({"document_type": "outro"}, boleto):
                linha = {"source_file": "BAIXA.pdf", "amount": "855.40", "due_date": "2026-06-15",
                         "supplier_name": "Wesley S. Paixao", **extra}
                rec, ctrl = _processa(subject, "rose@otimotex.com.br", "Segue a baixa.",
                                      anexos=[Path("BAIXA.pdf")],
                                      texto_anexo="Honorários advocatícios", linhas=[linha])
                self.assertEqual(len(ctrl.contas), 1, f"{subject} {extra} notes={rec.get('notes')!r}")
                self.assertEqual(rec["status"], "extraído")

    def test_baixa_na_descricao_continua_descartada_com_a_conversa_liberada(self):
        linha = {"source_file": "BAIXA.pdf", "document_type": "outro", "amount": "855.40",
                 "description": "Titulo baixado no banco"}
        rec, ctrl = _processa("RES: COBRANÇA LEBIANCO", "rose@otimotex.com.br", "Segue a baixa.",
                              anexos=[Path("BAIXA.pdf")], texto_anexo="Honorários advocatícios",
                              linhas=[linha])
        self.assertEqual(ctrl.contas, [], f"notes={rec.get('notes')!r}")

    def test_boleto_real_com_assunto_cobranca_otimotex_gera_conta(self):
        # O substring antigo de _is_receivable_notice descartava este boleto em silencio.
        boleto = {"source_file": "b.pdf", "document_type": "boleto", "amount": "500.00",
                  "due_date": "2026-11-20", "supplier_name": "FORNECEDOR REAL",
                  "supplier_cnpj": "11222333000181"}
        rec, ctrl = _processa("COBRANÇA OTIMOTEX", "financeiro@fornecedor.com.br", "Segue boleto.",
                              anexos=[Path("b.pdf")], linhas=[boleto])
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")
        self.assertEqual(rec["status"], "extraído")


class TryExtractGuardTest(unittest.TestCase):
    def test_entrada_direta_do_script_tambem_ignora(self):
        rec = {"subject": "Re: COBRANÇA OTIMOTEX TECIDO"}
        desfecho = R.try_extract_from_body(rec, CORPO_2247, "2026-10-28T22:28:19+00:00", "<m>",
                                           _Ctrl(), sender_email="financeiro@labuge.com.br")
        self.assertEqual(desfecho, R.BODY_IGNORED)


def _header(uid, subject, sender):
    raw = (f"Subject: {subject}\r\nMessage-ID: <mid-{uid.decode()}>\r\nFrom: {sender}\r\n"
           "Date: Wed, 28 Oct 2026 19:28:00 -0300\r\n\r\n").encode("utf-8")
    return ("OK", [(uid + b' (INTERNALDATE "28-Oct-2026 19:28:00 -0300" BODY[HEADER])', raw)])


class RunReaderTest(unittest.TestCase):
    def _run(self, emails):
        class Mail:
            def uid(self, cmd, uid, *a):
                return _header(uid, *emails[uid])

            def logout(self):
                pass

        ctrl = mock.MagicMock()
        ctrl._available = True
        ctrl.load_known_ids.return_value = {"<ja>"}
        process = mock.MagicMock()
        with mock.patch.object(R, "_connect_and_search", return_value=(Mail(), list(emails))), \
             mock.patch.object(R, "SupabaseControl", return_value=ctrl), \
             mock.patch.object(R, "process_message", process):
            R.run_reader(days=1)
        return ctrl, process

    def test_cliente_e_ignorado_sem_process_message(self):
        ctrl, process = self._run({b"1": ("Re: COBRANCA OTIMOTEX TECIDO", "financeiro@labuge.com.br")})
        process.assert_not_called()
        self.assertEqual(ctrl.register.call_args.args[0]["status"], "ignorado")

    def test_interno_segue_para_process_message(self):
        _, process = self._run({b"1": ("RES: COBRANCA OTIMOTEX TECIDO", "rose@otimotex.com.br")})
        process.assert_called_once()

    def test_cobranca_sem_prefixo_de_fornecedor_segue(self):
        _, process = self._run({b"1": ("COBRANCA OTIMOTEX", "financeiro@fornecedor.com.br")})
        process.assert_called_once()


if __name__ == "__main__":
    unittest.main()
