"""
CPF de CHAVE PIX no corpo NAO identifica o fornecedor quando ha nome rotulado ou CNPJ.

Caso de origem (06/11/2026, e-mails 3390-3392 de estela@lebianco.com.br): tres pedidos de
pagamento a fornecedores DISTINTOS (RDR DISTRIBUIDORA, TURBO DRIVE, ELG SERVICOS MECANICOS),
todos com "Pix CPF: 28046637874" — o MECANICO que comprou as pecas. O CPF foi gravado como
CPF do cadastro criado para a RDR (sk 1497); o passo de CPF da RPC, que roda logo apos o CNPJ
nao casado e ANTES do nome, puxou as outras duas contas para ele, e a TURBO DRIVE (mesmo valor
e vencimento) virou `duplicidade` da RDR — a NF 57 sumiu em silencio.

Sem nome nem CNPJ a chave PIX segue sendo a unica identidade e vale (e-mails da Liftec).
Com nome, ela so volta a identificar quando o CADASTRO confirma que o CPF ja e daquele
fornecedor (conta 1677, advogado pago na propria chave) — _confirmed_pix_key_cpf.
"""

import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

PIX_CPF = "28046637874"


def _body(fornecedor: str, cnpj: "str | None", nf: str, valor: str) -> str:
    """Corpo real dos e-mails 3390-3392 (CRLF como chega do IMAP)."""
    cnpj_line = f"CNPJ: {cnpj}\r\n" if cnpj else ""
    return (
        "Bom dia!\r\n\r\n"
        f"Por gentileza fazer o pagamento da NF {nf} em anexo.\r\n\r\n"
        "Obs.: O mecânico comprou as peças e já fez o pagamento, por isso o pix vai ser "
        "para o mecânico.\r\n\r\n"
        f"Fornecedor: {fornecedor}\r\n"
        f"{cnpj_line}\r\n"
        "VENCIMENTO: 06/11/2026\r\n\r\n\r\n"
        f"VALOR: R$ {valor}\r\n\r\n"
        f"Pix CPF: {PIX_CPF} \r\n"
        "Emerson Luiz Guadanhin\r\n"
        "Banco Itaú\r\n\r\nGrata."
    )


RDR   = _body("RDR DISTRIBUIDORA", "42.479.330/0001-51", "2752", "1.590,00")
TURBO = _body("TURBO DRIVE", "46.082.808/0001-66", "57", "1.590,00")
ELG   = _body("ELG SERVIÇOS MECÂNICOS", None, "", "3.630,00")


class TestIsPixKeyCpf(unittest.TestCase):
    def _match(self, text):
        m = R._BODY_CPF_RE.search(text)
        self.assertIsNotNone(m, "sanidade do parser: o regex de CPF parou de casar")
        return m

    def test_formas_de_chave_pix(self):
        for text in ("Pix CPF: 280.466.378-74", "chave Pix CPF: 28046637874",
                     "PIX (CPF): 318.169.878-40", "PIX CPF 298.479.198-36"):
            with self.subTest(text=text):
                self.assertTrue(R._is_pix_key_cpf(text, self._match(text)))

    def test_cpf_rotulado_sem_pix_nao_e_chave(self):
        for text in ("CPF: 373.807.368-09", "Pagamento via pix.\nCPF: 373.807.368-09"):
            with self.subTest(text=text):
                self.assertFalse(R._is_pix_key_cpf(text, self._match(text)))


class TestResolveSupplierIdentityPix(unittest.TestCase):
    def test_cnpj_e_nome_descartam_o_cpf_do_pix(self):
        self.assertEqual(R._resolve_body_supplier_identity(RDR),
                         ("RDR DISTRIBUIDORA", "42479330000151", None))

    def test_so_nome_tambem_descarta(self):
        self.assertEqual(R._resolve_body_supplier_identity(ELG),
                         ("ELG SERVIÇOS MECÂNICOS", None, None))

    def test_chave_pix_sem_nome_nem_cnpj_continua_identificando(self):
        _, _, cpf = R._resolve_body_supplier_identity("Valor R$ 2.675,00\nPIX CPF 298.479.198-36\n")
        self.assertEqual(cpf, "29847919836")

    def test_cpf_rotulado_sem_pix_continua_valendo(self):
        _, _, cpf = R._resolve_body_supplier_identity(
            "Fornecedor: JOAO DA SILVA\nCPF: 373.807.368-09\n")
        self.assertEqual(cpf, "37380736809")

    def test_janela_do_anexo_herda_o_nome_rotulado(self):
        # Caminho do ANEXO: a janela comeca DEPOIS do rotulo, entao o nome vem por parametro.
        _, cnpj, cpf = R._resolve_body_supplier_identity(
            f"\r\nPix CPF: {PIX_CPF}\r\n", labeled_name="ELG")
        self.assertEqual((cnpj, cpf), (None, None))

    def test_body_supplier_identity_do_anexo_nao_usa_o_pix(self):
        self.assertEqual(R._body_supplier_identity(ELG, own_cnpj=None), (None, None, None))
        name, cnpj, cpf = R._body_supplier_identity(TURBO, own_cnpj=None)
        self.assertEqual((name, cnpj, cpf), ("TURBO DRIVE", "46082808000166", None))


class TestExtractFromEmailBodyPix(unittest.TestCase):
    """Executa a funcao de TOPO: o call site e o payload que vai a RPC."""

    def _payload(self, body, msg_id):
        p = R.extract_from_email_body(body, "2026-11-06T12:25:06+00:00", msg_id,
                                      sender_email="estela@lebianco.com.br",
                                      subject="LE BIANCO - PAGAMENTO FORNECEDOR")
        self.assertIsNotNone(p)
        return p

    def test_os_tres_emails_nao_levam_o_cpf_do_mecanico_a_rpc(self):
        for body, msg, name, cnpj in ((RDR, "<a@x>", "RDR DISTRIBUIDORA", "42479330000151"),
                                      (TURBO, "<b@x>", "TURBO DRIVE", "46082808000166"),
                                      (ELG, "<c@x>", "ELG SERVIÇOS MECÂNICOS", None)):
            with self.subTest(name=name):
                p = self._payload(body, msg)
                self.assertIsNone(p["supplier_cpf"])
                self.assertEqual(p["supplier_name"], name)
                self.assertEqual(p["supplier_cnpj"], cnpj)


# ── Chave PIX do PROPRIO fornecedor pessoa fisica (review max 2026-11-10) ─────────────────
# Corpo REAL do e-mail 2385 (conta 1677): o CPF da chave e o do cadastro sk 1432 do advogado.
CORPO_1677 = ("NOME: DR.FLAVIO PRADO (ADVOGADO)\r\n\r\nVALOR: R$2.675,00\r\n\r\n"
              "PIX CPF 298.479.198-36\r\n\r\n \r\n\r\nREFERENTE CHEQUE DEVOLVIDO")
CPF_1677 = "29847919836"
CADASTRO_1432 = {"sk_supplier": 1432, "legal_name": "DR.FLAVIO PRADO (ADVOGADO)",
                 "trade_name": "DR.FLAVIO PRADO (ADVOGADO)", "deleted_at": None}


class _Ctrl:
    """Fake minimo para _finalize_supplier: grava o payload que chegou a RPC."""

    def __init__(self, by_cpf=None):
        self.by_cpf = by_cpf or {}
        self.cpf_lookups, self.rpc_payloads = [], []

    def find_supplier_by_cpf(self, cpf):
        self.cpf_lookups.append(cpf)
        return self.by_cpf.get(cpf, [])

    def find_supplier_by_email(self, email):
        return None

    def resolve_supplier(self, payload):
        self.rpc_payloads.append(dict(payload))
        return 9999

    def supplier_defaults(self, sk):
        return (0, 0)

    def company_cnpj(self):
        return "47273917000123"


class TestPixKeyOwnSupplier(unittest.TestCase):
    def test_corpo_real_da_1677_a_funcao_pura_descarta(self):
        # Sanidade da premissa: sem o cadastro, a chave com nome rotulado nao identifica.
        self.assertEqual(R._resolve_body_supplier_identity(CORPO_1677),
                         ("DR.FLAVIO PRADO (ADVOGADO)", None, None))
        self.assertEqual(R._body_pix_key_cpf(CORPO_1677), CPF_1677)

    def _finalize(self, name, ctrl, body=CORPO_1677):
        payload = {"supplier_name": name, "document_type": "pix",
                   "sender_email": "ester@otimotex.com.br",
                   "subject": "PAGAMENTO PIX DR.FLAVIO PRADO (ADVOGADO)"}
        self.assertTrue(R._finalize_supplier(ctrl, payload, body))
        self.assertEqual(len(ctrl.rpc_payloads), 1, "sanidade: a RPC precisa ter sido chamada")
        return ctrl.rpc_payloads[0]

    def test_cpf_do_proprio_cadastro_volta_mesmo_com_grafia_nova(self):
        ctrl = _Ctrl({CPF_1677: [CADASTRO_1432]})
        sent = self._finalize("DR. FLAVIO PRADO", ctrl)
        self.assertEqual(sent.get("supplier_cpf"), CPF_1677)

    def test_cpf_de_outro_cadastro_nao_volta(self):
        # O mecanico: CPF no cadastro da RDR, pedido para a ELG.
        ctrl = _Ctrl({PIX_CPF: [{"sk_supplier": 1497, "legal_name": "RDR DISTRIBUIDORA",
                                 "trade_name": None, "deleted_at": None}]})
        sent = self._finalize("ELG SERVIÇOS MECÂNICOS", ctrl, ELG)
        self.assertEqual(ctrl.cpf_lookups, [PIX_CPF], "sanidade: o cadastro foi consultado")
        self.assertIsNone(sent.get("supplier_cpf"))

    def test_cpf_sem_cadastro_nao_volta(self):
        # Fornecedor novo: o CPF nao pode chegar ao auto-insert, que o gravaria no cadastro.
        sent = self._finalize("ELG SERVIÇOS MECÂNICOS", _Ctrl(), ELG)
        self.assertIsNone(sent.get("supplier_cpf"))

    def test_cadastro_removido_ambiguo_ou_falha_nao_volta(self):
        removido = dict(CADASTRO_1432, deleted_at="2026-11-01T00:00:00+00:00")
        for rows in ([removido], [CADASTRO_1432, dict(CADASTRO_1432, sk_supplier=7)], None):
            with self.subTest(rows=rows):
                ctrl = _Ctrl()
                ctrl.by_cpf = {CPF_1677: rows}
                self.assertIsNone(self._finalize("DR. FLAVIO PRADO", ctrl).get("supplier_cpf"))

    def test_guia_de_tributo_nao_consulta(self):
        ctrl = _Ctrl({CPF_1677: [CADASTRO_1432]})
        payload = {"supplier_name": "DR. FLAVIO PRADO", "document_type": "darf"}
        R._finalize_supplier(ctrl, payload, CORPO_1677)
        self.assertEqual(ctrl.cpf_lookups, [])


class TestSupplierNamesMatch(unittest.TestCase):
    def test_casos(self):
        for a, b, esperado in (
                ("DR. FLAVIO PRADO", "DR.FLAVIO PRADO (ADVOGADO)", True),
                ("Flávio Prado", "FLAVIO PRADO", True),
                ("JACACAR (MONOCAR)", "JACACAR (MONOCAR)", True),
                ("JACACAR", "JACACAR (MONOCAR)", False),     # 1 palavra nao prova nada
                ("ELG SERVIÇOS MECÂNICOS", "RDR DISTRIBUIDORA", False),
                ("MECANICA SILVA LTDA", "MECANICA SOUZA LTDA", False),
                (None, "X", False)):
            with self.subTest(a=a, b=b):
                self.assertEqual(R._supplier_names_match(a, b), esperado)


class TestPixKeyFormsAndOrder(unittest.TestCase):
    def test_marca_pix_depois_do_numero(self):
        for text in ("CPF 021.797.821-52 (PIX)", "CPF: 02179782152 - chave pix"):
            with self.subTest(text=text):
                m = R._BODY_CPF_RE.search(text)
                self.assertTrue(R._is_pix_key_cpf(text, m))

    def test_rotulo_de_outra_chave_na_mesma_linha_nao_marca(self):
        text = "CPF: 373.807.368-09   PIX: financeiro@x.com.br"
        self.assertFalse(R._is_pix_key_cpf(text, R._BODY_CPF_RE.search(text)))

    def test_cpf_de_identidade_depois_da_chave_pix_vale(self):
        body = f"Fornecedor: JOAO DA SILVA\nPix CPF: {PIX_CPF}\nCPF: 373.807.368-09\n"
        self.assertEqual(R._resolve_body_supplier_identity(body),
                         ("JOAO DA SILVA", None, "37380736809"))

    def test_sem_nome_a_chave_provisoria_perde_para_o_cpf_de_identidade(self):
        body = f"Pix CPF: {PIX_CPF}\nCPF: 373.807.368-09\n"
        self.assertEqual(R._resolve_body_supplier_identity(body), (None, None, "37380736809"))


class TestFindSupplierByCpf(unittest.TestCase):
    def setUp(self):
        self.ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        self.ctrl._available, self.ctrl.base, self.ctrl.headers = True, "https://x.co", {}

    def test_consulta_pura_sem_filtro_de_removido(self):
        urls = []

        def fake(req, timeout=None):
            urls.append((req.full_url, req.get_method(), timeout))
            return io.BytesIO(json.dumps([CADASTRO_1432]).encode())
        with mock.patch.object(R.urllib.request, "urlopen", side_effect=fake):
            self.assertEqual(self.ctrl.find_supplier_by_cpf("298.479.198-36"), [CADASTRO_1432])
        url, method, timeout = urls[0]
        self.assertEqual(method, "GET")
        self.assertIsNotNone(timeout)
        self.assertIn("cpf=eq.29847919836", url)
        self.assertNotIn("deleted_at=is.null", url, "a RPC ve os removidos; a consulta tambem")

    def test_falha_de_rede_tenta_de_novo_e_devolve_none(self):
        err = R.urllib.error.URLError("timeout")
        with mock.patch.object(R.urllib.request, "urlopen", side_effect=[err, err]) as m, \
                mock.patch.object(R.time, "sleep"), self.assertLogs(R.log, level="WARNING"):
            self.assertIsNone(self.ctrl.find_supplier_by_cpf(CPF_1677))
        self.assertEqual(m.call_count, 2)

    def test_cpf_invalido_nao_consulta(self):
        with mock.patch.object(R.urllib.request, "urlopen") as m:
            self.assertIsNone(self.ctrl.find_supplier_by_cpf("123"))
        m.assert_not_called()


if __name__ == "__main__":
    unittest.main()
