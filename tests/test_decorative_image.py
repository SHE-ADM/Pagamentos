"""
test_decorative_image.py — imagem decorativa ao lado de um pagável não gera `sem_valor`.

MEDIDO (24/11/2026): 19 das 25 linhas `sem_valor` do banco eram imagens lidas pelo Vision sem
valor e sem código de barras. As recorrentes: o banner da ALKO (`banner_cat_dekorama-.gif`,
1,9 MB, em todo e-mail de boleto dela) e a assinatura da Sevenlog (13 KB, "Contato WhatsApp:
(11)94759-4855"). Nos dois casos outro anexo do MESMO e-mail respondeu pelo pagável, e a linha
em /erros culpava a imagem por um valor que ela nunca teve.

Regra: imagem VAZIA de dado financeiro + outro anexo que respondeu ⇒ nota no e-mail, sem erro.
O que este arquivo trava:
  1. o critério de "vazia" é estreito — um mutante por condição;
  2. sozinha, a imagem continua gerando `sem_valor` (pode ser o único documento do e-mail);
  3. o sufixo posicional `#N` do `gmail_message_id` das contas seguintes NÃO muda;
  4. a supressão deixa rastro (nota acrescentada, nunca atribuída) e só existe quando o
     chamador pode persisti-lo (`note_decorative_images`).
"""

import sys
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402
from test_boleto_dedup_suppresses_body import REC, FakeControl, _boleto_row  # noqa: E402

NOTAS_VAZIAS = ("Vencimento ausente — usando data da extração | "
                "N documento ausente — gerado de tipo+vencimento")


def _imagem(**campos) -> dict:
    """Linha como o Vision a devolveu para a assinatura da Sevenlog (erro 460 em produção)."""
    row = {
        "source_file": "adm_FATURA_OTIMOTEX_14080_a66c1adb.png",
        "extraction_source": "image_vision",
        "document_type": "outro",
        "amount": "0.0",
        "barcode": "",
        "supplier_name": "SEVEN EXPRESS",
        "supplier_cnpj": "",
        "supplier_cpf": "",
        "nosso_numero": "",
        "invoice_number": "outro_241126",
        "due_date": "2026-11-24",
        "description": "Contato WhatsApp: (11)94759-4855",
        "processing_notes": NOTAS_VAZIAS,
    }
    row.update(campos)
    return row


class CriterioDeImagemVaziaTest(unittest.TestCase):
    def test_os_dois_casos_reais_sao_reconhecidos(self):
        self.assertTrue(R._is_empty_image_row(_imagem()))                       # Sevenlog
        self.assertTrue(R._is_empty_image_row(_imagem(                          # banner da Alko
            source_file="bi_Boleto_de_Pagamento_banner_cat_dekorama-.gif",
            supplier_name="Dekorama / Alko", description="", invoice_number="outro_151026")))

    def test_qualquer_sinal_de_documento_desqualifica(self):
        # Um caso por condição — cada um é o retrato de um documento que TEM de seguir visível.
        casos = {
            "QR de PIX (Pagamento Bordados)": {
                "description": "Escaneie e pague ou copie e cole o código PIX: 000201..."},
            # Telefone é sinal de contato — e aqui é a CHAVE de um pagamento. Sem o corte por
            # termo financeiro, a instrução de PIX seria tratada como assinatura (mutante D7).
            "chave PIX por telefone": {"description": "Chave PIX celular: (11) 94759-4855"},
            "valor ao lado do contato": {
                "description": "Contato (11) 94759-4855 — valor total R$ 150,00"},
            "foto descrita como documento": {"description": "Foto desfocada de um documento"},
            "boleto ilegível": {"description": "Boleto ilegível"},
            "banner descrito sem sinal de contato": {
                "description": "Imagem de cabecalho/banner das marcas Alko e Dekorama."},
            "tipo boleto (foto ilegível de boleto real)": {"document_type": "boleto"},
            "tipo recibo": {"document_type": "recibo"},
            "CNPJ lido": {"supplier_cnpj": "12345678000190"},
            "CPF lido": {"supplier_cpf": "12345678909"},
            "nosso número lido": {"nosso_numero": "25361496"},
            "código de barras lido": {"barcode": "1234"},
            "valor lido": {"amount": "150.00"},
            "vencimento lido": {"processing_notes": "N documento ausente — gerado de tipo+vencimento"},
            "Vision não devolveu JSON": {"processing_notes": "Vision retornou resposta não-JSON"},
            "nº de documento real": {"invoice_number": "0001234"},
            "PDF sem valor": {"extraction_source": "pdf_vision"},
            "texto de PDF sem valor": {"extraction_source": "pdf_text"},
        }
        for nome, campos in casos.items():
            with self.subTest(caso=nome):
                self.assertFalse(R._is_empty_image_row(_imagem(**campos)))

    def test_campos_ausentes_ou_nulos_nao_quebram(self):
        self.assertFalse(R._is_empty_image_row({}))
        self.assertTrue(R._is_empty_image_row({
            "extraction_source": "image_vision", "amount": None, "document_type": None,
            "description": None, "invoice_number": None, "processing_notes": NOTAS_VAZIAS}))


class PassoDoisTest(unittest.TestCase):
    """`extract_and_store_accounts` real, com a extração de cada anexo enlatada."""

    def _run(self, rows: list, ctrl=None, note=True, notes_iniciais=None):
        ctrl = ctrl or FakeControl()
        por_arquivo = {row["source_file"]: row for row in rows}
        rec = {**REC, "message_id": "<MID>", "notes": notes_iniciais}
        with patch.object(R, "run_extraction", lambda p, pdf_passwords=None: (p.name, None)), \
                patch.object(R, "read_extracted_rows", lambda csv: [por_arquivo[Path(csv).name]]):
            resultado = R.extract_and_store_accounts(
                [Path(row["source_file"]) for row in rows], "<MID>", ctrl,
                email_rec=rec, note_decorative_images=note)
        return ctrl, rec, resultado

    def test_imagem_vazia_ao_lado_de_boleto_gravado_vira_nota(self):
        ctrl, rec, (_csvs, accounts_saved, _np, attachment_account) = self._run(
            [_imagem(), _boleto_row()])
        self.assertEqual(accounts_saved, 1)
        self.assertTrue(attachment_account)
        self.assertEqual(ctrl.error_calls, [])                       # nenhum sem_valor
        self.assertIn(R.DECORATIVE_IMAGE_NOTE, rec["notes"])
        self.assertIn("adm_FATURA_OTIMOTEX_14080_a66c1adb.png", rec["notes"])
        # 🔴 O sufixo posicional NÃO muda: a imagem continua ocupando a posição 0.
        self.assertEqual(ctrl.financial_calls[0]["gmail_message_id"], "<MID>#1")

    def test_imagem_vazia_ao_lado_de_boleto_deduplicado_vira_nota(self):
        ctrl = FakeControl(dup={"id": 159, "due_date": "2026-07-18"})
        ctrl, rec, (_csvs, accounts_saved, _np, attachment_account) = self._run(
            [_imagem(), _boleto_row()], ctrl=ctrl)
        self.assertEqual((accounts_saved, attachment_account), (0, True))
        self.assertEqual(ctrl.error_calls, [])
        self.assertIn(R.DECORATIVE_IMAGE_NOTE, rec["notes"])

    def test_a_ordem_dos_anexos_nao_importa(self):
        ctrl, rec, _resultado = self._run([_boleto_row(), _imagem()])
        self.assertEqual(ctrl.error_calls, [])
        self.assertIn(R.DECORATIVE_IMAGE_NOTE, rec["notes"])
        self.assertEqual(ctrl.financial_calls[0]["gmail_message_id"], "<MID>")

    def test_imagem_vazia_sozinha_segue_sem_valor_identico(self):
        # Pode ser o único documento do e-mail: é a linha em /erros que chama alguém.
        ctrl, rec, (_csvs, accounts_saved, _np, attachment_account) = self._run([_imagem()])
        self.assertEqual((accounts_saved, attachment_account), (0, False))
        self.assertEqual(ctrl.error_calls, [
            ("sem_valor", "Valor ausente ou zero — adm_FATURA_OTIMOTEX_14080_a66c1adb.png")])
        self.assertIsNone(rec["notes"])

    def test_imagem_com_sinal_de_documento_segue_sem_valor_mesmo_com_boleto(self):
        qr_pix = _imagem(source_file="bruna_Pagamento_Bordados_WhatsApp.jpeg",
                         description="Escaneie e pague ou copie e cole o código PIX")
        ctrl, rec, _resultado = self._run([qr_pix, _boleto_row()])
        self.assertEqual([tipo for tipo, _msg in ctrl.error_calls], ["sem_valor"])
        self.assertIsNone(rec["notes"])
        # Mesma posição de sempre para o boleto: a contraprova de que os dois ramos
        # incrementam o índice do mesmo jeito.
        self.assertEqual(ctrl.financial_calls[0]["gmail_message_id"], "<MID>#1")

    def test_sem_o_opt_in_o_comportamento_e_o_de_sempre(self):
        # Scripts de reprocesso não persistem `email_rec["notes"]`: sem rastro, sem supressão.
        ctrl, rec, _resultado = self._run([_imagem(), _boleto_row()], note=False)
        self.assertEqual([tipo for tipo, _msg in ctrl.error_calls], ["sem_valor"])
        self.assertIsNone(rec["notes"])

    def test_a_nota_e_acrescentada_e_nao_atribuida(self):
        _ctrl, rec, _resultado = self._run([_imagem(), _boleto_row()],
                                           notes_iniciais="PDF baixado de link no corpo do e-mail")
        self.assertTrue(rec["notes"].startswith("PDF baixado de link no corpo do e-mail | "))
        self.assertIn(R.DECORATIVE_IMAGE_NOTE, rec["notes"])

    def test_varias_imagens_a_nota_lista_ate_o_limite(self):
        imagens = [_imagem(source_file=f"assinatura_{i}.png") for i in range(5)]
        _ctrl, rec, _resultado = self._run(imagens + [_boleto_row()])
        self.assertIn("assinatura_0.png, assinatura_1.png, assinatura_2.png (+2)", rec["notes"])


class _Ctrl(FakeControl):
    """FakeControl + o que `process_message` usa para registrar o e-mail."""

    def __init__(self):
        super().__init__()
        self.registrados = []

    def register(self, rec):
        self.registrados.append(dict(rec))
        return True

    def delete_errors(self, message_id, error_type):
        """Limpeza do erro transitório ao concluir — inerte no dublê."""

    def has_error(self, message_id, error_type):
        return False


class NotaChegaAoRegistroTest(unittest.TestCase):
    """`process_message` de ponta a ponta: a nota tem de chegar a `email_control`."""

    def test_process_message_liga_a_regra_e_persiste_a_nota(self):
        msg = EmailMessage()
        msg["Subject"] = "FATURA OTIMOTEX (14080) - Vencimento 24/11/26"
        msg["From"] = "adm@sevenlog.com.br"
        msg["Message-ID"] = "<015e@sevenlog.com.br>"
        msg.set_content("Boa tarde. Segue boleto e fatura.")
        raw = msg.as_bytes()

        class _Mail:
            def uid(self, _cmd, _uid, _spec=None):
                return "OK", [(b'1 (INTERNALDATE "19-Nov-2026 15:25:56 -0300" RFC822 {1}', raw)]

        rows = {"a66c1adb.png": _imagem(source_file="a66c1adb.png"),
                "boleto_ober.pdf": _boleto_row()}
        ctrl = _Ctrl()
        with patch.object(R, "save_attachments",
                          lambda *a, **k: [Path("a66c1adb.png"), Path("boleto_ober.pdf")]), \
                patch.object(R, "_attachment_text", return_value=""), \
                patch.object(R, "run_extraction", lambda p, pdf_passwords=None: (p.name, None)), \
                patch.object(R, "read_extracted_rows", lambda csv: [rows[Path(csv).name]]), \
                patch.object(R, "append_log_csv", return_value=None):
            rec = R.process_message(_Mail(), b"1", ["fatura"], False, False, ctrl)

        self.assertEqual(rec["status"], "extraído")
        self.assertEqual([tipo for tipo, _msg in ctrl.error_calls], [])
        registrado = ctrl.registrados[-1]
        self.assertIn(R.DECORATIVE_IMAGE_NOTE, registrado["notes"])
        self.assertIn("a66c1adb.png", registrado["notes"])


if __name__ == "__main__":
    unittest.main()
