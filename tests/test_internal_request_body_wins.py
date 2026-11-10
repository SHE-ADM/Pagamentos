"""Pedido de pagamento interno com anexo que so comprova: o corpo gera UMA conta.

Casos 2215 (pedido de compra anexo, vencimento caiu na data da extracao, forma 'outro') e 2227
(duas fotos de recibo; gravou AC IMBITUBA R$ 114,30 no lugar de PRPP R$ 140,28). Executa
process_message: a regra vive no encontro de extract_and_store_accounts com o caminho do corpo.
"""

import sys
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R  # noqa: E402

CORPO_2215 = (
    "Boa tarde! \r\n\r\nPor gentileza fazer o pagamento abaixo: \r\n\r\n\r\n"
    "Fornecedor: TECELAGEM VALLE LTDA\r\nCNPJ: 79.315.198/0001-52\r\n\r\n"
    "Vencimento: 28/10/2026\r\nValor: R$ 15.055,20\r\n\r\n \r\n\r\n"
    "Dados bancários:\r\n\r\n\r\nBanco Bradesco AG  0337 C/C 28781-4   \r\n   \r\n"
    "Banco Itaú AG 1414 C/C 25130-4\r\n\r\nPIX CNPJ - 79.315.198/0001-52\r\n\r\nObrigada!\r\n"
)
CORPO_2227 = (
    "Boa tarde,\r\n\r\n \r\n\r\n"
    "Por gentileza fazer o pagamento abaixo (envio de amostra para cliente):\r\n\r\n \r\n\r\n"
    "REPRESENTANTE: PRPP Comercial e Servs Ltda (PAULO PAZ)\r\n\r\n"
    "VALOR: R$ 140,28\r\n\r\nVENCIMENTO: 28/10/2026\r\n\r\n \r\n\r\n"
    "PIX CELULAR: (51)9967-7216\r\n\r\n \r\n\r\nObrigada!\r\n"
)
PEDIDO = {"source_file": "63868.pdf", "document_type": "outro", "payment_method": "outro",
          "amount": "15055.20", "supplier_name": "OTIMOTEX", "invoice_number": "63868",
          "processing_notes": "Vencimento ausente — usando data da extração"}
RECIBO = {"source_file": "foto_1.jpeg", "document_type": "recibo", "payment_method": "outro",
          "amount": "114.30", "supplier_name": "AC IMBITUBA", "supplier_cnpj": "34028316200463",
          "nosso_numero": "0Y828390988BR", "invoice_number": "3255082245"}
BOLETO_SEM_CODIGO = {"source_file": "b.pdf", "document_type": "boleto", "payment_method": "boleto",
                     "amount": "5914.90", "supplier_name": "CABERNET", "due_date": "2026-07-07"}


class _Ctrl:
    def __init__(self, duplicata=None, grava=True, sk=473):
        self.contas, self.anexos, self.erros, self.registrados = [], [], [], []
        self.duplicata, self.grava, self.sk = duplicata, grava, sk

    def register(self, rec):
        self.registrados.append(dict(rec))
        return True

    def delete_errors(self, *a):
        pass

    def register_error(self, rec, tipo, msg, raw_payload=None):
        self.erros.append((tipo, msg))
        return True

    def upload_attachment(self, path):
        return True

    def company_cnpj(self):
        return "47273917000123"

    def resolve_supplier(self, payload):
        self.resolvido = dict(payload)
        return self.sk

    def supplier_defaults(self, sk):
        return (0, 0)

    def classification_for_account_code(self, code):
        return (0, 0)

    def find_financial_duplicate(self, payload, skip_settled=False):
        return self.duplicata

    def update_financial(self, *a, **k):
        return True

    def unique_invoice_number(self, base):
        return base

    def register_financial(self, payload):
        if not self.grava:
            return None
        self.contas.append(R.strip_transient_fields(payload))
        return 7000 + len(self.contas)

    def register_attachment(self, account_id, file_name, size_bytes=0, uploaded_by=None):
        self.anexos.append((account_id, file_name))
        return True

    def resolve_user(self, email):
        return None


class _Mail:
    def __init__(self, raw):
        self._raw = raw

    def uid(self, cmd, uid, spec=None, flags=None):
        return "OK", [(b'1 (INTERNALDATE "27-Oct-2026 16:41:50 +0000" RFC822 {1}', self._raw)]


def _processa(corpo, arquivos, linhas_por_arquivo, subject="LE BIANCO - PAGAMENTO",
              sender="estela@lebianco.com.br", ctrl=None, texto_anexo=""):
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["Message-ID"] = subject, sender, "<mid-req@local>"
    msg.set_content(corpo)
    ctrl = ctrl or _Ctrl()
    fiscal = mock.MagicMock()
    with mock.patch.object(R, "save_attachments", lambda *a, **k: [Path(a) for a in arquivos]), \
         mock.patch.object(R, "save_inline_images", lambda *a, **k: []), \
         mock.patch.object(R, "_attachment_text", lambda p: texto_anexo), \
         mock.patch.object(R, "_register_fiscal_documents", fiscal), \
         mock.patch.object(R, "run_extraction", lambda p, pw=None: (str(p), None)), \
         mock.patch.object(R, "read_extracted_rows", lambda c: linhas_por_arquivo.get(c, [])), \
         mock.patch.object(R, "append_log_csv", lambda rec: None):
        rec = R.process_message(_Mail(msg.as_bytes()), b"1", ["pagamento"], False, False, ctrl)
    return rec, ctrl, fiscal


class CasosReaisTest(unittest.TestCase):
    def test_2215_corpo_vence_o_pedido_de_compra(self):
        rec, ctrl, fiscal = _processa(CORPO_2215, ["63868.pdf"], {"63868.pdf": [PEDIDO]},
                                      subject="LE BIANCO - PAGAMENTO FORNECEDOR (VALLETEX)")
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r} erros={ctrl.erros}")
        conta = ctrl.contas[0]
        self.assertEqual(conta["due_date"], "2026-10-28")
        self.assertEqual(float(conta["amount"]), 15055.20)
        self.assertEqual(conta["payment_method"], "pix")
        self.assertEqual(ctrl.resolvido["supplier_cnpj"], "79315198000152")
        self.assertNotIn("Vencimento ausente", conta.get("processing_notes") or "")
        self.assertEqual(rec["status"], "recebido")
        self.assertEqual(ctrl.anexos, [(7001, "63868.pdf")])
        fiscal.assert_called_once()  # o Passo 1 continua registrando documento fiscal

    def test_2227_representante_e_todos_os_anexos(self):
        # 🔴 A 1a foto nao gera linha, como na 2227 real, e mesmo assim precisa ser vinculada.
        rec, ctrl, _ = _processa(CORPO_2227, ["foto.jpeg", "foto_1.jpeg"],
                                 {"foto.jpeg": [], "foto_1.jpeg": [RECIBO]}, ctrl=_Ctrl(sk=1500))
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r} erros={ctrl.erros}")
        conta = ctrl.contas[0]
        self.assertEqual(float(conta["amount"]), 140.28)
        self.assertEqual(conta["due_date"], "2026-10-28")
        self.assertEqual(conta["payment_method"], "pix")
        self.assertEqual(ctrl.resolvido["supplier_name"], "PRPP Comercial e Servs Ltda")
        self.assertFalse(conta.get("nosso_numero"), "o rastreio dos Correios nao pode ir para a conta")
        self.assertCountEqual(ctrl.anexos, [(7001, "foto.jpeg"), (7001, "foto_1.jpeg")])
        self.assertEqual(rec["status"], "recebido")
        self.assertEqual(conta["sk_company"], 2)

    def test_1242_pedido_escrito_acima_de_uma_conversa_encaminhada(self):
        corpo = CORPO_2215 + "\r\nDe: MEV <mev.vendas@terra.com.br>\r\nAssunto: pedido\r\n\r\nSegue pedido.\r\n"
        rec, ctrl, _ = _processa(corpo, ["63868.pdf"], {"63868.pdf": [PEDIDO]})
        self.assertEqual(rec["status"], "recebido", f"notes={rec.get('notes')!r}")
        self.assertEqual(ctrl.contas[0]["payment_method"], "pix")

    def test_mencao_a_lebianco_so_no_anexo_mantem_a_empresa(self):
        # A flag vem do Passo 1. Sem repassa-la ao corpo, a conta cairia na TECIDOS.
        corpo = CORPO_2215.replace("Banco Itaú AG 1414 C/C 25130-4", "")
        rec, ctrl, _ = _processa(corpo, ["63868.pdf"], {"63868.pdf": [PEDIDO]}, subject="PAGAMENTO",
                                 sender="luiz@otimotex.com.br", texto_anexo="Pedido LEBIANCO")
        self.assertEqual(rec["status"], "recebido", f"notes={rec.get('notes')!r}")
        self.assertEqual(ctrl.contas[0]["sk_company"], 2)


class TextoDaCadeiaTest(unittest.TestCase):
    """A cadeia encaminhada nao fala pelo remetente: nem valor, nem representante."""

    CADEIA = "\r\nDe: F <f@x.com.br>\r\nAssunto: pedido\r\n\r\n"

    def test_valor_gravado_e_o_do_texto_proprio(self):
        corpo = CORPO_2215.replace("Valor: R$ 15.055,20", "Valor: R$ 100,00") \
            + self.CADEIA + "Valor total: R$ 999,00\r\n"
        rec, ctrl, _ = _processa(corpo, ["63868.pdf"], {"63868.pdf": [PEDIDO]})
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")
        self.assertEqual(float(ctrl.contas[0]["amount"]), 100.00)
        self.assertEqual(float(ctrl.contas[0]["amount_charged"]), 100.00)

    def test_valor_proprio_ilegivel_nao_desvia_para_o_total_da_cadeia(self):
        corpo = CORPO_2215.replace("Valor: R$ 15.055,20", "VALOR: 140") + self.CADEIA \
            + "Total: R$ 9.000,00\r\n"
        rec, ctrl, _ = _processa(corpo, ["63868.pdf"], {"63868.pdf": [PEDIDO]})
        self.assertEqual(float(ctrl.contas[0]["amount"]), 15055.20, f"notes={rec.get('notes')!r}")
        self.assertEqual(rec["status"], "extraído")

    def test_representante_so_na_cadeia_nao_identifica(self):
        corpo = "Por gentileza fazer o pagamento.\r\nValor: R$ 10,00\r\n" + self.CADEIA \
            + "Representante: Fulano Vendedor\r\n"
        self.assertIsNone(R._internal_request_representative(corpo, "x@lebianco.com.br"))


class DesfechosTest(unittest.TestCase):
    def test_anexo_sem_nenhuma_linha_tambem_se_vincula(self):
        rec, ctrl, _ = _processa(CORPO_2227, ["foto.jpeg"], {"foto.jpeg": []}, ctrl=_Ctrl(sk=1500))
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")
        self.assertEqual(ctrl.anexos, [(7001, "foto.jpeg")])

    def test_pedido_sem_anexo_nao_entra_no_desvio(self):
        # O desvio registraria o erro uma 2a vez, somado ao do status 'falha'.
        rec, ctrl, _ = _processa(CORPO_2215, [], {}, ctrl=_Ctrl(grava=False))
        self.assertIsNone(rec.get(R._BODY_ROUTE_ATTACHMENTS_KEY))
        self.assertEqual(len(ctrl.erros), 1)

    def test_duplicata_vincula_os_anexos_a_conta_existente(self):
        rec, ctrl, _ = _processa(CORPO_2215, ["63868.pdf"], {"63868.pdf": [PEDIDO]},
                                 ctrl=_Ctrl(duplicata={"id": 55}))
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(ctrl.anexos, [(55, "63868.pdf")])
        self.assertEqual(rec["status"], "duplicidade")

    def test_corpo_que_falha_nao_fica_extraido_e_registra_erro(self):
        rec, ctrl, _ = _processa(CORPO_2215, ["63868.pdf"], {"63868.pdf": [PEDIDO]},
                                 ctrl=_Ctrl(grava=False))
        self.assertNotEqual(rec["status"], "extraído")
        self.assertTrue(ctrl.erros, "sem conta e sem erro seria perda silenciosa")


class NaoDesviaTest(unittest.TestCase):
    """Cada caso e um pagavel real que tem de continuar no caminho do anexo."""

    def _segue_no_anexo(self, linha, corpo=CORPO_2215, sender="estela@lebianco.com.br"):
        arquivo = linha["source_file"]
        rec, ctrl, _ = _processa(corpo, [arquivo], {arquivo: [linha]}, sender=sender)
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")
        self.assertEqual(float(ctrl.contas[0]["amount"]), float(linha["amount"]))
        self.assertEqual(rec["status"], "extraído")

    def test_boleto_escaneado_sem_codigo_conta_324(self):
        self._segue_no_anexo(BOLETO_SEM_CODIGO)

    def test_boleto_com_barcode(self):
        self._segue_no_anexo({**BOLETO_SEM_CODIGO, "document_type": "fatura", "payment_method": "pix",
                              "barcode": "34191790010104351004791020150008291070026000"})

    def test_codigo_descartado_tem_instrumento(self):
        self._segue_no_anexo({**PEDIDO,
                              "processing_notes": "Código de barras descartado: DV não confere"})

    def test_tipo_fora_da_allowlist_de_comprovante(self):
        self._segue_no_anexo({**PEDIDO, "document_type": "fatura", "payment_method": "pix"})

    def test_guia_de_tributo_conta_602(self):
        self._segue_no_anexo({**PEDIDO, "document_type": "darf", "payment_method": "pix"})

    def test_remetente_externo(self):
        self._segue_no_anexo(PEDIDO, sender="financeiro@fornecedor.com.br")

    def test_sem_frase_de_pedido_conta_1828(self):
        self._segue_no_anexo(PEDIDO, corpo="Segue comprovante.\r\nValor: R$ 15.055,20\r\n")

    def test_encaminhamento_de_terceiro(self):
        corpo = "De: Fornecedor <f@x.com.br>\r\nAssunto: fatura\r\n\r\n" + CORPO_2215
        self._segue_no_anexo(PEDIDO, corpo=corpo)

    def test_corpo_de_valor_zero_nao_tira_a_conta_do_anexo(self):
        self._segue_no_anexo(PEDIDO, corpo=CORPO_2215.replace("R$ 15.055,20", "R$ 0,00"))

    def test_confirmacao_encaminhada_nao_tira_a_conta_do_anexo(self):
        # O caminho do corpo a ignoraria: sem conta, sem erro e com o anexo descartado.
        corpo = CORPO_2215 + "\r\nDe: Banco <x@banco.com.br>\r\nAssunto: Confirmação de pagamento\r\n"
        self._segue_no_anexo(PEDIDO, corpo=corpo)

    def test_scripts_sem_o_opt_in_nao_desviam(self):
        ctrl = _Ctrl()
        with mock.patch.object(R, "_attachment_text", lambda p: ""), \
             mock.patch.object(R, "_register_fiscal_documents", mock.MagicMock()), \
             mock.patch.object(R, "run_extraction", lambda p, pw=None: (str(p), None)), \
             mock.patch.object(R, "read_extracted_rows", lambda c: [PEDIDO]):
            R.extract_and_store_accounts(
                [Path("63868.pdf")], "<m>", ctrl, body_text=CORPO_2215,
                email_rec={"sender_email": "estela@lebianco.com.br", "subject": "PAGAMENTO"})
        self.assertEqual(len(ctrl.contas), 1, "script sem fallback de corpo perderia a conta")


class RepresentanteTest(unittest.TestCase):
    def test_externo_nao_usa_o_rotulo(self):
        corpo = "Por gentileza fazer o pagamento.\r\nRepresentante: Fulano de Tal\r\nValor: R$ 10,00\r\n"
        self.assertIsNone(R._internal_request_representative(corpo, "x@fornecedor.com.br"))
        self.assertEqual(R._internal_request_representative(corpo, "x@lebianco.com.br"), "Fulano de Tal")

    def test_interno_sem_pedido_nao_usa_o_rotulo(self):
        self.assertIsNone(R._internal_request_representative(
            "Representante: Fulano\r\n", "x@lebianco.com.br"))


if __name__ == "__main__":
    unittest.main()
