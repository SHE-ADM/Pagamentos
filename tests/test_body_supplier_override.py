"""
Testes da guarda FORNECEDOR-CORPO (fornecedor rotulado no corpo vence o nome lido do
ANEXO quando o anexo nao traz identificador forte):

  - O nome que o Vision/LLM le de um pedido/recibo e so "alguma razao social impressa
    na pagina" — num PEDIDO, tipicamente a TRANSPORTADORA. Quando o CORPO nomeia o
    fornecedor com CNPJ/CPF ao lado, esse par vence.
  - A condicao e o coracao da regra: com CNPJ/CPF PROPRIOS, o ANEXO manda (boleto e
    nota sempre os trazem, entao nada regride).

Caso de origem: conta 822 ("Pagamento Bordados") — o anexo era a foto de um pedido e o
Vision gravou "TRANSFER EXPRESS" (a transportadora), enquanto o corpo trazia
"Razao Social: I S da Silva Camisetas e Malharia" + "CNPJ: 44.427.588/0001-30".

Cobre o helper puro _body_supplier_identity e o override dentro de
extract_and_store_accounts (com run_extraction/read_extracted_rows mockados).
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

OTIMOTEX_CNPJ = "47273917000123"   # empresa pagadora — nunca e o fornecedor
BORDADOS_CNPJ = "44427588000130"   # fornecedor correto da conta 822 (sk 1193)
BORDADOS_NOME = "I S da Silva Camisetas e Malharia"

# Corpo real do e-mail da conta 822 (bruna@lebianco.com.br, "Pagamento Bordados").
BODY_822 = (
    "Bom dia.\r\n\r\n \r\n\r\n"
    "Estamos enviando mais uma remessa de aventais da Le Bianco para bordar.\r\n"
    "Precisamos fazer o pagamento do sinal para dar andamento ao pedido:\r\n\r\n \r\n\r\n"
    "Razao Social: I S da Silva Camisetas e Malharia\r\n\r\n"
    "CNPJ: 44.427.588/0001-30\r\n\r\n \r\n\r\n"
    "1o pagamento\r\n\r\nData: 03/08/2026\r\n\r\nValor: R$ 2.437,20 \r\n\r\n \r\n\r\n"
    "Banco: Stone\r\n\r\nChave PIX: pagueprint@gmail.com\r\n"
)

# Corpo dos boletos que o despachante repassa (contas 423-428, "Dr. Ricardo"): o CNPJ
# do CLIENTE aparece SOLTO, sem rotulo de fornecedor. Disparar aqui trocaria o
# fornecedor correto (o despachante) pelo de um terceiro — regressao que a guarda
# "exige nome ROTULADO + identificador" impede.
BODY_CNPJ_SOLTO = (
    "Segue boleto para pagamento.\r\n"
    "CNPJ 04.622.733/0001-19\r\n"
    "Obrigada\r\n"
)


class BodySupplierIdentityHelperTest(unittest.TestCase):
    def test_extrai_nome_e_cnpj_rotulados(self):
        self.assertEqual(
            read_emails._body_supplier_identity(BODY_822, OTIMOTEX_CNPJ),
            (BORDADOS_NOME, BORDADOS_CNPJ, None),
        )

    def test_cnpj_solto_sem_rotulo_nao_dispara(self):
        # Guarda 1 — a que protege as contas do "Dr. Ricardo".
        self.assertEqual(
            read_emails._body_supplier_identity(BODY_CNPJ_SOLTO, OTIMOTEX_CNPJ),
            (None, None, None),
        )

    def test_nome_rotulado_sem_identificador_nao_dispara(self):
        # Nome sozinho e exatamente o sinal fraco que a regra existe para nao seguir.
        body = "Fornecedor: ACME Comercio Ltda\r\nSegue o pedido em anexo.\r\n"
        self.assertEqual(
            read_emails._body_supplier_identity(body, OTIMOTEX_CNPJ),
            (None, None, None),
        )

    def test_identificador_distante_do_rotulo_nao_conta(self):
        # Guarda 2 — CNPJ de rodape/terceiro, fora da janela, nao pertence ao rotulo.
        body = ("Fornecedor: ACME Comercio Ltda\r\n"
                + ("linha de texto irrelevante.\r\n" * 20)
                + "CNPJ: 44.427.588/0001-30\r\n")
        self.assertEqual(
            read_emails._body_supplier_identity(body, OTIMOTEX_CNPJ),
            (None, None, None),
        )

    def test_cnpj_da_propria_empresa_e_descartado(self):
        # Guarda 3 — bloco do destinatario. Compara pela RAIZ (filial diferente tambem cai).
        body = "Razao Social: TEXTIL E CONFECCOES OTIMOTEX LTDA\r\nCNPJ: 47.273.917/0003-95\r\n"
        self.assertEqual(
            read_emails._body_supplier_identity(body, OTIMOTEX_CNPJ),
            (None, None, None),
        )

    def test_nome_que_e_tipo_de_documento_e_descartado(self):
        # Guarda 4 — "BOLETO"/"PIX" nao sao fornecedor (mesma regra de _finalize_supplier).
        body = "Fornecedor: BOLETO\r\nCNPJ: 44.427.588/0001-30\r\n"
        self.assertEqual(
            read_emails._body_supplier_identity(body, OTIMOTEX_CNPJ),
            (None, None, None),
        )

    def test_cpf_rotulado_tambem_vale(self):
        body = "Favorecido: Joao da Silva\r\nCPF: 123.456.789-09\r\n"
        name, cnpj, cpf = read_emails._body_supplier_identity(body, OTIMOTEX_CNPJ)
        self.assertEqual(name, "Joao da Silva")
        self.assertIsNone(cnpj)
        self.assertEqual(cpf, "12345678909")

    def test_corpo_vazio_degrada(self):
        self.assertEqual(
            read_emails._body_supplier_identity("", OTIMOTEX_CNPJ),
            (None, None, None),
        )
        self.assertEqual(
            read_emails._body_supplier_identity(None, OTIMOTEX_CNPJ),
            (None, None, None),
        )


class PayloadHasStrongSupplierIdTest(unittest.TestCase):
    def test_cnpj_ou_cpf_contam(self):
        self.assertTrue(read_emails._payload_has_strong_supplier_id({"supplier_cnpj": "1" * 14}))
        self.assertTrue(read_emails._payload_has_strong_supplier_id({"supplier_cpf": "1" * 11}))

    def test_nome_sozinho_nao_conta(self):
        # O ponto da funcao: nome NAO e identificador forte.
        self.assertFalse(read_emails._payload_has_strong_supplier_id(
            {"supplier_name": "TRANSFER EXPRESS"}))

    def test_vazio_e_branco_nao_contam(self):
        self.assertFalse(read_emails._payload_has_strong_supplier_id({}))
        self.assertFalse(read_emails._payload_has_strong_supplier_id({"supplier_cnpj": "   "}))
        self.assertFalse(read_emails._payload_has_strong_supplier_id({"supplier_cnpj": None}))


class FakeControl:
    """Stub de SupabaseControl — captura o payload no momento da resolucao."""

    def __init__(self):
        self.financial_calls = []
        self.error_calls = []
        self.resolved_with = []   # (nome, cnpj, cpf) vistos por resolve_supplier

    def upload_attachment(self, pdf_path):
        return True

    def company_cnpj(self):
        return OTIMOTEX_CNPJ

    def resolve_supplier(self, payload):
        # _finalize_supplier remove supplier_name/cnpj/cpf DEPOIS desta chamada.
        self.resolved_with.append((payload.get("supplier_name"),
                                   payload.get("supplier_cnpj"),
                                   payload.get("supplier_cpf")))
        return 1193

    def supplier_defaults(self, sk_supplier):
        return (0, 0)

    def register_financial(self, payload):
        self.financial_calls.append(payload)
        return len(self.financial_calls)

    def register_attachment(self, account_id, file_name, size_bytes=0, uploaded_by=None):
        return True

    def resolve_user(self, sender_email):
        return f"uuid-de-{sender_email}" if sender_email else None

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

    def unique_invoice_number(self, base):
        return base

    def find_financial_duplicate(self, payload):
        return None

    def update_financial(self, *args, **kwargs):
        return True


def _pedido_row(**over):
    """Linha extraida da IMAGEM do pedido (conta 822): o Vision leu a transportadora
    impressa na pagina como se fosse o fornecedor, e SEM CNPJ."""
    row = {
        "source_file": "bruna_Pagamento_Bordados_20260803_Pedido.jpeg",
        "document_type": "recibo",
        "barcode": None,
        "amount": "4874.40",
        "supplier_name": "TRANSFER EXPRESS",
        "invoice_number": "115025",
        "due_date": "2026-08-03",
        "extraction_source": "image_vision",
    }
    row.update(over)
    return row


def _rec():
    return {
        "received_at": "2026-08-03T13:00:00+00:00",
        "subject": "Pagamento Bordados",
        "sender_email": "bruna@lebianco.com.br",
    }


class ExtractAndStoreBodySupplierOverrideTest(unittest.TestCase):
    def _run(self, row, body_text):
        ctrl = FakeControl()

        def fake_run_extraction(pdf_path, pdf_passwords=None):
            return (pdf_path.name, None)

        def fake_read_rows(csv_path):
            return [row]

        with patch.object(read_emails, "run_extraction", fake_run_extraction), \
             patch.object(read_emails, "read_extracted_rows", fake_read_rows), \
             patch.object(read_emails, "apply_forced_classification", lambda *a, **k: None):
            read_emails.extract_and_store_accounts(
                [Path("Pedido.jpeg")], "<MID>", ctrl,
                email_rec=dict(_rec()), body_text=body_text)
        return ctrl

    def test_override_grava_conta_sob_o_fornecedor_do_corpo(self):
        ctrl = self._run(_pedido_row(), BODY_822)
        self.assertEqual(len(ctrl.financial_calls), 1)
        self.assertEqual(ctrl.error_calls, [])
        name, cnpj, _cpf = ctrl.resolved_with[-1]
        self.assertEqual(name, BORDADOS_NOME)
        self.assertEqual(cnpj, BORDADOS_CNPJ)

    def test_anexo_com_cnpj_proprio_manda(self):
        # NAO REGREDIR: boleto/nota trazem CNPJ — o anexo e a fonte e o corpo nao o sobrepoe.
        ctrl = self._run(_pedido_row(supplier_cnpj="07241838000205"), BODY_822)
        name, cnpj, _cpf = ctrl.resolved_with[-1]
        self.assertEqual(name, "TRANSFER EXPRESS")
        self.assertEqual(cnpj, "07241838000205")

    def test_anexo_com_cpf_proprio_manda(self):
        ctrl = self._run(_pedido_row(supplier_cpf="12345678909"), BODY_822)
        name, _cnpj, cpf = ctrl.resolved_with[-1]
        self.assertEqual(name, "TRANSFER EXPRESS")
        self.assertEqual(cpf, "12345678909")

    def test_sem_corpo_mantem_fornecedor_extraido(self):
        ctrl = self._run(_pedido_row(), "")
        name, cnpj, _cpf = ctrl.resolved_with[-1]
        self.assertEqual(name, "TRANSFER EXPRESS")
        self.assertIsNone(cnpj)

    def test_corpo_com_cnpj_solto_mantem_fornecedor_extraido(self):
        # O caso "Dr. Ricardo" ponta a ponta: sem rotulo, nada e sobreposto.
        ctrl = self._run(_pedido_row(), BODY_CNPJ_SOLTO)
        name, cnpj, _cpf = ctrl.resolved_with[-1]
        self.assertEqual(name, "TRANSFER EXPRESS")
        self.assertIsNone(cnpj)

    def test_cedente_ssw_tem_precedencia(self):
        # ACHADO DA AUTORREVISAO: quando o unico CNPJ do corpo SSW e o da PROPRIA empresa,
        # _ssw_cedente_from_body devolve o cedente so com NOME — a linha fica sem
        # identificador forte e este override sobreporia o cedente recem-gravado.
        # O CEDENTE do boleto e o credor autoritativo da fatura; nada no corpo o supera.
        boleto = "23792152400000502400289090000010602503122940"   # linha digitavel real
        corpo_ssw = (
            "Fatura\r\n"
            "Segue fatura no 0324348 referente aos servicos de transporte realizados "
            "por Campinense Transporte De Carga.\r\n"
            # Par rotulado do DESTINATARIO — tentaria virar fornecedor sem a precedencia.
            "Razao Social: I S da Silva Camisetas e Malharia\r\n"
            "CNPJ: 44.427.588/0001-30\r\n"
        )
        ctrl = FakeControl()

        def fake_run_extraction(pdf_path, pdf_passwords=None):
            return (pdf_path.name, None)

        def fake_read_rows(csv_path):
            return [_pedido_row(document_type="boleto", barcode=boleto,
                                extraction_source="pdf_text")]

        rec = dict(_rec(), sender_email="no-reply@sswsistemas.com.br")
        with patch.object(read_emails, "run_extraction", fake_run_extraction), \
             patch.object(read_emails, "read_extracted_rows", fake_read_rows), \
             patch.object(read_emails, "apply_forced_classification", lambda *a, **k: None), \
             patch.object(read_emails, "_ssw_cedente_from_body",
                          lambda *a, **k: ("Campinense Transporte De Carga", None)):
            read_emails.extract_and_store_accounts(
                [Path("fatura_ssw.pdf")], "<MID>", ctrl, email_rec=rec, body_text=corpo_ssw)

        name, cnpj, _cpf = ctrl.resolved_with[-1]
        self.assertEqual(name, "Campinense Transporte De Carga")
        self.assertIsNone(cnpj)

    def test_override_nao_deixa_cpf_orfao(self):
        # Quando o corpo da CNPJ e o anexo trazia um CPF errado, o CPF sai do payload —
        # senao a RPC casaria por CNPJ e gravaria um CPF alheio no cadastro.
        # (supplier_cpf vazio no anexo: nao conta como identificador forte.)
        ctrl = self._run(_pedido_row(supplier_cpf="  "), BODY_822)
        name, cnpj, cpf = ctrl.resolved_with[-1]
        self.assertEqual(name, BORDADOS_NOME)
        self.assertEqual(cnpj, BORDADOS_CNPJ)
        self.assertIsNone(cpf)


if __name__ == "__main__":
    unittest.main()
