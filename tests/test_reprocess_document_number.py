"""
scripts/reprocess_document_number.py — correção retroativa do "Nº Documento" dos boletos que
gravaram o NOSSO NÚMERO em `invoice_number`.

O risco do script é gravar o número de OUTRO boleto: um PDF de carnê guarda N títulos, e ler o
documento inteiro devolveria o do primeiro. Por isso a página é escolhida pelo nosso número
da própria conta, e ambiguidade não grava.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import reprocess_document_number as S

F = "�"
HEADER = f"Data Documento Nr. do Documento Esp{F}cie Doc. Aceite Data Processamento Nosso N{F}mero"


def _pagina(doc: str, nosso: str) -> str:
    return (f"Nome do Bene(cid:141)ci{F}rio CNPJ Nosso N{F}mero\n"
            f"RAINHA MARIA IMPORTACAO E EXPORTACAO LTD 39.697.742/0001-53 {nosso}\n"
            f"{HEADER}\n11/09/2026 {doc} DM N 11/09/2026 {nosso}\n")


NN_1 = "00035803290000004122-7"
NN_2 = "00035803290000004123-5"
CARNE = [_pagina("NF16751-7", NN_1), _pagina("NF16752-7", NN_2)]
CONTA_2 = {"id": 1507, "sk_supplier": 936, "source_file": "carne.pdf",
           "invoice_number": NN_2, "nosso_numero": NN_2}


class LegacyInvoiceTest(unittest.TestCase):
    def test_copia_do_nosso_numero(self):
        self.assertTrue(S.is_legacy_invoice(CONTA_2))
        # Mesma sequência com outra formatação ainda é cópia.
        self.assertTrue(S.is_legacy_invoice({"invoice_number": "35803290000004123",
                                             "nosso_numero": "358032900000041235"[:-1]}))

    def test_numero_proprio_ou_curto_nao_entra(self):
        self.assertFalse(S.is_legacy_invoice({"invoice_number": "NF16752-7", "nosso_numero": NN_2}))
        self.assertFalse(S.is_legacy_invoice({"invoice_number": "1234", "nosso_numero": "1234"}))
        self.assertFalse(S.is_legacy_invoice({"invoice_number": None, "nosso_numero": None}))


class PageOfTitleTest(unittest.TestCase):
    def test_escolhe_a_pagina_do_proprio_titulo_no_carne(self):
        # 🔴 Ler o PDF inteiro daria 'NF16751-7' (a 1ª parcela) para a conta da 2ª.
        self.assertEqual(S.page_of_title(CARNE, NN_2), CARNE[1])

    def test_ambiguo_ou_ausente_nao_escolhe(self):
        self.assertIsNone(S.page_of_title(CARNE + [CARNE[1]], NN_2))
        self.assertIsNone(S.page_of_title(CARNE, "00035803290000009999-9"))
        self.assertIsNone(S.page_of_title(CARNE, None))


class ResolveTest(unittest.TestCase):
    def test_le_o_numero_da_pagina_certa(self):
        self.assertEqual(S.resolve_document_number(CARNE, CONTA_2), ("NF16752-7", "ok"))

    def test_ficha_que_imprime_o_proprio_nosso_numero_nao_grava(self):
        pages = [_pagina(NN_2, NN_2)]
        doc, motivo = S.resolve_document_number(pages, CONTA_2)
        self.assertIsNone(doc)
        self.assertIn("já correto", motivo)

    def test_pdf_sem_texto_nao_grava(self):
        self.assertIsNone(S.resolve_document_number([""], CONTA_2)[0])


class MainTest(unittest.TestCase):
    """O fluxo de topo EXECUTADO, com a rede mockada."""

    def _run(self, argv):
        ctrl = mock.Mock(_available=True)
        with mock.patch.object(S.R, "SupabaseControl", return_value=ctrl), \
             mock.patch.object(S, "_get_all", return_value=[dict(CONTA_2)]) as get_all, \
             mock.patch.object(S, "_download_pages", return_value=CARNE), \
             mock.patch.object(S, "_patch_invoice") as patch:
            rc = S.main(argv)
        return rc, patch, get_all, ctrl

    def test_dry_run_nao_grava(self):
        rc, patch, _, _ = self._run(["--dry-run"])
        self.assertEqual(rc, 0)
        patch.assert_not_called()

    def test_aplica_o_numero_lido(self):
        rc, patch, get_all, ctrl = self._run(["--ids", "1507", "--supplier", "936"])
        self.assertEqual(rc, 0)
        patch.assert_called_once_with(ctrl, 1507, "NF16752-7")
        path = get_all.call_args.args[1]
        self.assertIn("id=in.(1507)", path)
        self.assertIn("sk_supplier=eq.936", path)

    def test_ids_invalidos_sao_recusados(self):
        with self.assertRaises(SystemExit):
            S.main(["--ids", "1507,abc"])


if __name__ == "__main__":
    unittest.main()
