"""
Testes da regra FATURA + BOLETO (multi-anexo):

  - E-mail com 2 anexos (fatura/relatorio + boleto) → so o BOLETO vira conta a
    pagar; a fatura descreve o MESMO debito e seria conta duplicada.
  - E-mail so com fatura (sem boleto) → a fatura e extraida normalmente.
  - O sinal e o CODIGO DE BARRAS (_is_boleto_barcode), nao o document_type — o
    extrator rotula tanto o boleto quanto o relatorio como 'boleto'.

Cobre o helper _email_has_real_boleto e o fluxo de extract_and_store_accounts
(com run_extraction/read_extracted_rows mockados), inclusive independencia da
ORDEM dos anexos (o pre-scan do passo 1 decide antes de gravar).
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Codigos de barras reais do caso padariabelga (id 388 boleto / id 387 relatorio).
BOLETO_REAL = "23797150300020100800165090000000182600836500"   # linha digitavel (Bradesco)
RELATORIO   = "35260660429792000146650050000059541448378262"   # 44 dig, NAO e boleto (pos.4='6')
CHAVE_44    = "1234" + "0" * 40                                 # chave de acesso -> nao-boleto


class FakeControl:
    """Stub de SupabaseControl — registra gravacoes/erros sem tocar o banco."""

    def __init__(self):
        self.financial_calls = []
        self.attachment_calls = []
        self.attachment_owners = []
        self.error_calls = []

    def upload_attachment(self, pdf_path):
        return True

    def company_cnpj(self):
        return None

    def register_financial(self, payload):
        self.financial_calls.append(payload)
        return len(self.financial_calls)  # id da conta (migration 079) — truthy, como o real

    def register_attachment(self, account_id, file_name, size_bytes=0, uploaded_by=None):
        self.attachment_calls.append((account_id, file_name))
        self.attachment_owners.append(uploaded_by)
        return True

    def resolve_user(self, sender_email):
        # Espelha o real: resolve o dono pelo remetente (a RPC devolve o sentinela quando
        # nao casa). O anexo do pipeline herda esse mesmo dono.
        return f"uuid-de-{sender_email}" if sender_email else None

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

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


def _row(name, barcode, doc_type="boleto", amount="20100.80"):
    """Linha de CSV minima (as chaves ausentes viram None em build_financial_payload)."""
    return {
        "source_file": name,
        "document_type": doc_type,
        "barcode": barcode,
        "amount": amount,
        "supplier_name": "PADARIA BELGA",
        "invoice_number": "",
        "due_date": "2026-07-10",
        "extraction_source": "pdf_text",
    }


REC = {
    "received_at": "2026-07-03T12:00:00+00:00",
    "subject": "Boleto e relatorio de consumo",
    "sender_email": "padariabelga@gmail.com",
}


class EmailHasRealBoletoTest(unittest.TestCase):
    def test_com_boleto_real(self):
        rows = [_row("relatorio.pdf", RELATORIO), _row("boleto.pdf", BOLETO_REAL)]
        self.assertTrue(read_emails._email_has_real_boleto(rows))

    def test_so_fatura_sem_boleto(self):
        rows = [_row("fatura.pdf", CHAVE_44, doc_type="fatura")]
        self.assertFalse(read_emails._email_has_real_boleto(rows))

    def test_vazio(self):
        self.assertFalse(read_emails._email_has_real_boleto([]))

    def test_barcode_real_e_relatorio_no_caso_real(self):
        # Trava o sinal no dado real: boleto=digitavel valida, relatorio=nao.
        self.assertTrue(read_emails._is_boleto_barcode(BOLETO_REAL))
        self.assertFalse(read_emails._is_boleto_barcode(RELATORIO))


class _StoreRunnerMixin:
    """Helper de execucao de extract_and_store_accounts (run_extraction/read_extracted_rows
    mockados). Mixin — NAO herdar entre TestCases (o unittest re-rodaria os testes do pai)."""

    def _run(self, saved_names, rows_by_name, subject=None):
        ctrl = FakeControl()
        saved = [Path(n) for n in saved_names]
        rec = dict(REC)
        if subject is not None:
            rec["subject"] = subject   # regras que dependem do assunto (ex.: seguradora)

        def fake_run_extraction(pdf_path, pdf_passwords=None):
            return (pdf_path.name, None)  # csv_path = nome do arquivo

        def fake_read_rows(csv_path):
            return [rows_by_name[Path(csv_path).name]]

        with patch.object(read_emails, "run_extraction", fake_run_extraction), \
             patch.object(read_emails, "read_extracted_rows", fake_read_rows):
            _, saved_count, nonpayable_only, _att_account = read_emails.extract_and_store_accounts(
                saved, "<MID>", ctrl, email_rec=rec)
        return ctrl, saved_count, nonpayable_only


class ExtractAndStoreFaturaBoletoTest(_StoreRunnerMixin, unittest.TestCase):
    """Fluxo completo com run_extraction/read_extracted_rows mockados."""

    def test_fatura_mais_boleto_grava_so_boleto(self):
        rows = {
            "relatorio.pdf": _row("relatorio.pdf", RELATORIO),
            "boleto.pdf":    _row("boleto.pdf", BOLETO_REAL),
        }
        ctrl, saved, nonpayable = self._run(["relatorio.pdf", "boleto.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(len(ctrl.financial_calls), 1)
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)
        self.assertEqual(ctrl.error_calls, [])         # fatura ignorada, nao e erro
        self.assertFalse(nonpayable)                    # houve pagavel (o boleto)
        # O anexo e vinculado a conta (migration 079) — so o do boleto, que virou conta;
        # o relatorio foi ao Storage no passo 1, mas nao gerou conta a que se vincular.
        self.assertEqual(ctrl.attachment_calls, [(1, "boleto.pdf")])

    def test_ordem_inversa_boleto_primeiro(self):
        # Independencia de ordem: boleto vindo ANTES da fatura tambem grava so o boleto.
        rows = {
            "boleto.pdf":    _row("boleto.pdf", BOLETO_REAL),
            "relatorio.pdf": _row("relatorio.pdf", RELATORIO),
        }
        ctrl, saved, _ = self._run(["boleto.pdf", "relatorio.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)

    def test_fatura_sozinha_e_extraida(self):
        # Sem boleto no e-mail → a fatura vira conta a pagar (regra: fatura sem boleto).
        rows = {"fatura.pdf": _row("fatura.pdf", CHAVE_44, doc_type="fatura")}
        ctrl, saved, _ = self._run(["fatura.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(len(ctrl.financial_calls), 1)

    def test_dois_boletos_reais_gravam_ambos(self):
        # Carne / 2 boletos reais → nenhum e descartado (ambos tem linha digitavel).
        b2 = "23797150300020100800165090000000182600999999"
        rows = {
            "boleto1.pdf": _row("boleto1.pdf", BOLETO_REAL),
            "boleto2.pdf": _row("boleto2.pdf", b2),
        }
        ctrl, saved, _ = self._run(["boleto1.pdf", "boleto2.pdf"], rows)
        self.assertEqual(saved, 2)
        # Cada conta leva o SEU anexo (1:N por conta, nao um anexo para as duas).
        self.assertEqual(ctrl.attachment_calls, [(1, "boleto1.pdf"), (2, "boleto2.pdf")])

    def test_dois_boletos_valores_distintos_um_sem_barcode(self):
        # Caso LMED: 2 boletos ESCANEADOS, o Vision leu a linha digitavel de um so.
        # Valores DISTINTOS = dividas distintas → AMBOS viram conta; o sem barcode
        # NAO e descartado pela regra fatura+boleto (nao regredir — perda silenciosa).
        rows = {
            "b_2937.pdf": _row("b_2937.pdf", BOLETO_REAL, amount="2476.55"),
            "b_1748.pdf": _row("b_1748.pdf", None, amount="1166.67"),  # Vision nao leu o barcode
        }
        ctrl, saved, _ = self._run(["b_2937.pdf", "b_1748.pdf"], rows)
        self.assertEqual(saved, 2)
        amounts = sorted(float(c["amount"]) for c in ctrl.financial_calls)
        self.assertEqual(amounts, [1166.67, 2476.55])
        self.assertEqual(ctrl.error_calls, [])

    def test_fatura_sem_barcode_mesmo_valor_ainda_ignorada(self):
        # Preserva a regra fatura+boleto: linha SEM barcode com o MESMO valor de um
        # boleto real e a fatura do MESMO debito → ignorada (so o boleto vira conta).
        rows = {
            "boleto.pdf": _row("boleto.pdf", BOLETO_REAL, amount="500.00"),
            "fatura.pdf": _row("fatura.pdf", None, doc_type="fatura", amount="500.00"),
        }
        ctrl, saved, _ = self._run(["boleto.pdf", "fatura.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)
        # A fatura ignorada NAO gera vinculo de anexo (nao ha conta a que vincular).
        self.assertEqual(ctrl.attachment_calls, [(1, "boleto.pdf")])

    def test_extrato_valor_distinto_e_ignorado(self):
        # Caso Correios (id 605/606): extrato SINTETICO (sem barcode, valor BRUTO) +
        # boleto (linha digitavel, valor LIQUIDO). Valores DIFEREM, entao a guarda de
        # valor nao o pega — mas o extrato descreve o MESMO debito → so o boleto vira
        # conta. O sinal e o termo 'extrato' no nome/descricao, nao o valor.
        rows = {
            "Extrato_sintetico_07.pdf": _row(
                "Extrato_sintetico_07.pdf", None, amount="5295.58"),
            "Boleto_07_2026.pdf": _row(
                "Boleto_07_2026.pdf", BOLETO_REAL, amount="5158.34"),
        }
        ctrl, saved, _ = self._run(
            ["Extrato_sintetico_07.pdf", "Boleto_07_2026.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)
        self.assertEqual(float(ctrl.financial_calls[0]["amount"]), 5158.34)
        self.assertEqual(ctrl.error_calls, [])          # extrato ignorado, nao e erro
        self.assertEqual(ctrl.attachment_calls, [(1, "Boleto_07_2026.pdf")])

    def test_extrato_por_descricao_e_ignorado(self):
        # O sinal tambem vem da DESCRICAO (nome do arquivo generico).
        r_extrato = _row("anexo1.pdf", None, amount="999.99")
        r_extrato["description"] = "Extrato Sintetico de Fatura Correios."
        rows = {
            "anexo1.pdf": r_extrato,
            "boleto.pdf": _row("boleto.pdf", BOLETO_REAL, amount="500.00"),
        }
        ctrl, saved, _ = self._run(["anexo1.pdf", "boleto.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)

    def test_extrato_sem_boleto_e_extraido(self):
        # Sem boleto no e-mail, um extrato NAO e descartado (a regra so vale quando ha
        # boleto real acompanhando) — segue o fluxo normal e vira conta/erro conforme os
        # dados. Aqui, com valor, vira conta.
        rows = {"Extrato_sintetico.pdf": _row("Extrato_sintetico.pdf", None, amount="100.00")}
        ctrl, saved, _ = self._run(["Extrato_sintetico.pdf"], rows)
        self.assertEqual(saved, 1)

    def test_segundo_boleto_escaneado_nao_confundido_com_extrato(self):
        # Nao regredir LMED: um 2o boleto escaneado (sem barcode, valor distinto) cujo
        # nome/descricao NAO citam 'extrato' segue sendo mantido — _is_statement_document
        # so descarta o que e reconhecidamente um extrato/relatorio.
        rows = {
            "boleto_p1.pdf": _row("boleto_p1.pdf", BOLETO_REAL, amount="2476.55"),
            "boleto_p2.pdf": _row("boleto_p2.pdf", None, amount="1166.67"),
        }
        ctrl, saved, _ = self._run(["boleto_p1.pdf", "boleto_p2.pdf"], rows)
        self.assertEqual(saved, 2)

    def test_is_statement_document_helper(self):
        # Unitario do detector: casa termos de extrato/relatorio; nao casa boleto (com
        # barcode) nem substring acidental.
        self.assertTrue(read_emails._is_statement_document(
            {"source_file": "Extrato_sintetico_07.pdf", "barcode": None}))
        self.assertTrue(read_emails._is_statement_document(
            {"source_file": "x.pdf", "description": "Demonstrativo de servicos", "barcode": None}))
        self.assertTrue(read_emails._is_statement_document(
            {"source_file": "relatorio_consumo.pdf", "barcode": None}))
        # Boleto real (tem barcode) nunca e "extrato".
        self.assertFalse(read_emails._is_statement_document(
            {"source_file": "Extrato.pdf", "barcode": BOLETO_REAL}))
        # 'boleto'/'fatura' nao sao termos de extrato.
        self.assertFalse(read_emails._is_statement_document(
            {"source_file": "boleto_07.pdf", "barcode": None}))
        self.assertFalse(read_emails._is_statement_document(
            {"source_file": "fatura.pdf", "description": "Fatura mensal", "barcode": None}))

    def test_anexo_do_pipeline_herda_o_dono_da_conta(self):
        # Regressao: o call site usava payload.get("created_by"), que e SEMPRE None —
        # register_financial resolve o dono numa COPIA local do payload. O anexo caia no
        # sentinela, divergindo do backfill da 079 (que gravou o created_by real).
        rows = {"boleto.pdf": _row("boleto.pdf", BOLETO_REAL)}
        ctrl, saved, _ = self._run(["boleto.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(ctrl.attachment_owners, ["uuid-de-padariabelga@gmail.com"])

    def test_conta_nao_criada_nao_vincula_anexo(self):
        # Linha sem valor → nao vira conta (erro 'sem_valor') → nenhum anexo vinculado.
        # O arquivo ja foi ao Storage no passo 1; o VINCULO exige o id de uma conta.
        rows = {"lixo.pdf": _row("lixo.pdf", None, doc_type="outro", amount=None)}
        ctrl, saved, _ = self._run(["lixo.pdf"], rows)
        self.assertEqual(saved, 0)
        self.assertEqual(ctrl.attachment_calls, [])


class NfseComBoletoTest(_StoreRunnerMixin, unittest.TestCase):
    """Documento COMBINADO NFS-e + boleto no MESMO arquivo (caso real Amil id 1045/1046).

    O extrator ve o cabecalho fiscal e rotula 'nfse'/'nfe', mas a linha traz um BOLETO
    PAGAVEL (linha digitavel valida). O pagavel vence: re-rotula 'boleto' e NAO pula —
    antes a conta a pagar (R$ 7.217,91, Amil) era descartada e o e-mail virava 'ignorado'.
    Reusa o helper _run via _StoreRunnerMixin (sem re-rodar os testes do outro TestCase).
    """

    def test_nfse_com_boleto_pagavel_vira_conta(self):
        rows = {"amil.pdf": _row("amil.pdf", BOLETO_REAL, doc_type="nfse", amount="7217.91")}
        ctrl, saved, nonpayable = self._run(["amil.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertFalse(nonpayable)                       # NAO e nonpayable_only
        self.assertEqual(ctrl.error_calls, [])
        # A conta gravada foi re-rotulada 'boleto' (o pagavel), nao 'nfse'.
        self.assertEqual(ctrl.financial_calls[0]["document_type"], "boleto")
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)
        self.assertEqual(float(ctrl.financial_calls[0]["amount"]), 7217.91)
        self.assertEqual(ctrl.attachment_calls, [(1, "amil.pdf")])

    def test_nfe_com_boleto_pagavel_vira_conta(self):
        # Mesma regra para 'nfe' (o outro membro de SKIP_ACCOUNT_TYPES).
        rows = {"nf.pdf": _row("nf.pdf", BOLETO_REAL, doc_type="nfe", amount="1000.00")}
        ctrl, saved, nonpayable = self._run(["nf.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertFalse(nonpayable)
        self.assertEqual(ctrl.financial_calls[0]["document_type"], "boleto")

    def test_nfse_pura_sem_barcode_segue_ignorada(self):
        # NF-e/NFS-e PURA (sem linha digitavel) NAO gera conta — nao regredir o skip
        # original (SKIP_ACCOUNT_TYPES). CHAVE_44 e chave de acesso, nao boleto.
        rows = {"nfse.pdf": _row("nfse.pdf", CHAVE_44, doc_type="nfse", amount="500.00")}
        ctrl, saved, nonpayable = self._run(["nfse.pdf"], rows)
        self.assertEqual(saved, 0)
        self.assertEqual(len(ctrl.financial_calls), 0)
        self.assertTrue(nonpayable)                        # so nao-pagavel → 'ignorado'
        self.assertEqual(ctrl.error_calls, [])             # skip, nao erro

    def test_nfse_com_boleto_mais_fatura_mesmo_valor_grava_so_o_boleto(self):
        # O documento combinado (NFS-e+boleto) convive com a regra fatura+boleto: uma
        # fatura SEPARADA de mesmo valor e descartada; so a conta do boleto sobrevive.
        rows = {
            "amil_nfse.pdf": _row("amil_nfse.pdf", BOLETO_REAL, doc_type="nfse", amount="800.00"),
            "fatura.pdf":    _row("fatura.pdf", None, doc_type="fatura", amount="800.00"),
        }
        ctrl, saved, _ = self._run(["amil_nfse.pdf", "fatura.pdf"], rows)
        self.assertEqual(saved, 1)
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)
        self.assertEqual(ctrl.financial_calls[0]["document_type"], "boleto")


class SeguradoraBoletoGateTest(_StoreRunnerMixin, unittest.TestCase):
    """E-mail de SEGURADORA: so o boleto com linha digitavel valida vira conta.

    Caso real (email_control 1082, "SEGUROS SURA VID_G_002_930_2011924_15"): o kit
    digital traz DOIS documentos por link — boleto e "conjunto faturamento". Sem a regra,
    a fatura viraria uma SEGUNDA conta: ela tem valor DIFERENTE do boleto (premio total x
    parcela), entao escapa da guarda de valor da regra fatura+boleto, e o nome do arquivo
    gerado pelo download por link (`..._link.pdf`) nao casa _is_statement_document.
    """

    SUBJECT = "SEGUROS SURA VID_G_002_930_2011924_15"

    def test_boleto_grava_e_fatura_de_outro_valor_e_descartada(self):
        rows = {
            "boleto_link.pdf": _row("boleto_link.pdf", BOLETO_REAL, amount="133.94"),
            "fatura_link.pdf": _row("fatura_link.pdf", None, doc_type="fatura",
                                    amount="1607.28"),   # premio total ≠ parcela
        }
        ctrl, saved, nonpayable = self._run(
            ["boleto_link.pdf", "fatura_link.pdf"], rows, subject=self.SUBJECT)
        self.assertEqual(saved, 1)
        self.assertEqual(ctrl.financial_calls[0]["barcode"], BOLETO_REAL)
        self.assertEqual(float(ctrl.financial_calls[0]["amount"]), 133.94)
        self.assertEqual(ctrl.financial_calls[0]["document_type"], "seguro")
        self.assertFalse(nonpayable)            # houve pagavel → 'extraído'
        self.assertEqual(ctrl.error_calls, [])  # descarte e skip, nao erro em /erros

    def test_seguradora_sem_boleto_valido_nao_gera_conta(self):
        # Nenhum documento com linha digitavel → e-mail inteiro 'ignorado' (nao 'falha').
        rows = {"apolice.pdf": _row("apolice.pdf", None, doc_type="outro", amount="900.00")}
        ctrl, saved, nonpayable = self._run(["apolice.pdf"], rows, subject=self.SUBJECT)
        self.assertEqual(saved, 0)
        self.assertEqual(len(ctrl.financial_calls), 0)
        self.assertTrue(nonpayable)             # → status_for_result devolve 'ignorado'
        self.assertEqual(ctrl.error_calls, [])  # nao aparece em /erros

    def test_assunto_sem_seguro_mantem_comportamento_atual(self):
        # Anti-regressao: o MESMO par de PDFs com assunto nao-seguradora segue a regra
        # geral (valores distintos = dividas distintas → duas contas, caso LMED).
        rows = {
            "b1.pdf": _row("b1.pdf", BOLETO_REAL, amount="133.94"),
            "b2.pdf": _row("b2.pdf", None, amount="1607.28"),
        }
        ctrl, saved, nonpayable = self._run(
            ["b1.pdf", "b2.pdf"], rows, subject="Rastreador - Demonstrativo fatura - 07/2026")
        self.assertEqual(saved, 2)
        self.assertFalse(nonpayable)


if __name__ == "__main__":
    unittest.main()
