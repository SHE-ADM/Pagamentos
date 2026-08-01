"""Gancho de documento fiscal no Passo 1 do reader (Onda 3).

O QUE ESTES TESTES TRAVAM (e por que cada um existe)

  - O registro acontece no **Passo 1**, ANTES do `run_extraction` — nao e detalhe de estilo:
    e o que garante a captura da chave quando a Claude API esta fora. O teste observa a
    ORDEM das chamadas, nao apenas que as duas aconteceram.
  - Registra TAMBEM quando a linha vira conta (boleto de transporte que traz junto a chave do
    CT-e). Ancorar nos pontos de `skipped_nonpayable` perderia justamente esse caso.
  - A regra de negocio fica INTACTA: CT-e sem boleto continua sem gerar conta a pagar.
  - Falha no registro fiscal NAO derruba a extracao financeira (validado por mutante: o fake
    levanta, e a conta tem de ser gravada assim mesmo).
  - Sem o modulo `fiscal_key` (deploy parcial) o reader degrada em silencio funcional — nao
    grava nada, nao quebra nada.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

# Chave real do CT-e da conta 376 (dado publico de nota fiscal).
CTE_KEY = "35260792528538000434570000018980031498026869"
# Linha digitavel de boleto real (caso padariabelga, id 388) — pagavel de verdade.
BOLETO_REAL = "23797150300020100800165090000000182600836500"

DACTE_TEXT = f"DACTE\nCHAVE DE ACESSO\n{CTE_KEY}\nEmitente: TRANSPORTADORA X"

REC = {
    "message_id":  "<MID-CTE>",
    "received_at": "2026-07-03T12:00:00+00:00",
    "subject":     "CT-e - Numero 1898003",
    "sender_email": "sistemas@transportadora.com.br",
}


class FakeControl:
    """Stub de SupabaseControl que registra as chamadas E a ordem entre elas."""

    def __init__(self, fiscal_raises=False):
        self.financial_calls = []
        self.fiscal_calls = []
        self.error_calls = []
        self.order = []
        self._fiscal_raises = fiscal_raises

    # -- caminho fiscal (Onda 3) -------------------------------------------------
    def register_fiscal_document(self, doc, storage_key=None, ctx=None):
        if self._fiscal_raises:
            raise RuntimeError("banco fora do ar")
        self.fiscal_calls.append((doc, storage_key, ctx))
        self.order.append("fiscal")
        return True

    # -- caminho financeiro ------------------------------------------------------
    def register_financial(self, payload):
        self.financial_calls.append(payload)
        self.order.append("financial")
        return len(self.financial_calls)

    def upload_attachment(self, pdf_path):
        self.order.append("upload")
        return True

    def register_attachment(self, account_id, file_name, size_bytes=0, uploaded_by=None):
        return True

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

    def company_cnpj(self):
        return None

    def resolve_user(self, sender_email):
        return None

    def unique_invoice_number(self, base):
        return base

    def find_financial_duplicate(self, payload):
        return None

    def resolve_supplier(self, payload):
        return 1

    def supplier_defaults(self, sk_supplier):
        return (0, 0)

    def update_financial(self, *args, **kwargs):
        return True


def _row(name, barcode, doc_type="cte"):
    return {
        "source_file": name,
        "document_type": doc_type,
        "barcode": barcode,
        "amount": "1500.00",
        "supplier_name": "TRANSPORTADORA X",
        "invoice_number": "1898003",
        "due_date": "2026-08-10",
        "extraction_source": "pdf_text",
    }


class _RunnerMixin:
    """Executa extract_and_store_accounts com o texto do PDF e a extracao controlados."""

    def _run(self, texts_by_name, rows_by_name, ctrl=None, extraction_fails=False):
        ctrl = ctrl or FakeControl()
        saved = [Path(n) for n in texts_by_name]

        def fake_run_extraction(pdf_path, pdf_passwords=None):
            ctrl.order.append("extract")
            if extraction_fails:
                return (None, "Claude API indisponivel")
            return (pdf_path.name, None)

        with patch.object(R, "_pdf_text", lambda p: texts_by_name[Path(p).name]), \
             patch.object(R, "run_extraction", fake_run_extraction), \
             patch.object(R, "read_extracted_rows",
                          lambda csv: [rows_by_name[Path(csv).name]]):
            _, saved_count, nonpayable_only, _att = R.extract_and_store_accounts(
                saved, "<MID-CTE>", ctrl, email_rec=dict(REC))
        return ctrl, saved_count, nonpayable_only


class RegistraDocumentoFiscalTest(_RunnerMixin, unittest.TestCase):
    def test_cte_sem_boleto_registra_documento_e_nao_cria_conta(self):
        """O caso central da onda: o documento deixa de ser esquecido, a regra nao muda."""
        ctrl, saved_count, nonpayable_only = self._run(
            {"dacte.pdf": DACTE_TEXT}, {"dacte.pdf": _row("dacte.pdf", None)})

        self.assertEqual(len(ctrl.fiscal_calls), 1)
        doc, storage_key, ctx = ctrl.fiscal_calls[0]
        self.assertEqual(doc["access_key"], CTE_KEY)
        self.assertEqual(doc["model"], 57)
        self.assertEqual(storage_key, "dacte.pdf")

        # Regra de negocio intacta: CT-e sem boleto NAO vira conta a pagar.
        self.assertEqual(saved_count, 0)
        self.assertEqual(ctrl.financial_calls, [])
        self.assertTrue(nonpayable_only)

    def test_registra_ANTES_da_extracao(self):
        """Nao basta os dois acontecerem: se o registro ficasse depois do run_extraction, a
        chave se perderia sempre que a Claude API estivesse fora."""
        ctrl, _, _ = self._run({"dacte.pdf": DACTE_TEXT},
                               {"dacte.pdf": _row("dacte.pdf", None)})
        self.assertLess(ctrl.order.index("fiscal"), ctrl.order.index("extract"))

    def test_registra_mesmo_com_a_extracao_falhando(self):
        """Consequencia observavel da ordem acima — o cenario que a motiva."""
        ctrl, saved_count, _ = self._run(
            {"dacte.pdf": DACTE_TEXT}, {}, extraction_fails=True)
        self.assertEqual(len(ctrl.fiscal_calls), 1)
        self.assertEqual(saved_count, 0)
        self.assertTrue(ctrl.error_calls)   # a falha de extracao segue sendo logada

    def test_registra_tambem_quando_a_linha_VIRA_conta(self):
        """Boleto de transporte que traz a chave do CT-e junto — hoje a chave se perde.

        E a razao de o gancho estar no Passo 1 e nao nos pontos de skipped_nonpayable.
        """
        ctrl, saved_count, _ = self._run(
            {"boleto_cte.pdf": DACTE_TEXT},
            {"boleto_cte.pdf": _row("boleto_cte.pdf", BOLETO_REAL, doc_type="boleto")})
        self.assertEqual(len(ctrl.fiscal_calls), 1)
        self.assertEqual(saved_count, 1)         # o boleto virou conta, como antes

    def test_proveniencia_vai_junto(self):
        ctrl, _, _ = self._run({"dacte.pdf": DACTE_TEXT},
                               {"dacte.pdf": _row("dacte.pdf", None)})
        _doc, _key, ctx = ctrl.fiscal_calls[0]
        self.assertEqual(ctx.get("message_id"), "<MID-CTE>")
        self.assertEqual(ctx.get("sender_email"), REC["sender_email"])
        self.assertEqual(ctx.get("subject"), REC["subject"])

    def test_dois_anexos_cada_um_com_sua_chave(self):
        # NF-e sintetica: a chave real com o modelo trocado para 55 e o DV recalculado.
        corpo = CTE_KEY[:20] + "55" + CTE_KEY[22:43]
        pesos = [2, 3, 4, 5, 6, 7, 8, 9]
        soma = sum(int(d) * pesos[i % 8] for i, d in enumerate(reversed(corpo)))
        resto = soma % 11
        nfe = corpo + ("0" if resto in (0, 1) else str(11 - resto))

        ctrl, _, _ = self._run(
            {"a.pdf": DACTE_TEXT, "b.pdf": f"DANFE {nfe}"},
            {"a.pdf": _row("a.pdf", None), "b.pdf": _row("b.pdf", None, doc_type="nfe")})
        chaves = {c[0]["access_key"] for c in ctrl.fiscal_calls}
        self.assertEqual(chaves, {CTE_KEY, nfe})

    def test_mesma_chave_repetida_no_texto_registra_uma_vez(self):
        ctrl, _, _ = self._run({"dacte.pdf": f"{DACTE_TEXT}\n--- verso ---\n{CTE_KEY}"},
                               {"dacte.pdf": _row("dacte.pdf", None)})
        self.assertEqual(len(ctrl.fiscal_calls), 1)


class DegradacaoTest(_RunnerMixin, unittest.TestCase):
    def test_falha_no_registro_fiscal_nao_derruba_a_extracao(self):
        """Mutante: o registro levanta. A conta a pagar TEM de ser gravada assim mesmo."""
        ctrl = FakeControl(fiscal_raises=True)
        ctrl, saved_count, _ = self._run(
            {"boleto_cte.pdf": DACTE_TEXT},
            {"boleto_cte.pdf": _row("boleto_cte.pdf", BOLETO_REAL, doc_type="boleto")},
            ctrl=ctrl)
        self.assertEqual(ctrl.fiscal_calls, [])   # nao registrou
        self.assertEqual(saved_count, 1)          # ... e a conta saiu do mesmo jeito

    def test_sem_o_modulo_fiscal_key_nao_grava_e_nao_quebra(self):
        """Deploy parcial (read_emails.py copiado sem fiscal_key.py)."""
        with patch.object(R, "_fiscal_key", lambda: None):
            ctrl, saved_count, _ = self._run(
                {"boleto_cte.pdf": DACTE_TEXT},
                {"boleto_cte.pdf": _row("boleto_cte.pdf", BOLETO_REAL, doc_type="boleto")})
        self.assertEqual(ctrl.fiscal_calls, [])
        self.assertEqual(saved_count, 1)

    def test_pdf_sem_texto_nao_registra_nada(self):
        """Imagem, PDF cifrado ou pdfplumber falhando: `_pdf_text` devolve ""."""
        ctrl, _, _ = self._run({"foto.pdf": ""}, {"foto.pdf": _row("foto.pdf", None)})
        self.assertEqual(ctrl.fiscal_calls, [])

    def test_texto_sem_chave_valida_nao_registra(self):
        """44 digitos NAO bastam — o codigo de arrecadacao da conta 267 e um caso real."""
        arrecadacao = "81819467030002993820000023635570120871010001"
        ctrl, _, _ = self._run({"guia.pdf": f"Guia DAMSP {arrecadacao}"},
                               {"guia.pdf": _row("guia.pdf", None, doc_type="dam / duam")})
        self.assertEqual(ctrl.fiscal_calls, [])


class HelperUnitarioTest(unittest.TestCase):
    def test_sem_storage_key_nao_registra(self):
        ctrl = FakeControl()
        self.assertEqual(R._register_fiscal_documents(ctrl, DACTE_TEXT, ""), 0)
        self.assertEqual(ctrl.fiscal_calls, [])

    def test_devolve_a_contagem_de_gravados(self):
        ctrl = FakeControl()
        self.assertEqual(R._register_fiscal_documents(ctrl, DACTE_TEXT, "x.pdf"), 1)


if __name__ == "__main__":
    unittest.main()
