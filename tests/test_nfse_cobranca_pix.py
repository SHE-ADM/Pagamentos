"""
NFS-e que E A PROPRIA COBRANCA (instrucao PIX no documento, sem boleto no e-mail).

Caso de origem: DANIEL TOSHIAKI SUZUKI (sk 1289), NFS-e 34 de Barueri, R$ 2.051,96 — e-mail 2419
(24/09/2026). O prestador ME nao emite boleto: a discriminacao da nota diz "Pagamento por PIX para
chave email: ...". SKIP_ACCOUNT_TYPES descartava a linha e o e-mail virava 'ignorado'.

Executa `extract_and_store_accounts` (a funcao de topo do caminho de anexo) com o texto cru do
anexo simulado — nao so o helper puro — para travar o WIRING Passo 1 → Passo 2.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_TESTS_DIR))
sys.path.insert(0, str(_TESTS_DIR.parent / "skills" / "email-reader" / "scripts"))

import read_emails  # noqa: E402
from test_fatura_boleto import BOLETO_REAL, CHAVE_44, FakeControl, REC  # noqa: E402

# Trecho REAL (pdfplumber) da NFS-e de Barueri — inclusive os acentos corrompidos (U+FFFD) e o
# rotulo "Forma Pagamento" VAZIO, que nao pode sozinho promover nota nenhuma.
NFSE_BARUERI_TEXT = (
    "NOTA FISCAL ELETRONICA DE SERVICOS - NFE Data Emiss�o Hora Emiss�o\n"
    "Prestador de Servi�os 48.490.570 DANIEL TOSHIAKI SUZUKI\n"
    "DISCRIMINA��O DOS SERVI�OS E INFORMA��ES RELEVANTES\n"
    "Hosting da plataforma de compras da Le Bianco (referente a Julho e Agosto de 2026).\n"
    "Pagamento por PIX para chave email: daniel@kasato.ventures\n"
    "VALOR TOTAL DA NOTA 2.051,96\n"
    "Fatura N� Valor da Fatura R$ Forma Pagamento\n"
)
# Mesmo layout SEM a instrucao — a NFS-e do prestador que cobra por boleto separado.
NFSE_SEM_INSTRUCAO = NFSE_BARUERI_TEXT.replace(
    "Pagamento por PIX para chave email: daniel@kasato.ventures\n", "")


def _nfse_row(name, doc_type="nfse", amount="2051.96", barcode=None, description=None):
    return {
        "source_file": name,
        "document_type": doc_type,
        "barcode": barcode,
        "amount": amount,
        "supplier_name": "DANIEL TOSHIAKI SUZUKI",
        "supplier_cnpj": "48490570000133",
        "invoice_number": "0000034",
        "due_date": "2026-09-22",
        "issue_date": "2026-09-22",
        "payment_method": "outro",
        "description": description,
        "extraction_source": "pdf_text",
    }


def _run(rows_by_name, texts_by_name):
    """extract_and_store_accounts com extracao e TEXTO CRU do anexo simulados."""
    ctrl = FakeControl()
    saved = [Path(n) for n in rows_by_name]

    def fake_run_extraction(pdf_path, pdf_passwords=None):
        return (pdf_path.name, None)

    def fake_read_rows(csv_path):
        return [rows_by_name[Path(csv_path).name]]

    def fake_attachment_text(pdf_path):
        return texts_by_name.get(Path(pdf_path).name, "")

    with patch.object(read_emails, "run_extraction", fake_run_extraction), \
         patch.object(read_emails, "read_extracted_rows", fake_read_rows), \
         patch.object(read_emails, "_attachment_text", fake_attachment_text):
        _, saved_count, nonpayable_only, att_account = read_emails.extract_and_store_accounts(
            saved, "<MID>", ctrl, email_rec=dict(REC))
    return ctrl, saved_count, nonpayable_only, att_account


class InstrucaoPixDetectorTest(unittest.TestCase):
    def test_frase_real_do_caso(self):
        self.assertTrue(read_emails._nfse_payment_instruction(NFSE_BARUERI_TEXT))

    def test_frase_quebrada_em_linhas_e_com_acento(self):
        self.assertTrue(read_emails._nfse_payment_instruction("Transferência\nvia\n  PIX"))
        self.assertTrue(read_emails._nfse_payment_instruction("Chave PIX: 123.456.789-00"))
        self.assertTrue(read_emails._nfse_payment_instruction("pagar pelo pix"))

    def test_pix_copia_e_cola_emv(self):
        emv = "00020126360014BR.GOV.BCB.PIX0114+5511999999995204000053039865802BR"
        self.assertTrue(read_emails._nfse_payment_instruction(emv))

    def test_negativos(self):
        # Rotulo VAZIO do layout, palavra solta e texto sem pix nao sao instrucao.
        self.assertFalse(read_emails._nfse_payment_instruction(NFSE_SEM_INSTRUCAO))
        self.assertFalse(read_emails._nfse_payment_instruction("Forma de pagamento: boleto"))
        self.assertFalse(read_emails._nfse_payment_instruction("Aceitamos PIX"))
        self.assertFalse(read_emails._nfse_payment_instruction(None, "", None))

    def test_qualquer_texto_basta(self):
        self.assertTrue(read_emails._nfse_payment_instruction(None, "", "Pagamento via PIX"))


class NfseCobrancaPixTest(unittest.TestCase):
    def test_caso_real_nfse_com_pix_vira_conta(self):
        ctrl, saved, nonpayable, att_account = _run(
            {"nf.pdf": _nfse_row("nf.pdf")}, {"nf.pdf": NFSE_BARUERI_TEXT})
        self.assertEqual(saved, 1)
        self.assertFalse(nonpayable)          # nao vira 'ignorado'
        self.assertTrue(att_account)          # suprime o fallback do corpo
        self.assertEqual(ctrl.error_calls, [])
        conta = ctrl.financial_calls[0]
        self.assertEqual(conta["document_type"], "nfse")       # convencao das contas manuais
        self.assertEqual(conta["payment_method"], "pix")
        self.assertEqual(float(conta["amount"]), 2051.96)
        self.assertIn(read_emails.NFSE_OWN_CHARGE_NOTE, conta["processing_notes"])
        self.assertEqual(ctrl.attachment_calls, [(1, "nf.pdf")])

    def test_nfse_sem_instrucao_segue_ignorada(self):
        ctrl, saved, nonpayable, _ = _run(
            {"nf.pdf": _nfse_row("nf.pdf")}, {"nf.pdf": NFSE_SEM_INSTRUCAO})
        self.assertEqual(saved, 0)
        self.assertTrue(nonpayable)
        self.assertEqual(ctrl.financial_calls, [])

    def test_nfse_com_pix_mais_boleto_separado_grava_so_o_boleto(self):
        # Prestador PJ: nota + boleto em anexos separados, valores distintos (retencao). A
        # nota NAO pode virar 2a conta da mesma divida.
        rows = {
            "nf.pdf": _nfse_row("nf.pdf", amount="2051.96"),
            "boleto.pdf": _nfse_row("boleto.pdf", doc_type="boleto", amount="1990.40",
                                    barcode=BOLETO_REAL),
        }
        ctrl, saved, _, _ = _run(rows, {"nf.pdf": NFSE_BARUERI_TEXT})
        self.assertEqual(saved, 1)
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)

    def test_nfe_de_mercadoria_com_pix_segue_ignorada(self):
        ctrl, saved, nonpayable, _ = _run(
            {"nf.pdf": _nfse_row("nf.pdf", doc_type="nfe", barcode=CHAVE_44)},
            {"nf.pdf": NFSE_BARUERI_TEXT})
        self.assertEqual(saved, 0)
        self.assertTrue(nonpayable)

    def test_nfse_escaneada_sinal_pela_descricao_do_modelo(self):
        # PDF sem camada de texto: o texto cru vem vazio e a descricao transcrita decide.
        row = _nfse_row("scan.pdf", description="Hosting. Pagamento via PIX chave CNPJ")
        ctrl, saved, _, _ = _run({"scan.pdf": row}, {})
        self.assertEqual(saved, 1)
        self.assertEqual(ctrl.financial_calls[0]["document_type"], "nfse")

    def test_forma_de_pagamento_lida_pelo_modelo_e_preservada(self):
        row = _nfse_row("nf.pdf")
        row["payment_method"] = "ted"
        ctrl, _, _, _ = _run({"nf.pdf": row}, {"nf.pdf": NFSE_BARUERI_TEXT})
        self.assertEqual(ctrl.financial_calls[0]["payment_method"], "ted")


if __name__ == "__main__":
    unittest.main()
