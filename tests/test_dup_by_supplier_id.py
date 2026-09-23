"""
Dedup de conteúdo por sk_supplier (migrations 040/041/042).

Desde que financial_account_control deixou de guardar nome/CNPJ do fornecedor
(só a FK sk_supplier, surrogate key snowflake), a resolução do fornecedor acontece
ANTES da dedup (_finalize_supplier → RPC resolve_supplier_for_account, que devolve o
sk_supplier) e find_financial_duplicate casa por sk_supplier. Sem sk_supplier
resolvido, não deduplica.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402


class _Resp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()
    def read(self):
        return self._b
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def _ctrl():
    c = R.SupabaseControl.__new__(R.SupabaseControl)  # sem __init__/env
    c._available = True
    c.base = "https://proj.supabase.co"
    c.headers = {"apikey": "k", "Authorization": "Bearer k", "Content-Type": "application/json"}
    return c


class FindDuplicateBySkSupplierTest(unittest.TestCase):
    def test_casa_por_sk_supplier_na_tabela(self):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.find_financial_duplicate({
                "sk_supplier": 154, "amount": 34300.0,
                "due_date": "2026-06-17", "document_type": "fatura", "invoice_number": "1087",
            })

        # Consulta a tabela filtrando por sk_supplier, sem nenhuma RPC.
        self.assertTrue(any("/rest/v1/financial_account_control" in u for u in urls))
        self.assertTrue(any("sk_supplier=eq.154" in u for u in urls))
        self.assertFalse(any("/rpc/" in u for u in urls))

    def test_sem_sk_supplier_nao_deduplica(self):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate({
                "amount": 34300.0, "due_date": "2026-06-17", "document_type": "fatura",
            })

        self.assertIsNone(dup)
        # Sem barcode e sem sk_supplier → nenhuma consulta de fornecedor.
        self.assertFalse(any("sk_supplier=eq" in u for u in urls))

    def test_barcode_tem_precedencia(self):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([{"id": 9, "due_date": "2026-06-17", "barcode": "X"}])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            dup = ctrl.find_financial_duplicate({
                "barcode": "00190000090123", "sk_supplier": 154, "amount": 10.0,
            })

        self.assertEqual(dup["id"], 9)
        self.assertIn("barcode=eq.", urls[0])


class BarcodeDescartadoNaImpressao3Test(unittest.TestCase):
    """🔴 Boleto cujo código foi DESCARTADO não pode ser fundido com o irmão pela impressão 3.

    A 3ª impressão (fornecedor + valor + vencimento) não tem veto por nosso número e, para o
    documento SEM barcode, casa qualquer conta da mesma dívida — premissa escrita no próprio
    código: "o documento sem linha digitável nunca é um 2º pagável legítimo". Descartar o
    código de um boleto REAL (OCR corrompeu a conversão da linha digitável) quebrava essa
    premissa: o boleto virava "documento sem linha digitável" e sumia contra a parcela irmã de
    mesmo valor e vencimento — sem erro e sem `/erros`. Grupo real: sk 1262, R$ 227,85,
    contas 648/649/650/652, 3 delas com DV refutado (R$ 683,55).
    """

    def _urls_da_impressao3(self, payload):
        ctrl = _ctrl()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return _Resp([])

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ctrl.find_financial_duplicate(payload)
        return [u for u in urls if "due_date=eq." in u]

    def test_codigo_descartado_so_casa_candidato_SEM_barcode(self):
        urls = self._urls_da_impressao3({
            "sk_supplier": 1262, "amount": 227.85, "due_date": "2026-07-20",
            "processing_notes": "Código de barras descartado — DV não confere na leitura visual",
        })
        self.assertTrue(urls, "a impressão 3 não chegou a ser consultada")
        self.assertIn("barcode=is.null", urls[-1])

    def test_sem_marca_a_impressao_3_segue_ampla(self):
        # Anti-regressão: conta do CORPO/notificação (nunca teve código) continua casando
        # qualquer conta da mesma dívida — é o que fecha o gap cross-e-mail (ids 7/176).
        urls = self._urls_da_impressao3({
            "sk_supplier": 1262, "amount": 227.85, "due_date": "2026-07-20",
            "processing_notes": "Vencimento presumido",
        })
        self.assertTrue(urls)
        self.assertNotIn("barcode=is.null", urls[-1])


_DESCARTE = "Código de barras descartado — DV não confere na leitura visual"


def _tabela(rows):
    """PostgREST simulado: aplica `eq.`/`is.null` sobre as linhas e devolve a 1ª que casa.

    🔴 Uma fake que devolve `[]` sempre só prova qual URL foi montada — nunca que o irmão
    GRAVADO deixa de ser casado. Era o que o teste acima fazia sozinho, e o furo dos irmãos
    ambos descartados passou por ele."""
    def _casa(row, clausula):
        col, op = clausula.split("=", 1)
        if op == "is.null":
            return row.get(col) in (None, "")
        valor = R.urllib.parse.unquote(op[3:])
        if col == "amount":
            return row.get(col) is not None and f"{float(row[col]):.2f}" == valor
        return str(row.get(col)) == valor

    def fake_urlopen(req, timeout=None):
        query = R.urllib.parse.urlsplit(req.full_url).query
        clausulas = [c for c in query.split("&") if not c.startswith(("select=", "limit="))]
        return _Resp([r for r in rows if all(_casa(r, c) for c in clausulas)][:1])

    return mock.patch.object(R.urllib.request, "urlopen", fake_urlopen)


class IrmaosDescartadosNaImpressao3Test(unittest.TestCase):
    """🔴 Irmão JÁ GRAVADO com código descartado não absorve o boleto seguinte do lote.

    Caso real: contas 1582/1583/1584 (RAINHA MARIA, R$ 29.949,43, venc. 2026-09-25) vieram do
    MESMO e-mail, 100% `pdf_vision`, com nossos números distintos. Barcode nulo não separa um
    irmão descartado de outro: o 2º não era gravado, e um 2º de código ÍNTEGRO gravava o
    próprio código na conta do 1º."""

    GRAVADA = {"id": 1582, "sk_supplier": 936, "amount": 29949.43, "due_date": "2026-09-25",
               "barcode": None, "nosso_numero": "00035803290000004201",
               "invoice_number": "NF16713-7", "processing_notes": _DESCARTE}

    def _novo(self, **over):
        base = {"sk_supplier": 936, "amount": 29949.43, "due_date": "2026-09-25",
                "barcode": None, "nosso_numero": "00035803290000004202",
                "invoice_number": "NF16942-7", "processing_notes": _DESCARTE}
        base.update(over)
        return base

    def test_irmao_descartado_com_titulo_distinto_nao_e_duplicata(self):
        with _tabela([self.GRAVADA]):
            self.assertIsNone(_ctrl().find_financial_duplicate(self._novo()))

    def test_irmao_com_codigo_INTEGRO_nao_e_duplicata(self):
        with _tabela([self.GRAVADA]):
            self.assertIsNone(_ctrl().find_financial_duplicate(self._novo(
                barcode="00198157200029949430000003580329000000420217",
                processing_notes=None)))

    def test_mesmo_titulo_descartado_de_novo_ainda_deduplica(self):
        # Anti-regressão do lado oposto: a 2ª via do MESMO título (mesmo nosso número e Nº),
        # lida por Vision com o código descartado outra vez, não vira conta duplicada.
        with _tabela([self.GRAVADA]):
            m = _ctrl().find_financial_duplicate(self._novo(
                nosso_numero=self.GRAVADA["nosso_numero"],
                invoice_number=self.GRAVADA["invoice_number"]))
        self.assertEqual(m["id"], 1582)

    def test_conta_do_corpo_sem_marca_ainda_e_casada_pelo_boleto(self):
        # Premissa original da impressão 3 intacta: o candidato sem barcode e SEM a marca é a
        # conta do corpo/notificação da mesma dívida (ids 7/176).
        corpo = dict(self.GRAVADA, processing_notes="Vencimento presumido", nosso_numero=None,
                     invoice_number=None)
        with _tabela([corpo]):
            m = _ctrl().find_financial_duplicate(self._novo(processing_notes=None,
                                                            barcode="0019" + "1" * 40))
        self.assertEqual(m["id"], 1582)


class FinalizeSupplierTest(unittest.TestCase):
    def test_resolve_seta_sk_supplier_e_remove_colunas(self):
        ctrl = _ctrl()

        def fake_urlopen(req, timeout=None):
            # RPC resolve_supplier_for_account → bigint escalar (sk_supplier)
            return _Resp(154)

        payload = {
            "supplier_name": "CIPATEX", "supplier_cnpj": "47254461002289",
            "supplier_cpf": None, "sender_email": "fin@cipatex.com.br", "amount": 10.0,
        }
        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            ok = R._finalize_supplier(ctrl, payload)

        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], 154)
        # As 3 colunas denormalizadas saem do payload.
        for col in ("supplier_name", "supplier_cnpj", "supplier_cpf"):
            self.assertNotIn(col, payload)

    def test_falha_de_resolucao_retorna_false_e_remove_colunas(self):
        ctrl = _ctrl()

        def boom(req, timeout=None):
            raise OSError("rede caiu")

        payload = {"supplier_name": "X", "supplier_cnpj": None, "supplier_cpf": None}
        with mock.patch.object(R.urllib.request, "urlopen", boom):
            ok = R._finalize_supplier(ctrl, payload)

        self.assertFalse(ok)
        self.assertNotIn("sk_supplier", payload)
        self.assertNotIn("supplier_name", payload)

    def test_injeta_classificacao_default_do_fornecedor(self):
        """Migration 052: a nova conta herda cost_center_id/chart_account_id do
        fornecedor resolvido quando > 0."""
        ctrl = _ctrl()

        def fake(req, timeout=None):
            url = req.full_url
            if "/rpc/resolve_supplier_for_account" in url:
                return _Resp(154)  # RPC → sk_supplier
            if "/rest/v1/supplier?" in url:
                return _Resp([{"cost_center_id": 5, "chart_account_id": 10}])
            return _Resp([])

        payload = {"supplier_name": "X", "supplier_cnpj": None, "supplier_cpf": None, "amount": 10.0}
        with mock.patch.object(R.urllib.request, "urlopen", fake):
            ok = R._finalize_supplier(ctrl, payload)

        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], 154)
        self.assertEqual(payload["cost_center_id"], 5)
        self.assertEqual(payload["chart_account_id"], 10)

    def test_classificacao_zero_nao_injeta(self):
        """Sentinela 0 (não informado) não entra no payload — o NOT NULL DEFAULT 0
        do banco assume; nunca enviamos None (violaria o NOT NULL)."""
        ctrl = _ctrl()

        def fake(req, timeout=None):
            url = req.full_url
            if "/rpc/resolve_supplier_for_account" in url:
                return _Resp(200)
            if "/rest/v1/supplier?" in url:
                return _Resp([{"cost_center_id": 0, "chart_account_id": 0}])
            return _Resp([])

        payload = {"supplier_name": "Y", "supplier_cnpj": None, "supplier_cpf": None}
        with mock.patch.object(R.urllib.request, "urlopen", fake):
            ok = R._finalize_supplier(ctrl, payload)

        self.assertTrue(ok)
        self.assertEqual(payload["sk_supplier"], 200)
        self.assertNotIn("cost_center_id", payload)
        self.assertNotIn("chart_account_id", payload)


if __name__ == "__main__":
    unittest.main()
