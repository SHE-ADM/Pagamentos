"""
Numero CURTO de nota fiscal no corpo ("NF 57") vira invoice_number — e o sufixo de unicidade
consulta a FAMILIA exata do numero, nao o prefixo.

Caso de origem (conta 2396, e-mail 3391, TURBO DRIVE): "pagamento da NF 57 em anexo". O
`_BODY_INVOICE_RE` exigia 3+ digitos e a conta nasceu com o no SINTETICO 'pix_R$ 1.590,00'. A
varredura dos 1.992 corpos achou 9 contas assim (notas internas da LE BIANCO, NF 11..63) e so
2 falsos positivos de um regex frouxo, ambos no formato SERIE-NUMERO ("NFe 1 - 000137869").

Com numero curto, `unique_invoice_number` ficava exposto: `like base%` + limit=50 para a base
"11" devolvia 50 notas quaisquer iniciadas por "11", sem o "11" exato — numero ocupado
voltava como livre, sem erro.
"""

import io
import json
import sys
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

from test_body_pix_cpf_supplier import ELG, RDR, TURBO  # noqa: E402


def _invoice(text: str) -> "str | None":
    """Pela funcao que decide a PRECEDENCIA entre as fontes, nao pelo regex isolado."""
    return R._resolve_body_invoice_number(text, None)


# Aviso de NF-e autorizada (e-mails 161/1592): a SERIE vem rotulada ANTES do numero.
NFE_AUTORIZADA = ("Emitente INORGAN INDUSTRIA QUIMICA LTDA \n"
                  " Série da Nota Fiscal: 1 \n Número da Nota Fiscal: 1792\n \n ------")


class TestShortInvoiceRegex(unittest.TestCase):
    def test_sanidade_do_parser(self):
        self.assertIsNotNone(R._BODY_INVOICE_SHORT_RE.search("NF 57"))
        self.assertIsNotNone(R._BODY_SERIES_PREFIX_RE.search("Série da "))

    def test_serie_rotulada_nao_rouba_o_numero_longo(self):
        self.assertEqual(_invoice(NFE_AUTORIZADA), "1792")

    def test_serie_rotulada_sozinha_nao_e_numero(self):
        self.assertIsNone(_invoice("Série da Nota Fiscal: 1 \nSerie NF 2\n"))

    def test_curto_perde_para_qualquer_fonte_rotulada(self):
        self.assertEqual(_invoice("NF 57 em anexo.\nNúmero do documento: SOR2026599"),
                         "SOR2026599")
        self.assertEqual(_invoice("NF 57 e NF 2752"), "2752")

    def test_numero_curto_e_capturado(self):
        for text, esperado in (("pagamento da NF 57 em anexo.", "57"),
                               ("pagamento da NF 11.", "11"),
                               ("referente a nota fiscal 7\r\n", "7"),
                               ("NF 63", "63"),
                               # Fim de frase com data na linha de baixo NAO e serie-numero.
                               ("pagamento da NF 11.\r\n06/11/2026", "11")):
            with self.subTest(text=text):
                self.assertEqual(_invoice(text), esperado)

    def test_serie_numero_fracao_e_decimal_nao_sao_numero_curto(self):
        # Os 2 falsos positivos reais da varredura + fracao e decimal.
        for text in ("boleto referente a NFe 1 - 000137869",
                     "Envio da NF-e: 1-00002512 - emitida por",
                     "Nota Fiscal 1-00002512 emitida por",
                     "NF 1/2", "NF-e 4.0", "NF 5,00"):
            with self.subTest(text=text):
                self.assertIsNone(_invoice(text))

    def test_numero_longo_nao_muda(self):
        for text, esperado in (("pagamento da NF 2752 em anexo.", "2752"),
                               ("NF-e 000137869", "000137869"),
                               ("fatura nº 123-4", "123")):
            with self.subTest(text=text):
                self.assertEqual(_invoice(text), esperado)


class TestExtractFromEmailBodyShortInvoice(unittest.TestCase):
    """Executa a funcao de TOPO com os corpos reais dos e-mails 3390-3392."""

    def _invoice_of(self, body, msg_id):
        p = R.extract_from_email_body(body, "2026-11-06T12:25:06+00:00", msg_id,
                                      sender_email="estela@lebianco.com.br",
                                      subject="LE BIANCO - PAGAMENTO FORNECEDOR")
        self.assertIsNotNone(p)
        return p["invoice_number"]

    def test_nf_57_vira_invoice_number(self):
        self.assertEqual(self._invoice_of(TURBO, "<b@x>"), "57")

    def test_nf_longa_continua(self):
        self.assertEqual(self._invoice_of(RDR, "<a@x>"), "2752")

    def test_sem_nf_continua_sintetico(self):
        self.assertTrue(R._is_synthetic_invoice_number(self._invoice_of(ELG, "<c@x>")))


class TestUniqueInvoiceNumberFamily(unittest.TestCase):
    def setUp(self):
        self.ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        self.ctrl._available = True
        self.ctrl.base = "https://example.supabase.co"
        self.ctrl.headers = {}
        self.urls = []

    def _run(self, base, rows):
        def fake_urlopen(req, timeout=None):
            self.urls.append(req.full_url)
            return io.BytesIO(json.dumps([{"invoice_number": r} for r in rows]).encode())
        with mock.patch.object(R.urllib.request, "urlopen", side_effect=fake_urlopen):
            return self.ctrl.unique_invoice_number(base)

    def test_consulta_a_familia_exata_e_nao_o_prefixo(self):
        self._run("11", [])
        self.assertEqual(len(self.urls), 1, "sanidade: a consulta precisa ter sido feita")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.urls[0]).query)
        self.assertEqual(query["or"], ['(invoice_number.eq."11",invoice_number.like."11(*")'])
        self.assertNotIn("invoice_number", query, "prefixo like.base% voltou")

    def test_numero_ocupado_recebe_o_proximo_sufixo(self):
        self.assertEqual(self._run("11", ["11", "11(2)"]), "11(3)")

    def test_numero_livre_volta_sem_sufixo(self):
        self.assertEqual(self._run("57", ["57(2)"]), "57")

    def test_falha_de_rede_nao_bloqueia_a_gravacao(self):
        with mock.patch.object(R.urllib.request, "urlopen", side_effect=OSError("timeout")), \
                self.assertLogs(R.log, level="WARNING"):
            self.assertEqual(self.ctrl.unique_invoice_number("11"), "11")

    def test_aspas_protegem_virgula_e_ponto_do_sintetico(self):
        self.assertEqual(R._invoice_family_filter('pix_R$ 1.590,00'),
                         '(invoice_number.eq."pix_R$ 1.590,00",'
                         'invoice_number.like."pix_R$ 1.590,00(*")')
        self.assertEqual(R._pgrst_quote('a"b\\c'), '"a\\"b\\\\c"')


if __name__ == "__main__":
    unittest.main()
