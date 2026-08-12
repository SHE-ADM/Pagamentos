"""Backfill de conteudo do CT-e — o FLUXO DE DECISAO, com a rede toda mockada.

O parser em si esta coberto por `test_cte_content.py`. O que se prova aqui e o que o script
decide DEPOIS de ter os itens em maos, e que nao aparece em teste de parser nenhum:

  - `--dry-run` nao grava (o operador confia nisso antes de rodar de verdade);
  - conteudo vindo de OUTRA fonte e preservado, nao rebaixado por esta passada;
  - chave que ainda nao esta na tabela e CONTADA e reportada, nunca inserida pela porta dos
    fundos — inserir aqui criaria documento fiscal sem passar pela validacao de 5 camadas;
  - fatura cujo SUB-TOTAL nao fecha nao grava nada (fail-closed herdado do parser);
  - falha de gravacao vira exit != 0, para a operacao nao ler "terminou" como "deu certo".

Nada aqui toca rede: `rest_get`, `rest_write`, download e pdfplumber sao substituidos. O teste
que exercita PDF de verdade e o de parser; misturar os dois faria esta suite depender do bucket.
"""

import importlib.util
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(RAIZ / "scripts"))

# Importado por caminho e com nome PROPRIO: varios scripts do projeto se chamam parecido, e
# `import backfill...` por sys.path ja colidiu em `sys.modules` antes (lição do run.py das skills).
_spec = importlib.util.spec_from_file_location(
    "backfill_cte_content_para_teste", RAIZ / "scripts" / "backfill_cte_content.py")
B = importlib.util.module_from_spec(_spec)

CHAVE_A = "35260748740351011442570000057093781966739743"
CHAVE_B = "35260748740351011442570000057122101176557511"

ITEM_A = {
    "access_key": CHAVE_A, "awb": "005709378", "origin": "CCT", "destination": "RIO",
    "service_date": __import__("datetime").date(2026, 7, 14),
    "cargo_weight_kg": Decimal("96.00"), "cargo_amount": Decimal("24156.61"),
    "freight_amount": Decimal("652.60"), "linked_invoice": "248632",
    "receiver_name": "HANDRED STUDIO COMERCIO LTDA",
}
ITEM_B = {**ITEM_A, "access_key": CHAVE_B, "awb": "005712210",
          "freight_amount": Decimal("148.70"), "linked_invoice": None}


def _carrega():
    with mock.patch.dict("os.environ", {"SUPABASE_URL": "https://x.supabase.co",
                                        "SUPABASE_SERVICE_KEY": "chave-de-teste"}):
        _spec.loader.exec_module(B)


_carrega()


class PayloadTest(unittest.TestCase):
    """Decimal e date nao sao serializaveis em JSON — e float perderia precisao de centavo."""

    def test_decimal_vira_string_nao_float(self):
        p = B._payload(ITEM_A)
        self.assertEqual(p["freight_amount"], "652.60")
        self.assertIsInstance(p["freight_amount"], str)
        self.assertNotIsInstance(p["freight_amount"], float)

    def test_data_vira_iso(self):
        self.assertEqual(B._payload(ITEM_A)["service_date"], "2026-07-14")

    def test_declara_a_procedencia(self):
        self.assertEqual(B._payload(ITEM_A)["content_source"], "braspress_invoice")

    def test_nota_diversas_permanece_nula(self):
        """None significa 'varias notas' — virar string inventaria uma NF."""
        self.assertIsNone(B._payload(ITEM_B)["linked_invoice"])


class FluxoTest(unittest.TestCase):
    """`main()` com a rede inteira substituida."""

    def _roda(self, argv, docs, itens, write_ok=True):
        self.escritas: list = []

        def _write(base, headers, path, payload, method="POST", prefer=""):
            self.escritas.append((path, payload, method))
            return (write_ok, None if write_ok else "HTTP 500")

        with mock.patch.dict("os.environ", {"SUPABASE_URL": "https://x.supabase.co",
                                            "SUPABASE_SERVICE_KEY": "k"}), \
             mock.patch.object(sys, "argv", ["backfill_cte_content.py", *argv]), \
             mock.patch.object(B, "rest_get", return_value=docs), \
             mock.patch.object(B, "_download", return_value=b"%PDF-falso"), \
             mock.patch.object(B, "_pdf_text", return_value="texto irrelevante"), \
             mock.patch.object(B.cte_content, "is_braspress_invoice", return_value=True), \
             mock.patch.object(B.cte_content, "parse_braspress_invoice", return_value=itens), \
             mock.patch.object(B, "rest_write", side_effect=_write):
            return B.main()

    DOCS = [
        {"id": 1, "access_key": CHAVE_A, "storage_key": "fat.pdf", "model": 57,
         "content_source": None},
        {"id": 2, "access_key": CHAVE_B, "storage_key": "fat.pdf", "model": 57,
         "content_source": None},
    ]

    def test_grava_um_patch_por_conhecimento(self):
        rc = self._roda([], self.DOCS, [ITEM_A, ITEM_B])
        self.assertEqual(rc, 0)
        self.assertEqual(len(self.escritas), 2)
        caminho, payload, metodo = self.escritas[0]
        self.assertEqual(metodo, "PATCH")
        self.assertIn(f"access_key=eq.{CHAVE_A}", caminho)
        self.assertEqual(payload["origin"], "CCT")

    def test_dry_run_nao_grava(self):
        rc = self._roda(["--dry-run"], self.DOCS, [ITEM_A, ITEM_B])
        self.assertEqual(rc, 0)
        self.assertEqual(self.escritas, [])

    def test_nao_sobrescreve_conteudo_de_outra_fonte(self):
        """Passada deterministica nao pode rebaixar dado mais rico vindo de LLM."""
        docs = [{**self.DOCS[0], "content_source": "dacte_llm"}, self.DOCS[1]]
        rc = self._roda([], docs, [ITEM_A, ITEM_B])
        self.assertEqual(rc, 0)
        self.assertEqual(len(self.escritas), 1)
        self.assertIn(CHAVE_B, self.escritas[0][0])

    def test_chave_sem_registro_nao_vira_insert(self):
        """So o backfill de CHAVES cria documento — aqui, ausente e ausente."""
        rc = self._roda([], [self.DOCS[0]], [ITEM_A, ITEM_B])
        self.assertEqual(rc, 0)
        self.assertEqual(len(self.escritas), 1)
        self.assertTrue(all(m == "PATCH" for _, _, m in self.escritas))

    def test_fatura_que_nao_fecha_nao_grava_nada(self):
        """Fail-closed: o parser devolve [] e o script nao inventa gravacao parcial."""
        rc = self._roda([], self.DOCS, [])
        self.assertEqual(rc, 0)
        self.assertEqual(self.escritas, [])

    def test_falha_de_gravacao_devolve_exit_diferente_de_zero(self):
        """Terminar nao pode ser lido como ter dado certo."""
        rc = self._roda([], self.DOCS, [ITEM_A], write_ok=False)
        self.assertEqual(rc, 1)

    def test_limit_reduz_os_pdfs_varridos(self):
        # Os tres PDFs carregam a MESMA chave de proposito: assim a diferenca observada vem do
        # `--limit` (quantos PDFs foram abertos), nao de a chave casar ou nao o registro.
        docs = [{**self.DOCS[0], "storage_key": f"f{i}.pdf"} for i in range(3)]

        self._roda([], docs, [ITEM_A])
        self.assertEqual(len(self.escritas), 3, "sanidade: sem limite, os 3 PDFs sao varridos")

        self._roda(["--limit", "1"], docs, [ITEM_A])
        self.assertEqual(len(self.escritas), 1)


class DownloadTest(unittest.TestCase):
    """O caminho RUIM do I/O — que só roda quando algo já deu errado, e por isso quase nunca
    aparece em teste. É a categoria que a regra de execução do projeto manda sondar de propósito.
    """

    def _req(self, corpo=b"%PDF-1.4"):
        cm = mock.MagicMock()
        cm.__enter__.return_value.read.return_value = corpo
        return cm

    def test_baixa_e_devolve_os_bytes(self):
        with mock.patch.object(B.urllib.request, "urlopen", return_value=self._req()):
            self.assertEqual(B._download("https://x", {"Authorization": "a", "apikey": "k"},
                                         "obj.pdf"), b"%PDF-1.4")

    def test_http_error_nao_repete(self):
        """4xx não melhora com retry — insistir só multiplica a espera."""
        erro = B.urllib.error.HTTPError("u", 404, "nf", None, None)
        with mock.patch.object(B.urllib.request, "urlopen", side_effect=erro) as u:
            self.assertIsNone(B._download("https://x", {"Authorization": "a", "apikey": "k"},
                                          "obj.pdf"))
            self.assertEqual(u.call_count, 1)

    def test_falha_de_rede_repete_ate_o_teto_e_desiste(self):
        with mock.patch.object(B.urllib.request, "urlopen", side_effect=TimeoutError("t")) as u, \
             mock.patch("time.sleep"):          # não penalizar a suíte com o backoff real
            self.assertIsNone(B._download("https://x", {"Authorization": "a", "apikey": "k"},
                                          "obj.pdf"))
            self.assertEqual(u.call_count, B.DOWNLOAD_ATTEMPTS)

    def test_rede_instavel_ainda_assim_entrega(self):
        """Uma falha transitória seguida de sucesso não pode virar 'PDF indisponível'."""
        with mock.patch.object(B.urllib.request, "urlopen",
                               side_effect=[TimeoutError("t"), self._req(b"%PDF-ok")]), \
             mock.patch("time.sleep"):
            self.assertEqual(B._download("https://x", {"Authorization": "a", "apikey": "k"},
                                         "obj.pdf"), b"%PDF-ok")


class PdfTextTest(unittest.TestCase):
    def test_pdf_ilegivel_devolve_vazio_e_nao_levanta(self):
        """PDF cifrado/corrompido é RESULTADO do backfill, não bug — mas tem de ir ao log."""
        with mock.patch.dict(sys.modules, {"pdfplumber": mock.MagicMock(
                open=mock.MagicMock(side_effect=ValueError("cifrado")))}), \
             self.assertLogs(B.log, level="ERROR") as cap:
            self.assertEqual(B._pdf_text(b"lixo", "x.pdf"), "")
        self.assertTrue(any("pdfplumber" in m for m in cap.output))


class LeituraFalhaTest(unittest.TestCase):
    def test_erro_ao_ler_a_tabela_devolve_exit_1(self):
        with mock.patch.dict("os.environ", {"SUPABASE_URL": "https://x.supabase.co",
                                            "SUPABASE_SERVICE_KEY": "k"}), \
             mock.patch.object(sys, "argv", ["backfill_cte_content.py"]), \
             mock.patch.object(B, "rest_get", side_effect=B.RestError("500")):
            self.assertEqual(B.main(), 1)

    def test_download_que_falha_nao_derruba_a_varredura(self):
        with mock.patch.dict("os.environ", {"SUPABASE_URL": "https://x.supabase.co",
                                            "SUPABASE_SERVICE_KEY": "k"}), \
             mock.patch.object(sys, "argv", ["backfill_cte_content.py"]), \
             mock.patch.object(B, "rest_get", return_value=FluxoTest.DOCS), \
             mock.patch.object(B, "_download", return_value=None):
            self.assertEqual(B.main(), 0)


if __name__ == "__main__":
    unittest.main()
