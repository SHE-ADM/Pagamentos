"""Guardas do backfill de corpo-placeholder (scripts/backfill_placeholder_bodies.py).

O script mexe na caixa postal e regrava colunas de `email_control`. As garantias que ele
promete no cabecalho sao verificadas AQUI — inclusive as negativas ("nunca grava conta",
"nunca marca \\Seen"), que sao lidas sobre o CODIGO com `_sem_prosa`: o proprio arquivo
explica em prosa o que nao deve fazer, entao uma busca textual crua casaria a advertencia
e ficaria verde para sempre (licao de 2026-08-03, ja registrada no CLAUDE.md).
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "scripts"))
sys.path.insert(0, str(RAIZ / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fiscal_document_consistency import _sem_prosa  # noqa: E402

import backfill_placeholder_bodies as B  # noqa: E402

FONTE = (RAIZ / "scripts" / "backfill_placeholder_bodies.py").read_text(encoding="utf-8")
CODIGO = _sem_prosa(FONTE)


class SanidadeDaLenteTest(unittest.TestCase):
    """Se `_sem_prosa` devolvesse vazio, todas as guardas abaixo passariam sem ver nada."""

    def test_a_lente_preserva_o_codigo(self):
        # Ancoras ESTAVEIS e independentes dos invariantes testados abaixo: se a sanidade
        # dependesse deles, quebraria junto e deixaria de distinguir "parser quebrou" de
        # "regra violada" — que e exatamente o que ela existe para separar.
        self.assertIn("def gravar", CODIGO)
        self.assertIn("def main", CODIGO)
        self.assertIn("rest_write", CODIGO)
        self.assertGreater(len(CODIGO), 1500)


class InvariantesEstruturaisTest(unittest.TestCase):
    def test_nunca_toca_em_conta(self):
        # O script so pode escrever em email_control. A tabela de contas nao aparece no
        # codigo — so na prosa que explica a regra.
        self.assertNotIn("financial_account_control", CODIGO)
        self.assertIn("email_control", CODIGO)

    def test_abre_a_caixa_em_modo_leitura(self):
        # EXAMINE: no modo readonly o servidor NAO PODE gravar flag permanente. E a
        # garantia estrutural de que o backfill nao marca e-mail como lido.
        self.assertIn("readonly=True", CODIGO)

    def test_todo_fetch_usa_peek(self):
        # BODY[] sem PEEK marca \\Seen no servidor. Nao pode haver nenhum.
        self.assertNotIn("BODY[", CODIGO.replace("BODY.PEEK[", ""))
        self.assertIn("BODY.PEEK[", CODIGO)

    def test_nao_reimplementa_a_deteccao(self):
        # A regra vive no reader; duplicar aqui criaria 2a fonte de verdade.
        self.assertIn("_plain_body_is_placeholder", CODIGO)
        self.assertIn("_html_to_text", CODIGO)
        self.assertIn("_body_full_for_storage", CODIGO)


class PatchCondicionalTest(unittest.TestCase):
    """O filtro do placeholder vai NA URL — atomico no servidor, imune a corrida com o
    reader agendado (que roda a cada 5 min e pode corrigir a linha nesse meio tempo)."""

    def test_url_do_patch_carrega_o_filtro_e_o_id(self):
        capturado = {}

        def falso_rest_write(base, headers, path, payload, method="POST", prefer=""):
            capturado.update(path=path, payload=payload, method=method)
            return True, ""

        with mock.patch.object(B, "rest_write", falso_rest_write):
            B.gravar("https://x", {}, 1196, "corpo real da fatura")

        self.assertEqual(capturado["method"], "PATCH")
        self.assertIn("id=eq.1196", capturado["path"])
        self.assertIn("body_full=ilike.", capturado["path"],
                      "sem o filtro na URL o PATCH sobrescreveria corpo ja corrigido")
        # Escreve as duas colunas do corpo, e SO elas.
        self.assertEqual(set(capturado["payload"]), {"body_full", "body_preview"})

    def test_preview_continua_truncado(self):
        # body_preview e o que a tela /emails mostra; body_full e o conteudo. Papeis
        # distintos — nao unificar.
        capturado = {}

        def falso_rest_write(base, headers, path, payload, method="POST", prefer=""):
            capturado.update(payload=payload)
            return True, ""

        with mock.patch.object(B, "rest_write", falso_rest_write):
            B.gravar("https://x", {}, 1, "L" * 5000)

        self.assertEqual(len(capturado["payload"]["body_preview"]), B.PREVIEW_MAX)
        self.assertGreater(len(capturado["payload"]["body_full"]), B.PREVIEW_MAX)


class SelecaoDeCandidatosTest(unittest.TestCase):
    def test_so_entra_quem_tem_corpo_placeholder_e_message_id(self):
        linhas = [
            {"id": 1, "message_id": "<a>", "body_full": "O conteudo deste e-mail esta somente disponivel em HTML"},
            {"id": 2, "message_id": "<b>", "body_full": "FORNECEDOR X\n\nVALOR R$ 10,00"},   # corpo real
            {"id": 3, "message_id": None,  "body_full": "esta disponivel em HTML"},          # sem message_id
            {"id": 4, "message_id": "<d>", "body_full": None},                               # sem corpo
        ]
        with mock.patch.object(B, "rest_get", lambda *a, **k: linhas):
            achados = B.candidatos("https://x", {})
        self.assertEqual([r["id"] for r in achados], [1])


class HtmlVazioPreservaTest(unittest.TestCase):
    """Sem HTML aproveitavel, sobrescrever deixaria o registro PIOR — sem nem o aviso."""

    def test_corpo_vazio_nao_e_gravado(self):
        # O laco de main() so chama gravar() quando ha corpo; aqui travamos a condicao no
        # codigo, que e o que impede a regressao.
        self.assertIn("if not corpo:", CODIGO)


if __name__ == "__main__":
    unittest.main()
