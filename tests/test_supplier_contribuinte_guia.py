"""Guia de tributo: o CONTRIBUINTE (a própria pagadora) nunca vira fornecedor — e o FAVORECIDO
REAL, quando lido junto do CNPJ do contribuinte, vence (`_finalize_supplier`).

Caso real (13 guias — GNRE 782/785/786/1389/1390/1393/1394/1395/1429/1432/1438/1480 e DARF
1388; dados corrigidos na migration 140): a guia só imprime uma razão social além do Fisco, a do
contribuinte "TEXTIL E CONFECCOES OTIMOTEX LTDA" (47.273.917/0001-23). A extração devolvia esse
bloco como fornecedor. O pipeline descartava o CNPJ pela raiz da pagadora, mas mantinha o NOME,
que casava por texto um cadastro-apelido: o sk 4 (legal_name igual à da pagadora até a 136), o
sk 1400 — criado pelo auto-insert com a GRAFIA DA GUIA, "TEXTIL E CONFECES OTIMOTEX LTDA" — e o
sk 1415. A 1ª correção descartava o nome junto com o CNPJ SEMPRE; quando a leitura junta o CNPJ
do contribuinte com o nome de um favorecido real, isso apagava o favorecido (decisão do usuário
em 2026-09-15: o favorecido real vence).

Propriedades travadas:

🔴 1. Em guia de tributo, CNPJ extraído com a raiz de QUALQUER pagadora SAI SEMPRE — mantido,
      casaria a OTIMOTEX no passo de CNPJ da RPC, antes do nome.
🔴 2. O nome sai só se for o CONTRIBUINTE (`_is_contribuinte_name`: razão social exata, token de
      marca, repetição do pagador ou similaridade ≥ limiar). Senão é FAVORECIDO REAL e VENCE.
🔴 3. Os sinais de marca e de similaridade são COMPLEMENTARES — cada um pega um caso que o
      outro não pega (travado com números, não por afirmação).
🔴 4. A marca sai dos DADOS (`company`: palavra na razão social E no fantasia da mesma empresa),
      da mesma leitura que CNPJ e razão social.
🔴 5. NÃO regredir: fora de guia o CNPJ da LE BLANC é de fornecedor legítimo; favorecido com CNPJ
      próprio é preservado; CNPJ incompleto não dispara; ctrl legado degrada.
🔴 6. Call site EXECUTADO (`extract_and_store_accounts`) nos dois sentidos: guia 1389
      (contribuinte → OTIMOTEX, sem write-back) e guia com favorecido real (→ favorecido).
"""

import json
import sys
import unittest
from difflib import SequenceMatcher
from pathlib import Path
from unittest import mock
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R

CNPJ_TECIDOS = "47273917000123"
CNPJ_LEBIANCO = "47273917000223"
CNPJ_LE_BLANC = "20584679000110"
LE_BLANC = "LE BLANC ADMINISTRACAO DE BENS PROPRIOS LTDA"
GRAFIA_DA_GUIA = "TEXTIL E CONFECES OTIMOTEX LTDA"   # como a GNRE 1389 imprime
SEFAZ_MG = "SECRETARIA DA FAZENDA DO ESTADO DE MINAS GERAIS"
SK_APELIDO = 1400
SK_LE_BLANC_FORNECEDOR = 999
SK_OUTRO_FORNECEDOR = 12345

# Espelho da tabela `company` de produção (2026-09-15).
COMPANY_ROWS = [
    {"sk_company": 1, "cnpj": CNPJ_TECIDOS,
     "legal_name": "TÊXTIL E CONFECÇÕES OTIMOTEX LTDA", "trade_name": "OTIMOTEX TECIDOS"},
    {"sk_company": 2, "cnpj": CNPJ_LEBIANCO,
     "legal_name": "LEBIANCO PLÁSTICOS", "trade_name": "LEBIANCO"},
    {"sk_company": 3, "cnpj": "47273917000323",
     "legal_name": "OTIMOTEX IMPORTAÇÕES", "trade_name": "OTIMOTEX FARDOS"},
    {"sk_company": 4, "cnpj": CNPJ_LE_BLANC, "legal_name": LE_BLANC, "trade_name": "LE BLANC"},
]
OWN_NAMES = frozenset(R._company_legal_names_from_rows(COMPANY_ROWS))
BRAND = frozenset(R._company_brand_tokens_from_rows(COMPANY_ROWS))


class _Ctrl:
    """Ctrl mínimo sobre COMPANY_ROWS. A RPC emula a ORDEM real (CNPJ antes do nome) e os ÍMÃS
    por texto; registra tudo o que chegou até ela. `sem` lista métodos ausentes (ctrl legado)."""

    def __init__(self, sem=()):
        self._sem = frozenset(sem)
        self.payloads = []

    def __getattr__(self, name):
        if name in self.__dict__.get("_sem", ()):
            raise AttributeError(name)
        if name == "company_cnpjs":
            return lambda: [row["cnpj"] for row in COMPANY_ROWS]
        if name == "company_brand_tokens":
            return lambda: BRAND
        raise AttributeError(name)

    def company_cnpj(self):
        return CNPJ_TECIDOS

    def company_legal_names(self):
        return OWN_NAMES

    def find_supplier_by_email(self, email):
        return None

    def resolve_supplier(self, payload):
        self.payloads.append(dict(payload))
        cnpj = payload.get("supplier_cnpj")
        if cnpj == CNPJ_TECIDOS:          # passo de CNPJ vem ANTES do nome, como na RPC
            return R.OTIMOTEX_SK_SUPPLIER
        if cnpj == CNPJ_LE_BLANC:
            return SK_LE_BLANC_FORNECEDOR
        if R._normalize_company_name(payload.get("supplier_name")) == \
                R._normalize_company_name(GRAFIA_DA_GUIA):
            return SK_APELIDO
        return SK_OUTRO_FORNECEDOR if (payload.get("supplier_name") or cnpj) else None

    def supplier_defaults(self, sk_supplier):
        return (0, 0)


def _guia(**over):
    payload = {"document_type": "gnre", "amount": "40.46", "subject": "GUIA GNRE-LOJAS G",
               "sender_email": "rosangela@lebianco.com.br",
               "supplier_name": GRAFIA_DA_GUIA, "supplier_cnpj": CNPJ_TECIDOS,
               "payer_name": None, "payer_cnpj": "14395513002288"}
    payload.update(over)
    return payload


def _similaridade(nome):
    norm = R._normalize_company_name(nome)
    return max(SequenceMatcher(None, norm, own).ratio() for own in OWN_NAMES)


class ContribuinteGuiaTest(unittest.TestCase):

    def test_grafia_da_guia_com_cnpj_da_pagadora_vai_para_otimotex(self):
        ctrl = _Ctrl()
        payload = _guia()
        # Anti-vacuidade: a guarda de NOME exata não reconhece a grafia da guia.
        self.assertFalse(R._is_own_company_name(GRAFIA_DA_GUIA, OWN_NAMES))

        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))

        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [], "o nome do contribuinte nao pode chegar a RPC")
        for col in ("supplier_name", "supplier_cnpj", "supplier_cpf"):
            self.assertNotIn(col, payload)

    def test_filial_lebianco_como_contribuinte(self):
        ctrl = _Ctrl()
        payload = _guia(supplier_cnpj="47.273.917/0002-23", supplier_name="LEBIANCO PLASTICOS")
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [])

    def test_le_blanc_como_contribuinte_de_darf(self):
        ctrl = _Ctrl()
        payload = _guia(document_type="darf", supplier_cnpj=CNPJ_LE_BLANC,
                        supplier_name="LE BLANC ADM DE BENS", subject="PAGAMENTO DARF")
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [])

    def test_marca_com_ocr_deslocado_e_contribuinte_pela_similaridade(self):
        ctrl = _Ctrl()
        nome = "TEXTIL E CONFECCOES OTIMOTX LTDA"
        payload = _guia(supplier_name=nome)
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [])

    def test_nome_repetido_no_pagador_e_contribuinte(self):
        ctrl = _Ctrl()
        nome = "TXTL CONF OTMTX"
        # Anti-vacuidade: sem marca e abaixo do limiar — só o sinal do pagador o reconhece.
        self.assertFalse(BRAND & set(R._normalize_company_name(nome).split()))
        self.assertLess(_similaridade(nome), R.CONTRIBUINTE_NAME_SIMILARITY)
        payload = _guia(supplier_name=nome, payer_name=nome.lower())
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [])

    def test_ctrl_legado_sem_company_cnpjs_usa_a_principal(self):
        ctrl = _Ctrl(sem=("company_cnpjs",))
        self.assertFalse(hasattr(ctrl, "company_cnpjs"), "sanidade: o fake precisa ser legado")
        payload = _guia()
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [])

    def test_ctrl_sem_tokens_de_marca_degrada_para_similaridade(self):
        ctrl = _Ctrl(sem=("company_brand_tokens",))
        self.assertFalse(hasattr(ctrl, "company_brand_tokens"), "sanidade: fake sem marca")
        payload = _guia()
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)


class FavorecidoRealVenceTest(unittest.TestCase):

    def test_sefaz_com_cnpj_do_contribuinte_o_favorecido_vence(self):
        ctrl = _Ctrl()
        payload = _guia(supplier_name=SEFAZ_MG)

        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))

        self.assertEqual(payload["sk_supplier"], SK_OUTRO_FORNECEDOR)
        self.assertEqual(len(ctrl.payloads), 1, ctrl.payloads)
        self.assertEqual(ctrl.payloads[0]["supplier_name"], SEFAZ_MG)
        # 🔴 O CNPJ do contribuinte NÃO pode ir junto: no fake (como na RPC) ele casaria a
        # OTIMOTEX antes do nome e o favorecido perderia em silêncio.
        self.assertIsNone(ctrl.payloads[0].get("supplier_cnpj"))

    def test_prefeitura_com_cnpj_da_le_blanc_em_iss(self):
        ctrl = _Ctrl()
        payload = _guia(document_type="iss", supplier_cnpj=CNPJ_LE_BLANC,
                        supplier_name="PREFEITURA DO MUNICIPIO DE SAO PAULO", subject="ISS")
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], SK_OUTRO_FORNECEDOR)
        self.assertEqual(ctrl.payloads[0]["supplier_name"], "PREFEITURA DO MUNICIPIO DE SAO PAULO")
        self.assertIsNone(ctrl.payloads[0].get("supplier_cnpj"))

    def test_favorecidos_reais_medidos_nao_sao_contribuinte(self):
        # Nomes reais de favorecido de guia no cadastro (medição de 2026-09-15).
        for nome in (SEFAZ_MG, "Governo do Estado de São Paulo - SEFAZ",
                     "PREFEITURA DO MUNICIPIO DE SAO PAULO", "Receita Federal do Brasil",
                     "Tribunal de Justiça - Fundo Especial de Despesa - FEDTJ",
                     "JUNTA COMERCIAL DO ESTADO DE SAO PAULO", "DETRAN SP"):
            with self.subTest(nome=nome):
                self.assertFalse(R._is_contribuinte_name(nome, None, OWN_NAMES, BRAND))

    def test_nome_vazio_nao_e_contribuinte_nem_favorecido(self):
        self.assertFalse(R._is_contribuinte_name(None, None, OWN_NAMES, BRAND))
        self.assertFalse(R._is_contribuinte_name("  LTDA ", "  ltda", OWN_NAMES, BRAND))


class SinaisComplementaresTest(unittest.TestCase):
    """Trava com NÚMEROS por que os dois sinais existem — remover um deles perde um caso."""

    def test_marca_pega_o_que_a_similaridade_nao_pega(self):
        nome = "LE BLANC ADM DE BENS"
        self.assertLess(_similaridade(nome), R.CONTRIBUINTE_NAME_SIMILARITY)
        self.assertIn("blanc", BRAND & set(R._normalize_company_name(nome).split()))
        self.assertTrue(R._is_contribuinte_name(nome, None, OWN_NAMES, BRAND))

    def test_similaridade_pega_o_que_a_marca_nao_pega(self):
        nome = "TEXTIL E CONFECCOES OTIMOTX LTDA"
        self.assertFalse(BRAND & set(R._normalize_company_name(nome).split()))
        self.assertGreaterEqual(_similaridade(nome), R.CONTRIBUINTE_NAME_SIMILARITY)
        self.assertTrue(R._is_contribuinte_name(nome, None, OWN_NAMES, frozenset()))

    def test_limiar_fica_entre_os_grupos_medidos(self):
        # Fornecedor sem marca mais parecido com uma pagadora (0,703) abaixo; variante real do
        # contribuinte sem LTDA (1,0) e com grafia da guia (0,963) acima.
        self.assertLess(_similaridade("DEXINGLONG PLASTICS"), R.CONTRIBUINTE_NAME_SIMILARITY)
        self.assertGreaterEqual(_similaridade(GRAFIA_DA_GUIA), R.CONTRIBUINTE_NAME_SIMILARITY)


class MarcaDasPagadorasTest(unittest.TestCase):

    def test_tokens_saem_da_razao_social_e_do_fantasia_da_mesma_empresa(self):
        self.assertEqual(BRAND, frozenset({"otimotex", "lebianco", "blanc"}))

    def test_palavra_de_uma_coluna_so_e_linha_malformada_ficam_fora(self):
        rows = [{"legal_name": "OTIMOTEX TECIDOS FINOS LTDA", "trade_name": "TECIDOS"},
                {"legal_name": "LE BLANC", "trade_name": "LE BLANC"},
                {"legal_name": "2024 ALFA", "trade_name": "2024"}, None, "lixo"]
        self.assertEqual(R._company_brand_tokens_from_rows(rows), {"tecidos", "blanc"})

    def test_supabase_control_le_marca_na_mesma_leitura(self):
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl.base, ctrl.key, ctrl.headers, ctrl._available = "https://x", "k", {}, True
        resposta = mock.MagicMock()
        resposta.read.return_value = json.dumps(COMPANY_ROWS).encode()
        cm = mock.MagicMock()
        cm.__enter__.return_value = resposta
        with patch.object(R.urllib.request, "urlopen", return_value=cm) as m:
            marca = ctrl.company_brand_tokens()
            self.assertEqual(ctrl.company_legal_names(), OWN_NAMES)
            self.assertEqual(m.call_count, 1, "marca, razao social e CNPJ saem de UMA leitura")
            self.assertIn("trade_name", m.call_args.args[0].full_url)
        self.assertEqual(marca, BRAND)


class NaoRegredirTest(unittest.TestCase):

    def test_boleto_de_aluguel_da_le_blanc_segue_para_a_rpc(self):
        ctrl = _Ctrl()
        payload = {"document_type": "boleto", "amount": "15000.00", "subject": "ALUGUEL",
                   "supplier_name": "LE BLANC ADMINISTRADORA", "supplier_cnpj": CNPJ_LE_BLANC,
                   "sender_email": "financeiro@leblanc.com.br"}
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(payload["sk_supplier"], SK_LE_BLANC_FORNECEDOR)
        self.assertEqual(ctrl.payloads[0]["supplier_cnpj"], CNPJ_LE_BLANC)

    def test_guia_com_favorecido_com_cnpj_proprio_preserva(self):
        ctrl = _Ctrl()
        payload = _guia(document_type="iss", supplier_name="PREFEITURA DO MUNICIPIO DE SAO PAULO",
                        supplier_cnpj="46395000000139", subject="PAGAMENTO ISS")
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(ctrl.payloads[0]["supplier_name"], "PREFEITURA DO MUNICIPIO DE SAO PAULO")
        self.assertEqual(ctrl.payloads[0]["supplier_cnpj"], "46395000000139")

    def test_cnpj_incompleto_nao_dispara(self):
        ctrl = _Ctrl()
        payload = _guia(supplier_cnpj="47273917", supplier_name="TEXTIL E CONFECES OTIMOTEX LTDA",
                        document_type="iss")
        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(ctrl.payloads[0]["supplier_name"], GRAFIA_DA_GUIA,
                         "sem CNPJ de 14 digitos nao ha prova de que o bloco e o contribuinte")


class PayerCnpjRootsTest(unittest.TestCase):

    def test_raizes_de_todas_as_empresas_sem_lixo(self):
        class _Cnpjs:
            def company_cnpjs(self):
                return [CNPJ_TECIDOS, "47.273.917/0003-23", CNPJ_LE_BLANC, None, "123"]
        self.assertEqual(R._payer_cnpj_roots(_Cnpjs()), frozenset({"47273917", "20584679"}))

    def test_ctrl_sem_nenhum_metodo_devolve_vazio(self):
        self.assertEqual(R._payer_cnpj_roots(object()), frozenset())
        self.assertEqual(R._own_brand_tokens(object()), frozenset())


# ---------------------------------------------------------------------------
# Call site EXECUTADO — extract_and_store_accounts
# ---------------------------------------------------------------------------
class _PipelineCtrl(_Ctrl):

    def __init__(self):
        super().__init__()
        self.financial_calls = []
        self.error_calls = []
        self.classification_writebacks = []

    def upload_attachment(self, pdf_path):
        return True

    def register_financial(self, payload):
        self.financial_calls.append(dict(payload))
        return len(self.financial_calls)

    def register_attachment(self, account_id, file_name, size_bytes=0, uploaded_by=None):
        return True

    def resolve_user(self, sender_email):
        return None

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

    def unique_invoice_number(self, base):
        return base

    def find_financial_duplicate(self, payload):
        return None

    def classification_for_account_code(self, code):
        return (3, 33)

    def update_supplier_classification(self, sk_supplier, cost_center_id, chart_account_id):
        self.classification_writebacks.append(sk_supplier)
        return True

    def update_supplier_contact(self, *args, **kwargs):
        return True


def _executar(row, subject, sender):
    ctrl = _PipelineCtrl()

    def fake_run_extraction(pdf_path, pdf_passwords=None):
        return (pdf_path.name, None)

    with patch.object(R, "run_extraction", fake_run_extraction), \
         patch.object(R, "read_extracted_rows", return_value=[row]), \
         patch.object(R, "_attachment_text", return_value=""):
        R.extract_and_store_accounts(
            [Path(row["source_file"])], "<MID>", ctrl,
            email_rec={"received_at": "2026-09-08T12:48:00+00:00",
                       "subject": subject, "sender_email": sender},
            body_text="")
    return ctrl


def _linha_gnre(**over):
    # Linha como a extração real devolveu para a guia 1389 (reproduzida em 2026-09-15).
    row = {"source_file": "rosangela_GUIA_GNRE-LOJAS_G_20260908_GNRE_252552.pdf",
           "document_type": "gnre", "extraction_source": "pdf_text",
           "supplier_name": GRAFIA_DA_GUIA, "supplier_cnpj": CNPJ_TECIDOS,
           "payer_name": "", "payer_cnpj": "14395513002288",
           "invoice_number": "0000338390292563", "amount": "40.46",
           "due_date": "2026-09-10", "issue_date": "2026-09-08", "barcode": ""}
    row.update(over)
    return row


class CallSiteAnexoTest(unittest.TestCase):

    def test_gnre_1389_grava_na_otimotex_sem_writeback(self):
        ctrl = _executar(_linha_gnre(), "GUIA GNRE-LOJAS G", "rosangela@lebianco.com.br")
        self.assertEqual(len(ctrl.financial_calls), 1, ctrl.error_calls)
        self.assertEqual(ctrl.financial_calls[0]["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.payloads, [], "o apelido so seria alcancado pela RPC")
        self.assertEqual(ctrl.classification_writebacks, [],
                         "write-back de guia gravaria o plano tributario num cadastro-apelido")

    def test_gnre_com_favorecido_real_grava_no_favorecido(self):
        ctrl = _executar(_linha_gnre(supplier_name=SEFAZ_MG), "PAGAMENTO GNRE",
                         "marcio@lebianco.com.br")
        self.assertEqual(len(ctrl.financial_calls), 1, ctrl.error_calls)
        self.assertEqual(ctrl.financial_calls[0]["sk_supplier"], SK_OUTRO_FORNECEDOR)
        self.assertEqual(ctrl.payloads[0]["supplier_name"], SEFAZ_MG)
        self.assertIsNone(ctrl.payloads[0].get("supplier_cnpj"))


class LeBlancVenceComoEmpresaTest(unittest.TestCase):
    """🔴 LE BLANC VENCE como EMPRESA PAGADORA (sk_company 4), mesmo quando a regra do
    contribuinte descarta o nome/CNPJ dela do FORNECEDOR. O sinal é capturado ANTES de
    `_finalize_supplier` (`row_le_blanc`); se alguém mover a captura para depois, a guia da LE
    BLANC passa a ser lançada na TECIDOS em silêncio. Assunto e remetente NÃO citam a LE BLANC:
    o único sinal é o que a extração leu do documento."""

    def _guia_le_blanc(self, **over):
        return _linha_gnre(document_type="darf", supplier_cnpj=CNPJ_LE_BLANC,
                           supplier_name="LE BLANC ADM DE BENS", payer_cnpj="", **over)

    def test_contribuinte_le_blanc_fornecedor_otimotex_empresa_le_blanc(self):
        ctrl = _executar(self._guia_le_blanc(), "PAGAMENTO DARF", "fiscal@contabil.com.br")
        self.assertEqual(len(ctrl.financial_calls), 1, ctrl.error_calls)
        conta = ctrl.financial_calls[0]
        self.assertEqual(conta["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(conta["sk_company"], R.SK_COMPANY_LE_BLANC)

    def test_favorecido_real_com_cnpj_da_le_blanc_empresa_le_blanc(self):
        # Só o CNPJ cita a LE BLANC — e ele sai do payload no finalize. A empresa não pode sair.
        linha = self._guia_le_blanc()
        linha["supplier_name"] = "PREFEITURA DO MUNICIPIO DE SAO PAULO"
        self.assertFalse(R._has_le_blanc_reference(linha["supplier_name"]),
                         "anti-vacuidade: o nome nao pode carregar o sinal")
        ctrl = _executar(linha, "PAGAMENTO DARF", "fiscal@contabil.com.br")
        self.assertEqual(len(ctrl.financial_calls), 1, ctrl.error_calls)
        conta = ctrl.financial_calls[0]
        self.assertEqual(conta["sk_supplier"], SK_OUTRO_FORNECEDOR)
        self.assertEqual(conta["sk_company"], R.SK_COMPANY_LE_BLANC)

    def test_le_blanc_vence_o_remetente_lebianco(self):
        ctrl = _executar(self._guia_le_blanc(), "PAGAMENTO GNRE", "marcio@lebianco.com.br")
        self.assertEqual(ctrl.financial_calls[0]["sk_company"], R.SK_COMPANY_LE_BLANC)

    def test_sem_le_blanc_a_mesma_guia_nao_e_empresa_4(self):
        # Contraprova: com o CNPJ da TECIDOS, a empresa NÃO é a LE BLANC — o teste acima não
        # passa por um default qualquer.
        ctrl = _executar(_linha_gnre(document_type="darf", payer_cnpj=""), "PAGAMENTO DARF",
                         "fiscal@contabil.com.br")
        self.assertNotEqual(ctrl.financial_calls[0]["sk_company"], R.SK_COMPANY_LE_BLANC)


if __name__ == "__main__":
    unittest.main()
